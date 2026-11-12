import type { Dirent } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
  analyzeContent,
  canonicalJson,
  foldName,
  frontmatterFrameProblem,
  isAsciiName,
  convertNativeSettings,
  normalizeResourceName,
  splitFrontmatter,
  validateCleanupPath,
  type ContentFlags,
  type ContentKind,
} from '../../core/cwm';
import { isPathInside } from '../../core/model/path-containment';
import {
  classifyFileName,
  classifyStrict,
  findHardSecret,
  type SecretHit,
} from '../../core/services/security/secret-classifier';
import { readBounded } from '../fs/bounded-read';
import { lstatOrNull } from '../fs/stat';
import { errnoCode } from '../fs/store-error';
import { pinHookCommands, describeUnpinned } from './hook-pins';
import {
  IMPORT_LIMITS,
  type Candidate,
  type FlaggedFile,
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
const SOURCE_FILE: Record<'skill' | 'agent' | 'command', string> = {
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

export interface ParsedContent {
  readonly ok: true;
  readonly name: string | null;
  readonly flags: Candidate['flags'];
  readonly allowedToolsValue: readonly string[];
  readonly inlineSnippets: readonly string[];
  readonly tools: readonly string[];
  readonly model: string | null;
  readonly unknownKeys: readonly string[];
  /** Bajty do zapisu: frontmatter odtworzony z dozwolonych kluczy, tresc bez zmian (IMP-05 pkt 1). */
  readonly content: Uint8Array;
}

/** Frontmatter wg IMP-04: poczatek pliku, BOM, limit 64 KiB, te same opcje YAML co manifesty. */
export function parseContent(
  kind: ContentKind,
  bytes: Uint8Array,
  /**
   * Nazwa zasobu: gdy zaden klucz frontmattera nie przezyje, naglowek dostaje `name:` (nigdy pusty
   * blok `---\n---`, bo parser konczacy blok na `---` czytalby tresc jako frontmatter). Bez nazwy
   * (pliki Files) naglowek jest pomijany w calosci.
   */
  resourceName?: string,
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
  const frame = frontmatterFrameProblem(text, split);
  if (frame !== null) return { ok: false, reason: frame };
  const analysis = analyzeContent(kind, frontmatter, text);
  if (!analysis.ok) return { ok: false, reason: describeProblems(analysis.errors) };
  const { flags, tools, model, unknownKeys } = analysis.value;
  let kept: Record<string, unknown> = analysis.value.kept;
  let content = bytes;
  if (split.frontmatter !== null) {
    if (Object.keys(kept).length === 0 && resourceName !== undefined) {
      kept = { name: resourceName };
    }
    const hasKeys = Object.keys(kept).length > 0;
    const rebuilt = hasKeys ? `---\n${toYaml(kept)}---\n${split.body}` : split.body;
    const check = splitFrontmatter(rebuilt);
    const reparsed =
      check.ok && check.frontmatter !== null ? parseManifestYaml(check.frontmatter) : null;
    const same = hasKeys
      ? check.ok &&
        check.frontmatter !== null &&
        check.body === split.body &&
        reparsed !== null &&
        reparsed.ok &&
        canonicalJson(reparsed.value ?? {}) === canonicalJson(kept)
      : check.ok && check.frontmatter === null && check.body === split.body;
    if (!same || (check.ok && frontmatterFrameProblem(rebuilt, check) !== null)) {
      return { ok: false, reason: 'odtworzony frontmatter nie zgadza sie z zachowanymi kluczami' };
    }
    content = new TextEncoder().encode(rebuilt);
  }
  return {
    ok: true,
    name: analysis.value.name,
    flags,
    allowedToolsValue: analysis.value.allowedToolsValue,
    inlineSnippets: analysis.value.inlineSnippets,
    tools,
    model,
    unknownKeys,
    content,
  };
}

/** Plik `.md` rodzaju Files po przejsciu przez filtr frontmattera (odtworzony, bez kluczy wykonawczych). */
export type FilesMarkdown =
  | {
      readonly ok: true;
      readonly content: Uint8Array;
      readonly flags: Candidate['flags'];
      readonly inlineSnippets: readonly string[];
      readonly name: string | null;
      readonly unknownKeys: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Frontmatter zamkniety znacznikiem `...` (koniec dokumentu YAML) zamiast `---`. */
function closedByDocumentEnd(text: string): boolean {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n');
  if ((lines[0] ?? '').trimEnd() !== '---') return false;
  for (const line of lines.slice(1)) {
    const trimmed = line.replace(/\r$/, '').trimEnd();
    if (trimmed === '---') return false;
    if (trimmed === '...') return true;
  }
  return false;
}

/**
 * Pliki `.md` rodzaju Files nigdy nie zachowuja surowego frontmattera: sa parsowane regulami Skill
 * (`skills/`) albo Agent (`agents/`) i odtwarzane z dozwolonych kluczy. Odrzucane sa: klucz scalania
 * YAML `<<`, znacznik `...`, `hooks`, `mcpServers`, `permissionMode` oraz klucze wykonawcze `tools`,
 * `allowed-tools` i `model`. Wstawka `!` w tresci daje zasobowi zatwierdzenie.
 */
export function parseFilesMarkdown(root: 'skills' | 'agents', bytes: Uint8Array): FilesMarkdown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'plik nie jest poprawnym UTF-8' };
  }
  const split = splitFrontmatter(text);
  if (!split.ok) return { ok: false, reason: split.message };
  if (split.frontmatter !== null) {
    if (/<<["']?\s*:/.test(split.frontmatter)) {
      return { ok: false, reason: 'frontmatter z kluczem scalania YAML (<<)' };
    }
    if (closedByDocumentEnd(text)) {
      return { ok: false, reason: 'frontmatter zamkniety znacznikiem konca dokumentu (...)' };
    }
  }
  const parsed = parseContent(root === 'agents' ? 'agent' : 'skill', bytes);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.flags.allowedTools || parsed.tools.length > 0 || parsed.model !== null) {
    return { ok: false, reason: 'frontmatter z kluczem wykonawczym (tools, allowed-tools, model)' };
  }
  return {
    ok: true,
    content: parsed.content,
    flags: parsed.flags,
    inlineSnippets: parsed.inlineSnippets,
    name: parsed.name,
    unknownKeys: parsed.unknownKeys,
  };
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

/**
 * Dolacza do kandydata oznaczone pliki wybrane przez uzytkownika (klucz: sciezka wzgledem --from).
 * Twardy sekret nie ma tresci w pamieci, wiec nie da sie go dolaczyc. Skrot drzewa liczony jest od nowa.
 */
export function withIncluded(candidate: Candidate, included: ReadonlySet<string>): Candidate {
  const chosen = candidate.flagged.filter(
    (f) => !f.hard && f.file !== null && included.has(f.path),
  );
  if (chosen.length === 0) return candidate;
  let files: SourceFile[] = [
    ...candidate.files,
    ...chosen.flatMap((f) => (f.file === null ? [] : [f.file])),
  ].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let flags = candidate.flags;
  const notes = [...candidate.notes];
  const root = candidate.filesSpec?.root;
  const rejected = new Set<string>();
  if (root !== undefined) {
    // Dolaczone pliki przechodza te same reguly co reszta zasobu; odrzucony plik jest zgloszony.
    const dropped: ReportItem[] = [];
    const module = moduleFiles(files, root, dropped);
    const kept = new Set(module.files.map((f) => f.rel));
    for (const f of chosen) {
      if (!kept.has(f.rel)) rejected.add(f.path);
    }
    files = module.files;
    flags = module.flags;
    notes.push(
      ...module.notes.filter((n) => !notes.some((o) => o.item === n.item && o.reason === n.reason)),
      ...dropped.map((d) => ({ item: d.item, reason: `dolaczony plik odrzucony: ${d.reason}` })),
    );
  }
  const marked = new Set(chosen.map((f) => f.path));
  return {
    ...candidate,
    files,
    flags,
    notes,
    sha256: treeSha256(files),
    flagged: candidate.flagged.map((f) =>
      marked.has(f.path) && !rejected.has(f.path) ? { ...f, included: true } : f,
    ),
  };
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

/** Trafienie klasyfikatora sekretow: powod i numer wiersza, bez wartosci (reguly z secret-classifier.ts). */
function secretHit(
  rel: string,
  bytes: Uint8Array | null,
): { readonly reason: string; readonly line: number | null } | null {
  const byFile = classifyFileName(rel);
  if (byFile !== null) return { reason: asciiFold(byFile.reason), line: null };
  if (bytes === null) return null;
  const first = classifyStrict([{ relPath: rel, bytes }])[0];
  return first === undefined ? null : { reason: asciiFold(first.reason), line: first.line };
}

async function readRegular(
  path: string,
): Promise<{ bytes: Uint8Array; executable: boolean } | { skip: string }> {
  const info = await lstatOrNull(path);
  if (info === null) return { skip: 'plik zniknal podczas odczytu' };
  if (!info.isFile()) return { skip: 'nie jest zwyklym plikiem' };
  if (info.nlink > 1) return { skip: 'plik ma wiele twardych dowiazan' };
  if (info.size > IMPORT_LIMITS.fileBytes) return { skip: 'plik wiekszy niz 1 MiB' };
  try {
    const read = await readBounded(path, IMPORT_LIMITS.fileBytes);
    if (read.truncated) return { skip: 'plik wiekszy niz 1 MiB' };
    return { bytes: read.bytes, executable: (info.mode & 0o100) !== 0 };
  } catch {
    return { skip: 'blad odczytu' };
  }
}

/** Obszary --from, z ktorych wolno czytac (IMP-02); dowiazanie nie moze prowadzic nigdzie indziej. */
const NON_ASCII = 'nazwa spoza ASCII (ryzyko podobnych znakow): pominieta';
const READABLE_AREAS = new Set(['skills', 'agents', 'commands']);

/**
 * Ta sama regula dla celu dowiazania i dla kazdego wpisu drzewa: tylko `skills/`, `agents/`,
 * `commands/` (nie sam korzen obszaru), bez `synced` (takze zmienionej wielkosci liter) w `skills/`,
 * bez ukrytego wpisu `skills/`, `.git`, `node_modules` i chronionych nazw na calej sciezce.
 */
function blockedArea(from: string, real: string): boolean {
  const segments = relative(from, real).split(sep);
  const [area, entry] = segments;
  if (area === undefined || !READABLE_AREAS.has(area) || segments.length < 2) return true;
  if (entry !== undefined && foldName(entry).startsWith('.')) return true;
  if (area === 'skills') {
    if (segments.some((segment) => foldName(segment) === 'synced')) return true;
  }
  return segments.some(
    (segment) => ALWAYS_SKIPPED_NAMES.has(foldName(segment)) || isProtectedName(segment),
  );
}

type LinkTarget =
  { readonly kind: 'file' | 'dir'; readonly real: string } | { readonly skip: string };

/**
 * Dowiazanie wolno sledzic tylko wtedy, gdy jego `realpath` jest zwyklym plikiem albo katalogiem
 * wewnatrz `realpath(--from)` i poza pominietymi obszarami (poza `skills/`, `agents/`, `commands/`,
 * `skills/synced`, ukryty wpis w `skills/`, `.git`, `node_modules`, chronione nazwy). Do rejestru
 * trafia kopia tresci, nigdy dowiazanie (IMP-01).
 */
async function followLink(path: string, from: string): Promise<LinkTarget> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { skip: 'dowiazanie zerwane' };
  }
  if (!isPathInside(real, from)) {
    return { skip: 'dowiazanie prowadzi poza katalog --from' };
  }
  if (blockedArea(from, real)) return { skip: 'dowiazanie prowadzi w pominiety obszar' };
  const info = await lstatOrNull(real);
  if (info === null) return { skip: 'dowiazanie zerwane' };
  if (info.isFile()) return { kind: 'file', real };
  if (info.isDirectory()) return { kind: 'dir', real };
  return { skip: 'cel dowiazania nie jest zwyklym plikiem ani katalogiem' };
}

