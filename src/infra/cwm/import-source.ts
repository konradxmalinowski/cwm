import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  analyzeContent,
  convertNativeSettings,
  normalizeResourceName,
  splitFrontmatter,
  type ContentKind,
} from '../../core/cwm';
import { isPathInside } from '../../core/model/path-containment';
import { classifyFileName, classifyStrict } from '../../core/services/security/secret-classifier';
import { readBounded } from '../fs/bounded-read';
import { lstatOrNull } from '../fs/stat';
import { errnoCode } from '../fs/store-error';
import { pinHookCommands, describeUnpinned } from './hook-pins';
import {
  IMPORT_LIMITS,
  type Candidate,
  type ImportKind,
  type ReportItem,
  type ScanOutcome,
  type SourceFile,
} from './import-types';
import { isProtectedName, realpathLoose } from './paths';
import { readDirLimited } from './read';
import { toYaml } from './serialize';
import { parseManifestYaml } from './yaml-manifest';

/**
 * Odczyt natywnej konfiguracji Claude Code (tylko odczyt, IMP-02): wylacznie `skills/*`, `agents/*.md`,
 * `commands/*.md` i `settings.json` z listy dozwolonej. Zadne inne sciezki z `--from` nie sa
 * otwierane (`.credentials.json`, `projects/`, `history.jsonl`, `settings.local.json`, `skills/synced/`
 * i reszta). Modul niczego nie wykonuje i nie zapisuje (IMP-12, regula lintu).
 */

const ALWAYS_SKIPPED_NAMES = new Set(['.git', 'node_modules']);
/** Pliki, ktore CWM tworzy w katalogu zasobu: kopia o tej nazwie by je nadpisala. */
const RESERVED_RESOURCE_FILES = new Set([
  'skill.yaml',
  'agent.yaml',
  'command.yaml',
  'settings.yaml',
  'agent.md',
  'command.md',
]);
const SOURCE_FILE: Record<Exclude<ImportKind, 'settings'>, string> = {
  skill: 'SKILL.md',
  agent: 'AGENT.md',
  command: 'COMMAND.md',
};
const NO_FLAGS = { allowedTools: false, inlineCommands: false } as const;

class Budget {
  files = 0;
  bytes = 0;
  dirs = 0;
  exceeded: string | null = null;

  enterDir(): void {
    this.dirs += 1;
    if (this.dirs > IMPORT_LIMITS.importDirs) {
      this.exceeded = `Import przekracza limit ${IMPORT_LIMITS.importDirs} przegladanych katalogow.`;
    }
  }

  take(size: number): void {
    this.files += 1;
    this.bytes += size;
    if (this.files > IMPORT_LIMITS.importFiles) {
      this.exceeded = `Import przekracza limit ${IMPORT_LIMITS.importFiles} plikow.`;
    } else if (this.bytes > IMPORT_LIMITS.importBytes) {
      this.exceeded = `Import przekracza limit ${IMPORT_LIMITS.importBytes / (1024 * 1024)} MiB tresci.`;
    }
  }
}

const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function listOrNull(dir: string) {
  try {
    return await readDirLimited(dir);
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function describeProblems(errors: readonly { path: string; message: string }[]): string {
  return errors
    .slice(0, 3)
    .map((e) => `${e.path}: ${e.message}`)
    .join(' ');
}

interface ParsedContent {
  readonly ok: true;
  readonly flags: Candidate['flags'];
  readonly tools: readonly string[];
  readonly model: string | null;
  readonly unknownKeys: readonly string[];
  /** Bajty do zapisu: frontmatter odtworzony z dozwolonych kluczy, tresc bez zmian (IMP-05 pkt 1). */
  readonly content: Uint8Array;
}

/** Frontmatter wg IMP-04: poczatek pliku, BOM, limit 64 KiB, te same opcje YAML co manifesty. */
function parseContent(
  kind: ContentKind,
  bytes: Uint8Array,
): ParsedContent | { readonly ok: false; readonly reason: string } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'plik nie jest poprawnym UTF-8' };
  }
  const split = splitFrontmatter(text);
  if (!split.ok) return { ok: false, reason: split.message };
  let frontmatter: unknown = null;
  if (split.frontmatter !== null) {
    const parsed = parseManifestYaml(split.frontmatter);
    if (!parsed.ok) {
      const first = parsed.errors[0];
      return {
        ok: false,
        reason: `frontmatter YAML jest niepoprawny${first ? ` (wiersz ${first.line + 1})` : ''}`,
      };
    }
    frontmatter = parsed.value;
  }
  const analysis = analyzeContent(kind, frontmatter, text);
  if (!analysis.ok) return { ok: false, reason: describeProblems(analysis.errors) };
  const { flags, tools, model, unknownKeys, kept } = analysis.value;
  let content = bytes;
  if (split.frontmatter !== null) {
    const header = Object.keys(kept).length === 0 ? '' : `---\n${toYaml(kept)}---\n`;
    content = new TextEncoder().encode(`${header}${split.body}`);
  }
  return { ok: true, flags, tools, model, unknownKeys, content };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Skrot drzewa kopiowanych plikow: sciezka, bit wykonywania i skrot tresci, w kolejnosci sciezek. */