interface WalkContext {
  /** `realpath(--from)`. */
  readonly from: string;
  /** Etykieta zasobu w raporcie, np. `skills/acme-lint`. */
  readonly label: string;
  /** Sciezka katalogu zasobu wzgledem --from (klucz `--include-flagged`). */
  readonly fromPath: string;
  /** Przedrostek dopisywany do sciezek kopiowanych plikow (rodzaj Files). */
  readonly prefix: string;
  /** Skill: nazwy zarezerwowane przez CWM w katalogu zasobu. */
  readonly reservedTop: boolean;
  /** Rodzaj Files: plik o nazwie manifestu skilla (`skill.md`, bez wzgledu na wielkosc liter) jest odrzucany. */
  readonly forbidManifest: boolean;
  /** Powod odrzucenia sciezki w profilu albo null. */
  readonly pathProblem: ((outRel: string) => string | null) | null;
  readonly budget: Budget;
  readonly skipped: ReportItem[];
}

interface Sink {
  readonly files: SourceFile[];
  readonly flagged: FlaggedFile[];
  followed: number;
  encountered: number;
  totalBytes: number;
  readonly lowerPaths: Set<string>;
}

const newSink = (): Sink => ({
  files: [],
  flagged: [],
  followed: 0,
  encountered: 0,
  totalBytes: 0,
  lowerPaths: new Set(),
});

/**
 * Jeden plik drzewa: limity, nazwa i tresc przez klasyfikator sekretow. Plik z trafieniem nie jest
 * kopiowany; trafia na liste oznaczonych, a twardego sekretu nawet nie trzymamy w pamieci.
 * Zwraca powod przerwania calego zasobu albo null.
 */
const strongerHit = (a: SecretHit | null, b: SecretHit | null): SecretHit | null =>
  a === null || (b !== null && b.confidence === 'high' && a.confidence !== 'high') ? b : a;

async function ingestFile(
  ctx: WalkContext,
  sink: Sink,
  absPath: string,
  rel: string,
): Promise<string | null> {
  const item = `${ctx.label}/${rel}`;
  sink.encountered += 1;
  if (sink.encountered > IMPORT_LIMITS.skillFiles) return 'wiecej niz 500 plikow';
  const lower = rel.split('/').map(foldName).join('/');
  if (sink.lowerPaths.has(lower)) return 'dwa pliki roznia sie tylko wielkoscia liter';
  sink.lowerPaths.add(lower);
  if (ctx.reservedTop && !rel.includes('/') && RESERVED_RESOURCE_FILES.has(lower)) {
    ctx.skipped.push({ item, reason: 'nazwa zarezerwowana przez CWM' });
    return null;
  }
  if (ctx.forbidManifest && foldName(basename(rel)) === 'skill.md') {
    ctx.skipped.push({ item, reason: 'manifest skilla nie moze byc plikiem wspolnym (Files)' });
    return null;
  }
  const outRel = `${ctx.prefix}${rel}`;
  const problem = ctx.pathProblem?.(outRel) ?? null;
  if (problem !== null) {
    ctx.skipped.push({ item, reason: `sciezka niedozwolona w profilu (${problem})` });
    return null;
  }
  const flag = (
    reason: string,
    line: number | null,
    hard: boolean,
    file: SourceFile | null,
  ): void => {
    sink.flagged.push({
      rel: outRel,
      path: `${ctx.fromPath}/${rel}`,
      reason,
      line,
      hard,
      file,
      included: false,
    });
  };
  // Nazwa dowiazania bywa niewinna, a cel nazywa sie `.env`: sprawdzamy obie.
  const nameHit = strongerHit(
    classifyFileName(rel),
    basename(rel) === basename(absPath) ? null : classifyFileName(basename(absPath)),
  );
  if (nameHit !== null && nameHit.confidence === 'high') {
    flag(asciiFold(nameHit.reason), null, true, null);
    return null;
  }
  const read = await readRegular(absPath);
  ctx.budget.take('bytes' in read ? read.bytes.length : 0);
  if (ctx.budget.exceeded !== null) return ctx.budget.exceeded;
  if ('skip' in read) {
    ctx.skipped.push({ item, reason: read.skip });
    return null;
  }
  sink.totalBytes += read.bytes.length;
  if (sink.totalBytes > IMPORT_LIMITS.skillBytes) return 'wiecej niz 10 MiB';
  const file: SourceFile = { rel: outRel, bytes: read.bytes, executable: read.executable };
  const strong = findHardSecret(read.bytes);
  if (strong !== null && strong.hard) {
    flag(`twardy sekret: ${strong.reason}`, strong.line, true, null);
    return null;
  }
  const soft =
    nameHit !== null
      ? { reason: asciiFold(nameHit.reason), line: null }
      : (secretHit(rel, read.bytes) ??
        (strong === null ? null : { reason: strong.reason, line: strong.line }));
  if (soft !== null) flag(soft.reason, soft.line, false, file);
  else sink.files.push(file);
  return null;
}