function treeSha256(files: readonly SourceFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((file) => `${file.rel}\0${file.executable ? 1 : 0}\0${sha256Of(file.bytes)}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Sciezka po realpath musi lezec pod realpath(--from) (SEC-001); null, gdy nie lezy albo nie istnieje. */
async function realInside(path: string, from: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return isPathInside(real, from) ? real : null;
  } catch {
    return null;
  }
}

/** Wpis raportu o kluczach frontmattera spoza listy dozwolonych (bez ich wartosci). */
function unknownKeyNotes(label: string, keys: readonly string[]): ReportItem[] {
  if (keys.length === 0) return [];
  const shown = keys.slice(0, 8).join(', ');
  const more = keys.length > 8 ? ` (+${keys.length - 8})` : '';
  return [{ item: label, reason: `pominieto nieznane klucze frontmattera: ${shown}${more}` }];
}

/** Komunikaty klasyfikatora maja polskie znaki i cudzyslowy typograficzne; raport CWM jest ASCII. */
function asciiFold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\u0142/g, 'l')
    .replace(/\u0141/g, 'L')
    .replace(/[\u201e\u201d]/g, '"');
}

/** Trafienie klasyfikatora sekretow: powod bez wartosci (reguly z secret-classifier.ts). */
function secretReason(rel: string, bytes: Uint8Array | null): string | null {
  const byFile = classifyFileName(rel);
  if (byFile !== null) return asciiFold(byFile.reason);
  if (bytes === null) return null;
  const hits = classifyStrict([{ relPath: rel, bytes }]);
  const first = hits[0];
  return first === undefined
    ? null
    : `${asciiFold(first.reason)}${first.line === null ? '' : ` (wiersz ${first.line})`}`;
}

async function readRegular(
  path: string,
): Promise<{ bytes: Uint8Array; executable: boolean } | { skip: string }> {
  const info = await lstatOrNull(path);
  if (info === null) return { skip: 'plik zniknal podczas odczytu' };
  if (!info.isFile()) return { skip: 'nie jest zwyklym plikiem' };
  if (info.size > IMPORT_LIMITS.fileBytes) return { skip: 'plik wiekszy niz 1 MiB' };
  try {
    const read = await readBounded(path, IMPORT_LIMITS.fileBytes);
    if (read.truncated) return { skip: 'plik wiekszy niz 1 MiB' };
    return { bytes: read.bytes, executable: (info.mode & 0o100) !== 0 };
  } catch {
    return { skip: 'blad odczytu' };
  }
}

interface Walked {
  readonly files: SourceFile[];
  readonly failure: string | null;
}

/** Drzewo skilla: tylko zwykle pliki, dowiazania pomijane, `.git` i `node_modules` zawsze pomijane. */
async function walkSkill(
  root: string,
  label: string,
  budget: Budget,
  skipped: ReportItem[],
): Promise<Walked> {
  const files: SourceFile[] = [];
  const lowerPaths = new Set<string>();
  let encountered = 0;
  let totalBytes = 0;
  const stack = [{ dir: root, rel: '', depth: 0 }];
  const fail = (failure: string): Walked => ({ files, failure });

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    budget.enterDir();
    if (budget.exceeded !== null) return fail(budget.exceeded);
    const listing = await listOrNull(frame.dir).catch(() => null);
    if (listing === null) return fail('katalog nieczytelny');
    if (listing.truncated) return fail('za duzo wpisow w jednym katalogu');
    const entries = [...listing.entries].sort(byName);
    for (const entry of entries) {
      const rel = frame.rel === '' ? entry.name : `${frame.rel}/${entry.name}`;
      const item = `${label}/${rel}`;
      if (entry.name === '.DS_Store') continue;
      if (ALWAYS_SKIPPED_NAMES.has(entry.name)) {
        skipped.push({ item, reason: 'zawsze pomijane (.git, node_modules)' });
      } else if (entry.isSymbolicLink()) {
        skipped.push({ item, reason: 'dowiazanie symboliczne pominiete' });
      } else if (isProtectedName(entry.name)) {
        skipped.push({ item, reason: 'chroniona nazwa (.claude, CLAUDE.md, .mcp.json)' });
      } else if (entry.isDirectory()) {
        if (frame.depth + 1 > IMPORT_LIMITS.skillDepth)
          return fail('struktura glebsza niz 16 poziomow');
        stack.push({ dir: join(frame.dir, entry.name), rel, depth: frame.depth + 1 });
      } else if (!entry.isFile()) {
        skipped.push({ item, reason: 'nie jest zwyklym plikiem' });
      } else {
        encountered += 1;
        if (encountered > IMPORT_LIMITS.skillFiles) return fail('wiecej niz 500 plikow');
        const lower = rel.normalize('NFC').toLowerCase();
        if (lowerPaths.has(lower)) return fail('dwa pliki roznia sie tylko wielkoscia liter');
        lowerPaths.add(lower);
        if (frame.rel === '' && RESERVED_RESOURCE_FILES.has(lower)) {
          skipped.push({ item, reason: 'nazwa zarezerwowana przez CWM' });
          continue;
        }
        const nameHit = classifyFileName(rel);
        if (nameHit !== null) {
          skipped.push({ item, reason: `mozliwy sekret: ${asciiFold(nameHit.reason)}` });
          continue;
        }
        const read = await readRegular(join(frame.dir, entry.name));
        budget.take('bytes' in read ? read.bytes.length : 0);
        if (budget.exceeded !== null) return fail(budget.exceeded);
        if ('skip' in read) {
          skipped.push({ item, reason: read.skip });
          continue;
        }
        totalBytes += read.bytes.length;
        if (totalBytes > IMPORT_LIMITS.skillBytes) return fail('wiecej niz 10 MiB');
        const secret = secretReason(rel, read.bytes);
        if (secret !== null) skipped.push({ item, reason: `mozliwy sekret: ${secret}` });
        else files.push({ rel, bytes: read.bytes, executable: read.executable });
      }
    }
  }
  return {
    files: files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)),
    failure: null,
  };
}

function nameOf(raw: string, label: string, skipped: ReportItem[]) {
  const result = normalizeResourceName(raw);
  if (!result.ok) {
    skipped.push({ item: label, reason: result.reason });
    return null;
  }
  return result;
}

/** `skills/`, `agents/` i `commands/` pod --from musza byc zwyklymi katalogami, nie dowiazaniami (SEC-001). */
async function topLevelDir(from: string, name: string, skipped: ReportItem[]): Promise<boolean> {
  const info = await lstatOrNull(join(from, name));
  if (info === null) return false;
  if (info.isSymbolicLink()) {
    skipped.push({ item: name, reason: 'dowiazanie symboliczne pominiete (brak --follow-links)' });
    return false;
  }
  return info.isDirectory();
}

async function scanSkills(
  from: string,
  budget: Budget,
  skipped: ReportItem[],
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  if (!(await topLevelDir(from, 'skills', skipped))) return found;
  const listing = await listOrNull(join(from, 'skills')).catch(() => null);
  if (listing === null) return found;
  if (listing.truncated)
    skipped.push({ item: 'skills', reason: 'za duzo wpisow, reszta pominieta' });
  for (const entry of [...listing.entries].sort(byName)) {
    const label = `skills/${entry.name}`;
    if (entry.name === 'synced') {
      skipped.push({
        item: label,
        reason: 'skille z claude.ai (wspolne dla konta) nie sa importowane',
      });
    } else if (entry.name.startsWith('.')) {
      skipped.push({ item: label, reason: 'ukryty wpis pominiety' });
    } else if (entry.isSymbolicLink()) {
      skipped.push({
        item: label,
        reason: 'dowiazanie symboliczne pominiete (brak --follow-links)',
      });
    } else if (!entry.isDirectory()) {
      skipped.push({ item: label, reason: 'oczekiwano katalogu skilla' });
    } else {
      const candidate = await scanSkill(
        from,
        join(from, 'skills', entry.name),
        entry.name,
        label,
        budget,
        skipped,
      );
      if (candidate !== null) found.push(candidate);
      if (budget.exceeded !== null) return found;
    }
  }
  return found;
}

async function scanSkill(
  from: string,
  dir: string,
  rawName: string,
  label: string,
  budget: Budget,
  skipped: ReportItem[],
): Promise<Candidate | null> {
  const name = nameOf(rawName, label, skipped);
  if (name === null) return null;
  const sourceReal = await realInside(dir, from);
  if (sourceReal === null) {
    skipped.push({
      item: label,
      reason: 'skill pominiety: sciezka po realpath poza katalogiem --from',
    });
    return null;
  }
  const walked = await walkSkill(dir, label, budget, skipped);
  if (walked.failure !== null) {
    if (budget.exceeded === null)
      skipped.push({ item: label, reason: `skill pominiety: ${walked.failure}` });
    return null;
  }
  const main = walked.files.find((file) => file.rel === SOURCE_FILE.skill);
  if (main === undefined) {
    skipped.push({
      item: label,
      reason: 'skill pominiety: brak SKILL.md (lub pominiety jako mozliwy sekret)',
    });
    return null;
  }
  const parsed = parseContent('skill', main.bytes);
  if (!parsed.ok) {
    skipped.push({ item: `${label}/SKILL.md`, reason: `skill pominiety: ${parsed.reason}` });
    return null;
  }
  const files = walked.files.map((file) =>
    file === main ? { ...file, bytes: parsed.content } : file,
  );
  return {
    kind: 'skill',
    rawName,
    name: name.name,
    label,
    files,
    sourceReal,
    sha256: treeSha256(files),
    source: SOURCE_FILE.skill,
    flags: parsed.flags,
    tools: [],
    model: parsed.model,
    spec: null,
    envRefs: [],
    pins: [],
    notes: [
      ...(name.changed ? [{ item: label, reason: `nazwa znormalizowana do "${name.name}"` }] : []),
      ...unknownKeyNotes(label, parsed.unknownKeys),
    ],
  };
}

async function scanMarkdownDir(
  from: string,
  subdir: 'agents' | 'commands',
  kind: 'agent' | 'command',
  budget: Budget,
  skipped: ReportItem[],
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  if (!(await topLevelDir(from, subdir, skipped))) return found;
  const listing = await listOrNull(join(from, subdir)).catch(() => null);
  if (listing === null) return found;
  if (listing.truncated) skipped.push({ item: subdir, reason: 'za duzo wpisow, reszta pominieta' });
  for (const entry of [...listing.entries].sort(byName)) {
    const label = `${subdir}/${entry.name}`;
    if (entry.name.startsWith('.')) {
      if (entry.name !== '.DS_Store')
        skipped.push({ item: label, reason: 'ukryty wpis pominiety' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      skipped.push({
        item: label,
        reason: 'dowiazanie symboliczne pominiete (brak --follow-links)',
      });
      continue;
    }
    if (entry.isDirectory()) {
      skipped.push({ item: label, reason: 'zagniezdzone katalogi nie sa obslugiwane' });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      skipped.push({ item: label, reason: 'oczekiwano pliku .md' });
      continue;
    }
    const name = nameOf(entry.name.slice(0, -3), label, skipped);
    if (name === null) continue;
    const sourceReal = await realInside(join(from, subdir, entry.name), from);
    if (sourceReal === null) {
      skipped.push({ item: label, reason: 'sciezka po realpath poza katalogiem --from' });
      continue;
    }
    const read = await readRegular(join(from, subdir, entry.name));
    budget.take('bytes' in read ? read.bytes.length : 0);
    if (budget.exceeded !== null) return found;
    if ('skip' in read) {
      skipped.push({ item: label, reason: read.skip });
      continue;
    }
    const secret = secretReason(entry.name, read.bytes);
    if (secret !== null) {
      skipped.push({ item: label, reason: `mozliwy sekret: ${secret}` });
      continue;
    }
    const parsed = parseContent(kind, read.bytes);
    if (!parsed.ok) {
      skipped.push({ item: label, reason: parsed.reason });
      continue;
    }
    const files = [{ rel: SOURCE_FILE[kind], bytes: parsed.content, executable: false }];
    found.push({
      kind,
      rawName: entry.name.slice(0, -3),
      name: name.name,
      label,
      files,
      sourceReal,
      sha256: treeSha256(files),
      source: SOURCE_FILE[kind],
      flags: parsed.flags,
      tools: parsed.tools,
      model: parsed.model,
      spec: null,
      envRefs: [],
      pins: [],
      notes: [
        ...(name.changed
          ? [{ item: label, reason: `nazwa znormalizowana do "${name.name}"` }]
          : []),
        ...unknownKeyNotes(label, parsed.unknownKeys),
      ],
    });
  }
  return found;
}

async function scanSettings(
  from: string,
  budget: Budget,
  skipped: ReportItem[],
): Promise<Candidate | null> {
  const path = join(from, 'settings.json');
  const info = await lstatOrNull(path);
  if (info === null) return null;
  if (info.isSymbolicLink()) {
    skipped.push({
      item: 'settings.json',
      reason: 'dowiazanie symboliczne pominiete (brak --follow-links)',
    });
    return null;
  }
  const read = await readRegular(path);
  budget.take('bytes' in read ? read.bytes.length : 0);
  if ('skip' in read) {
    skipped.push({ item: 'settings.json', reason: read.skip });
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes));
  } catch {
    skipped.push({ item: 'settings.json', reason: 'niepoprawny JSON lub UTF-8' });
    return null;
  }
  const converted = convertNativeSettings(json);
  if (!converted.ok) {
    skipped.push({ item: 'settings.json', reason: converted.message });
    return null;
  }
  const { spec, skipped: skippedKeys, envRefs, hookCommands, secretPaths } = converted.value;
  for (const key of skippedKeys) {
    skipped.push({ item: `settings.json: ${key.path}`, reason: key.reason });
  }
  if (secretPaths.length > 0) {
    skipped.push({
      item: 'settings.json',
      reason: `zasob Settings pominiety: sekret w poleceniu hooka lub regule uprawnien (${secretPaths.slice(0, 5).join(', ')})`,
    });
    return null;
  }
  const sourceReal = await realInside(path, from);
  if (sourceReal === null) {
    skipped.push({ item: 'settings.json', reason: 'sciezka po realpath poza katalogiem --from' });
    return null;
  }
  if (Object.keys(spec).length === 0) {
    skipped.push({
      item: 'settings.json',
      reason: 'brak hookow, uprawnien ani env do zaimportowania',
    });
    return null;
  }
  const { pins, dropped } = await pinHookCommands(hookCommands, homedir());
  const notes: ReportItem[] = [];
  if (dropped > 0) {
    notes.push({
      item: 'settings.json: hooki',
      reason: `${dropped} sciezek poza limitem przypinania (nieprzypiete i nieoznaczone)`,
    });
  }
  for (const pin of pins) {
    notes.push({
      item: `settings.json: hook ${pin.token.raw}`,
      reason:
        pin.status.state === 'pinned'
          ? `przypiete sha256:${pin.status.sha256.slice(0, 12)}`
          : describeUnpinned(pin.status.reason),
    });
  }
  if (envRefs.length > 0) {
    notes.push({
      item: 'settings.json: env',
      reason: `wyglada na sekret, zapisano envRef zamiast wartosci (uzupelnij zmienne srodowiska): ${envRefs.join(', ')}`,
    });
  }
  return {
    kind: 'settings',
    rawName: 'claude-settings',
    name: 'claude-settings',
    label: 'settings.json',
    files: [],
    sourceReal,
    sha256: sha256Of(read.bytes),
    source: '',
    flags: NO_FLAGS,
    tools: [],
    model: null,
    spec,
    envRefs,
    pins,
    notes,
  };
}

export interface ScanOptions {
  /** Katalog danych CWM: `--from` nie moze w nim lezec (IMP-02). */
  readonly cwmHome: string;
  /** Domyslne zrodlo, gdy nie podano `--from`. */
  readonly defaultFrom?: string;
}

export async function scanClaudeSource(
  fromInput: string | undefined,
  options: ScanOptions,
): Promise<ScanOutcome> {
  const requested = resolve(fromInput ?? options.defaultFrom ?? join(homedir(), '.claude'));
  let from: string;
  try {
    from = await realpath(requested);
    if (!(await stat(from)).isDirectory()) {
      return { ok: false, message: '--from nie jest katalogiem.' };
    }
  } catch {
    return { ok: false, message: 'Katalog --from nie istnieje albo jest nieczytelny.' };
  }
  const homeReal = await realpathLoose(options.cwmHome);
  if (isPathInside(from, homeReal, { allowSame: true })) {
    return {
      ok: false,
      message:
        '--from nie moze lezec w katalogu danych CWM (wygenerowany profil wrocilby do rejestru).',
    };
  }

  const budget = new Budget();
  const skipped: ReportItem[] = [];
  const candidates: Candidate[] = [];
  candidates.push(...(await scanSkills(from, budget, skipped)));
  if (budget.exceeded === null)
    candidates.push(...(await scanMarkdownDir(from, 'agents', 'agent', budget, skipped)));
  if (budget.exceeded === null)
    candidates.push(...(await scanMarkdownDir(from, 'commands', 'command', budget, skipped)));
  if (budget.exceeded === null) {
    const settings = await scanSettings(from, budget, skipped);
    if (settings !== null) candidates.push(settings);
  }
  if (budget.exceeded !== null) return { ok: false, message: budget.exceeded };
  return { ok: true, from, candidates, skipped };
}