interface Walked extends Sink {
  readonly failure: string | null;
}

/**
 * Drzewo zasobu: zwykle pliki oraz dowiazania, ktorych cel lezy w --from (followLink); `.git` i
 * `node_modules` zawsze pomijane. Czyta od `root` po `realpath`, a petla dowiazan jest przerywana.
 */
async function walkTree(root: string, ctx: WalkContext): Promise<Walked> {
  const sink = newSink();
  const fail = (failure: string): Walked => ({ ...sink, failure });
  const stack = [{ dir: root, rel: '', depth: 0, chain: [root] }];

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    ctx.budget.enterDir();
    if (ctx.budget.exceeded !== null) return fail(ctx.budget.exceeded);
    const listing = await listOrNull(frame.dir).catch(() => null);
    if (listing === null) return fail('katalog nieczytelny');
    if (listing.truncated) return fail('za duzo wpisow w jednym katalogu');
    const entries = [...listing.entries].sort(byName);
    for (const entry of entries) {
      const rel = frame.rel === '' ? entry.name : `${frame.rel}/${entry.name}`;
      const item = `${ctx.label}/${rel}`;
      const path = join(frame.dir, entry.name);
      if (!isAsciiName(entry.name)) {
        ctx.skipped.push({ item, reason: NON_ASCII });
        continue;
      }
      if (entry.name === '.DS_Store') continue;
      if (ALWAYS_SKIPPED_NAMES.has(foldName(entry.name))) {
        ctx.skipped.push({ item, reason: 'zawsze pomijane (.git, node_modules)' });
        continue;
      }
      if (isProtectedName(entry.name)) {
        ctx.skipped.push({ item, reason: 'chroniona nazwa (.claude, CLAUDE.md, .mcp.json)' });
        continue;
      }
      if (!entry.isSymbolicLink() && blockedArea(ctx.from, path)) {
        ctx.skipped.push({ item, reason: 'wpis w pominietym obszarze (synced, ukryty, .git)' });
        continue;
      }
      let kind: 'file' | 'dir' | null = null;
      let real = path;
      if (entry.isSymbolicLink()) {
        const target = await followLink(path, ctx.from);
        if ('skip' in target) {
          ctx.skipped.push({ item, reason: target.skip });
          continue;
        }
        kind = target.kind;
        real = target.real;
      } else if (entry.isDirectory()) kind = 'dir';
      else if (entry.isFile()) kind = 'file';
      if (kind === null) {
        ctx.skipped.push({ item, reason: 'nie jest zwyklym plikiem' });
      } else if (kind === 'dir') {
        if (frame.depth + 1 > IMPORT_LIMITS.skillDepth)
          return fail('struktura glebsza niz 16 poziomow');
        if (frame.chain.includes(real) || isPathInside(root, real, { allowSame: true })) {
          ctx.skipped.push({ item, reason: 'petla dowiazan pominieta' });
          continue;
        }
        if (entry.isSymbolicLink()) sink.followed += 1;
        stack.push({ dir: real, rel, depth: frame.depth + 1, chain: [...frame.chain, real] });
      } else {
        if (entry.isSymbolicLink()) sink.followed += 1;
        const failure = await ingestFile(ctx, sink, real, rel);
        if (failure !== null) return fail(failure);
      }
    }
  }
  sink.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { ...sink, failure: null };
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
    skipped.push({ item: name, reason: 'dowiazanie symboliczne pominiete' });
    return false;
  }
  return info.isDirectory();
}

/**
 * Dowiazanie najwyzszego poziomu, ktorego cel to inny wpis tego samego obszaru (albo cel innego
 * dowiazania), jest aliasem: zasob istnieje juz pod tamta nazwa.
 */
function aliasChecker(state: AliasState): (real: string, name: string) => string | null {
  return (real, name) => {
    if (state.regular.has(real)) return relative(state.from, real);
    const first = state.seen.get(real);
    if (first !== undefined) return first;
    state.seen.set(real, name);
    return null;
  };
}

/** Wpisy zwykle wszystkich trzech obszarow: alias moze wskazywac wpis innego obszaru (skills/x -> agents/m). */
interface AliasState {
  readonly from: string;
  readonly regular: Set<string>;
  readonly seen: Map<string, string>;
}

async function buildAliasState(from: string): Promise<AliasState> {
  const regular = new Set<string>();
  for (const area of READABLE_AREAS) {
    const listing = await listOrNull(join(from, area)).catch(() => null);
    for (const entry of listing?.entries ?? []) {
      if (!entry.isSymbolicLink()) regular.add(join(from, area, entry.name));
    }
  }
  return { from, regular, seen: new Map() };
}

/** Wpis `skills/`, `agents/` albo `commands/`: zwykly albo dowiazanie, ktorego cel wolno czytac. */
async function resolveEntry(
  from: string,
  parent: string,
  entry: Dirent,
  label: string,
  skipped: ReportItem[],
  alias: (real: string, name: string) => string | null,
): Promise<{ kind: 'file' | 'dir' | null; real: string; linked: boolean } | null> {
  const path = join(from, parent, entry.name);
  if (entry.isSymbolicLink()) {
    const target = await followLink(path, from);
    if ('skip' in target) {
      skipped.push({ item: label, reason: target.skip });
      return null;
    }
    const of = alias(target.real, entry.name);
    if (of !== null) {
      skipped.push({ item: label, reason: `alias wpisu ${of}: pominiety (bez duplikatu zasobu)` });
      return null;
    }
    return { kind: target.kind, real: target.real, linked: true };
  }
  return {
    kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : null,
    real: path,
    linked: false,
  };
}

function linkNote(label: string, followed: number): ReportItem[] {
  return followed === 0
    ? []
    : [
        {
          item: label,
          reason: `${followed} dowiazan wewnatrz --from zastapiono kopiami tresci`,
        },
      ];
}

async function scanSkills(
  from: string,
  budget: Budget,
  skipped: ReportItem[],
  aliases: AliasState,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  if (!(await topLevelDir(from, 'skills', skipped))) return found;
  const listing = await listOrNull(join(from, 'skills')).catch(() => null);
  if (listing === null) return found;
  if (listing.truncated)
    skipped.push({ item: 'skills', reason: 'za duzo wpisow, reszta pominieta' });
  const alias = aliasChecker(aliases);
  for (const entry of [...listing.entries].sort(byName)) {
    const label = `skills/${entry.name}`;
    if (foldName(entry.name) === 'synced') {
      skipped.push({
        item: label,
        reason: 'skille z claude.ai (wspolne dla konta) nie sa importowane',
      });
      continue;
    }
    if (!isAsciiName(entry.name)) {
      skipped.push({ item: label, reason: NON_ASCII });
      continue;
    }
    if (foldName(entry.name).startsWith('.')) {
      skipped.push({ item: label, reason: 'ukryty wpis pominiety' });
      continue;
    }
    const resolved = await resolveEntry(from, 'skills', entry, label, skipped, alias);
    if (resolved === null) continue;
    let candidate: Candidate | null = null;
    if (resolved.kind === 'dir') {
      const inside = await listOrNull(resolved.real).catch(() => null);
      const isSkill = inside?.entries.some((e) => foldName(e.name) === 'skill.md') === true;
      candidate = isSkill
        ? await scanSkill(from, resolved.real, entry.name, label, budget, skipped)
        : await scanFilesDir(from, 'skills', entry.name, resolved.real, label, budget, skipped);
    } else if (resolved.kind === 'file' && entry.name.endsWith('.md')) {
      candidate = await scanFilesFlat(from, entry.name, resolved.real, label, budget, skipped);
    } else {
      skipped.push({ item: label, reason: 'oczekiwano katalogu skilla albo pliku .md' });
    }
    if (candidate !== null) found.push(candidate);
    if (budget.exceeded !== null) return found;
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
  const walked = await walkTree(sourceReal, {
    from,
    label,
    fromPath: label,
    prefix: '',
    reservedTop: true,
    forbidManifest: false,
    pathProblem: null,
    budget,
    skipped,
  });
  if (walked.failure !== null) {
    if (budget.exceeded === null)
      skipped.push({ item: label, reason: `skill pominiety: ${walked.failure}` });
    return null;
  }
  const isManifest = (rel: string): boolean => foldName(rel) === 'skill.md';
  const main = walked.files.find((file) => isManifest(file.rel));
  if (main === undefined) {
    // Trafienie w SKILL.md pomija caly skill; plik nie podlega przegladowi (ADR 0039 pkt 4, IMP-03).
    for (const hit of walked.flagged.filter((f) => isManifest(f.rel))) {
      skipped.push({
        item: `${label}/${hit.rel}`,
        reason: `mozliwy sekret: ${hit.reason}${hit.line === null ? '' : ` (wiersz ${hit.line})`}`,
      });
    }
    skipped.push({
      item: label,
      reason: 'skill pominiety: brak SKILL.md (lub pominiety jako mozliwy sekret)',
    });
    return null;
  }
  const parsed = parseContent('skill', main.bytes, name.name);
  if (!parsed.ok) {
    skipped.push({ item: `${label}/SKILL.md`, reason: `skill pominiety: ${parsed.reason}` });
    return null;
  }
  const files = walked.files.map((file) =>
    file === main ? { ...file, rel: SOURCE_FILE.skill, bytes: parsed.content } : file,
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
      ...linkNote(label, walked.followed),
    ],
    flagged: walked.flagged.filter((f) => !isManifest(f.rel)),
    filesSpec: null,
  };
}

/** Walidacja sciezki kopiowanej do profilu (ta sama, ktora zastosuje `cwm start`). */
function profilePathProblem(root: 'skills' | 'agents'): (outRel: string) => string | null {
  return (outRel) => {
    const check = validateCleanupPath(`claude/${root}/${outRel}`);
    return check.ok ? null : check.reason;
  };
}

/**
 * Pliki `.md` rodzaju Files przechodza `parseFilesMarkdown`: frontmatter jest odtwarzany z
 * dozwolonych kluczy, a plik z kluczem wykonawczym jest odrzucany. Wstawki `!` w tresci daja
 * zasobowi zatwierdzenie (flaga `inlineCommands`).
 */
function moduleFiles(
  files: readonly SourceFile[],
  root: 'skills' | 'agents',
  skipped: ReportItem[],
): { files: SourceFile[]; flags: ContentFlags; notes: ReportItem[] } {
  const out: SourceFile[] = [];
  const notes: ReportItem[] = [];
  let inlineCommands = false;
  for (const file of files) {
    if (!foldName(file.rel).endsWith('.md')) {
      out.push(file);
      continue;
    }
    const parsed = parseFilesMarkdown(root, file.bytes);
    if (!parsed.ok) {
      skipped.push({ item: `${root}/${file.rel}`, reason: parsed.reason });
      continue;
    }
    inlineCommands ||= parsed.flags.inlineCommands;
    notes.push(...unknownKeyNotes(`${root}/${file.rel}`, parsed.unknownKeys));
    out.push({ ...file, bytes: parsed.content });
  }
  return { files: out, flags: { allowedTools: false, inlineCommands }, notes };
}

/** Files to dane: zadnego bitu wykonywania (profil zapisuje 0600). */
const plain = (file: SourceFile): SourceFile =>
  file.executable ? { ...file, executable: false } : file;

function filesCandidate(input: {
  readonly root: 'skills' | 'agents';
  readonly entryName: string;
  readonly stem: string;
  readonly label: string;
  readonly sourceReal: string;
  readonly walked: Sink;
  readonly name: { readonly name: string; readonly changed: boolean };
  readonly skipped: ReportItem[];
}): Candidate {
  const { root, label, walked, name } = input;
  const module = moduleFiles(walked.files.map(plain), root, input.skipped);
  return {
    kind: 'files',
    rawName: `${root}-${input.stem}`,
    name: name.name,
    label,
    files: module.files,
    sourceReal: input.sourceReal,
    sha256: treeSha256(module.files),
    source: '',
    flags: module.flags,
    tools: [],
    model: null,
    spec: null,
    envRefs: [],
    pins: [],
    notes: [
      ...(name.changed ? [{ item: label, reason: `nazwa znormalizowana do "${name.name}"` }] : []),
      ...module.notes,
      ...linkNote(label, walked.followed),
    ],
    flagged: walked.flagged.map((f) => (f.file === null ? f : { ...f, file: plain(f.file) })),
    filesSpec: { root, path: input.entryName },
  };
}

/** Katalog bez SKILL.md w `skills/` albo podkatalog `agents/`: wspolne pliki (rodzaj Files). */
async function scanFilesDir(
  from: string,
  root: 'skills' | 'agents',
  entryName: string,
  dir: string,
  label: string,
  budget: Budget,
  skipped: ReportItem[],
): Promise<Candidate | null> {
  const name = nameOf(`${root}-${entryName}`, label, skipped);
  if (name === null) return null;
  const sourceReal = await realInside(dir, from);
  if (sourceReal === null) {
    skipped.push({ item: label, reason: 'sciezka po realpath poza katalogiem --from' });
    return null;
  }
  const walked = await walkTree(sourceReal, {
    from,
    label,
    fromPath: label,
    prefix: `${entryName}/`,
    reservedTop: false,
    forbidManifest: true,
    pathProblem: profilePathProblem(root),
    budget,
    skipped,
  });
  if (walked.failure !== null) {
    if (budget.exceeded === null)
      skipped.push({ item: label, reason: `pominiety: ${walked.failure}` });
    return null;
  }
  if (walked.files.length === 0 && walked.flagged.length === 0) {
    skipped.push({ item: label, reason: 'katalog bez SKILL.md i bez plikow do skopiowania' });
    return null;
  }
  return filesCandidate({
    root,
    entryName,
    stem: entryName,
    label,
    sourceReal,
    walked,
    name,
    skipped,
  });
}

/** Plik `.md` wprost w `skills/` (przewodnik, ktory skille i agenci czytaja po sciezce). */
async function scanFilesFlat(
  from: string,
  entryName: string,
  file: string,
  label: string,
  budget: Budget,
  skipped: ReportItem[],
): Promise<Candidate | null> {
  const stem = entryName.slice(0, -3);
  const name = nameOf(`skills-${stem}`, label, skipped);
  if (name === null) return null;
  const sourceReal = await realInside(file, from);
  if (sourceReal === null) {
    skipped.push({ item: label, reason: 'sciezka po realpath poza katalogiem --from' });
    return null;
  }
  const sink = newSink();
  const failure = await ingestFile(
    {
      from,
      label,
      fromPath: 'skills',
      prefix: '',
      reservedTop: false,
      forbidManifest: true,
      pathProblem: profilePathProblem('skills'),
      budget,
      skipped,
    },
    sink,
    sourceReal,
    entryName,
  );
  if (failure !== null) {
    if (budget.exceeded === null) skipped.push({ item: label, reason: `pominiety: ${failure}` });
    return null;
  }
  if (sink.files.length === 0 && sink.flagged.length === 0) return null;
  return filesCandidate({
    root: 'skills',
    entryName,
    stem,
    label,
    sourceReal,
    walked: sink,
    name,
    skipped,
  });
}

async function scanMarkdownDir(
  from: string,
  subdir: 'agents' | 'commands',
  kind: 'agent' | 'command',
  budget: Budget,
  skipped: ReportItem[],
  aliases: AliasState,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  if (!(await topLevelDir(from, subdir, skipped))) return found;
  const listing = await listOrNull(join(from, subdir)).catch(() => null);
  if (listing === null) return found;
  if (listing.truncated) skipped.push({ item: subdir, reason: 'za duzo wpisow, reszta pominieta' });
  const alias = aliasChecker(aliases);
  for (const entry of [...listing.entries].sort(byName)) {
    const label = `${subdir}/${entry.name}`;
    if (!isAsciiName(entry.name)) {
      skipped.push({ item: label, reason: NON_ASCII });
      continue;
    }
    if (foldName(entry.name).startsWith('.')) {
      if (entry.name !== '.DS_Store')
        skipped.push({ item: label, reason: 'ukryty wpis pominiety' });
      continue;
    }
    const resolved = await resolveEntry(from, subdir, entry, label, skipped, alias);
    if (resolved === null) continue;
    if (resolved.kind === 'dir') {
      if (subdir === 'commands') {
        skipped.push({ item: label, reason: 'zagniezdzone katalogi nie sa obslugiwane' });
        continue;
      }
      const module = await scanFilesDir(
        from,
        'agents',
        entry.name,
        resolved.real,
        label,
        budget,
        skipped,
      );
      if (module !== null) found.push(module);
      if (budget.exceeded !== null) return found;
      continue;
    }
    if (resolved.kind !== 'file' || !entry.name.endsWith('.md')) {
      skipped.push({ item: label, reason: 'oczekiwano pliku .md' });
      continue;
    }
    const name = nameOf(entry.name.slice(0, -3), label, skipped);
    if (name === null) continue;
    const sourceReal = await realInside(resolved.real, from);
    if (sourceReal === null) {
      skipped.push({ item: label, reason: 'sciezka po realpath poza katalogiem --from' });
      continue;
    }
    const read = await readRegular(sourceReal);
    budget.take('bytes' in read ? read.bytes.length : 0);
    if (budget.exceeded !== null) return found;
    if ('skip' in read) {
      skipped.push({ item: label, reason: read.skip });
      continue;
    }
    const secret =
      secretHit(entry.name, read.bytes) ??
      (basename(sourceReal) === entry.name ? null : secretHit(basename(sourceReal), read.bytes));
    if (secret !== null) {
      skipped.push({
        item: label,
        reason: `mozliwy sekret: ${secret.reason}${secret.line === null ? '' : ` (wiersz ${secret.line})`}`,
      });
      continue;
    }
    const parsed = parseContent(kind, read.bytes, name.name);
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
        ...linkNote(label, resolved.linked ? 1 : 0),
      ],
      flagged: [],
      filesSpec: null,
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
    flagged: [],
    filesSpec: null,
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
  const aliases = await buildAliasState(from);
  candidates.push(...(await scanSkills(from, budget, skipped, aliases)));
  if (budget.exceeded === null)
    candidates.push(...(await scanMarkdownDir(from, 'agents', 'agent', budget, skipped, aliases)));
  if (budget.exceeded === null)
    candidates.push(
      ...(await scanMarkdownDir(from, 'commands', 'command', budget, skipped, aliases)),
    );
  if (budget.exceeded === null) {
    const settings = await scanSettings(from, budget, skipped);
    if (settings !== null) candidates.push(settings);
  }
  if (budget.exceeded !== null) return { ok: false, message: budget.exceeded };
  return {
    ok: true,
    from,
    candidates: candidates.map((c) => (c.kind === 'settings' ? c : { ...c, nativeDir: from })),
    skipped,
  };
}
