import { diffLines, redactJsonEnv, splitLines } from '../../core/cwm';
import { classifyFileName, classifyStrict } from '../../core/services/security/secret-classifier';
import {
  changedKeys,
  cleanupAreas,
  expectedMode,
  loadGenerationManifest,
  type ManifestFile,
} from './runtime-apply';
import { readRuntimeFile, type RuntimeRoot } from './runtime-fs';
import type { PlannedFile, RuntimePlan } from './runtime-plan';
import { sha256Hex } from './runtime-sources';

/**
 * Porownanie planu z profilem na dysku (`cwm diff`). Tylko odczyt: korzysta z `readRuntimeFile`,
 * `loadGenerationManifest` i planu zbudowanego w pamieci, nie bierze zamka i niczego nie tworzy.
 * Decyzje (co zostanie dodane, zmienione, usuniete, nadpisane) odtwarzaja `applyPlan`, zeby wynik
 * mowil to samo, co zrobi `cwm start`.
 */

/** Plik tekstowy do tylu wierszy (po obu stronach) dostaje ujednolicony diff, wiekszy tylko liczniki. */
export const DIFF_MAX_LINES = 200;
const CONTEXT_LINES = 3;
const MAX_TEXT_BYTES = 512 * 1024;

export type DiffStatus = 'added' | 'changed' | 'removed';
export type DiffArea = 'profile' | 'session' | 'plugin';

export interface FileDiff {
  readonly path: string;
  readonly area: DiffArea;
  readonly status: DiffStatus;
  /** Plik na dysku rozni sie od manifestu (albo go w nim nie ma): zmieniony poza CWM. */
  readonly outsideCwm: boolean;
  /** Co zrobi `cwm start` z tym plikiem. */
  readonly action: string;
  readonly oldSize: number | null;
  readonly newSize: number | null;
  readonly oldSha256: string | null;
  readonly newSha256: string | null;
  /** Rozni sie tylko tryb pliku (0600/0700). */
  readonly modeOnly: boolean;
  readonly lines: { readonly added: number; readonly removed: number } | null;
  readonly approximate: boolean;
  /** Wiersze ujednoliconego diffu; `null` gdy plik jest za dlugi, binarny, ukryty albo to nie zmiana. */
  readonly hunks: readonly string[] | null;
  /** Powod, dla ktorego nie pokazujemy tresci (mozliwy sekret, binarny, za dlugi). */
  readonly hidden: string | null;
  readonly notes: readonly string[];
  readonly owner: string | null;
}

export interface PluginDiff {
  /** Id pluginu bez skrotu drzewa. */
  readonly id: string;
  readonly status: DiffStatus;
  readonly from: string | null;
  readonly to: string | null;
  readonly files: { readonly added: number; readonly changed: number; readonly removed: number };
}

export interface KeptFile {
  readonly path: string;
  readonly reason: string;
}

export interface RuntimeDiff {
  /** Katalog firmy w `runtime/` istnieje. */
  readonly rootExists: boolean;
  readonly manifestState: 'ok' | 'missing' | 'corrupt';
  readonly files: readonly FileDiff[];
  readonly plugins: readonly PluginDiff[];
  /** Pliki z manifestu, ktore start zostawi, bo zmieniono je poza CWM. */
  readonly kept: readonly KeptFile[];
  /** Powody, dla ktorych `applyPlan` odmowilby zapisu (kolizja z plikiem spoza CWM, niebezpieczny plik). */
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly unchanged: number;
}

export interface DiffOptions {
  /** Bez wierszy diffu (`--stat`): same liczniki. */
  readonly stat: boolean;
  /** Migawki pluginow uzywane przez trwajace sesje: start ich nie sprzata. */
  readonly livePlugins: ReadonlySet<string>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function areaKind(rel: string): DiffArea {
  return rel.startsWith('claude/') ? 'profile' : rel.startsWith('plugins/') ? 'plugin' : 'session';
}

/** Plik JSON z kluczami `env` (profil, uruchomienie, mcp.json): zawartosc `env` nigdy nie idzie na ekran. */
const isJsonConfig = (rel: string): boolean => rel.endsWith('.json');

interface Described {
  readonly lines: { added: number; removed: number } | null;
  readonly approximate: boolean;
  readonly hunks: readonly string[] | null;
  readonly hidden: string | null;
  readonly notes: readonly string[];
}

const HIDDEN: Described = {
  lines: null,
  approximate: false,
  hunks: null,
  hidden: null,
  notes: [],
};

/** Opis zmiany tresci pliku (disk -> plan). Bez tresci przy mozliwym sekrecie i pliku binarnym. */
function describeChange(
  rel: string,
  before: Uint8Array,
  after: Uint8Array,
  wantHunks: boolean,
): Described {
  if (classifyFileName(rel) !== null) return { ...HIDDEN, hidden: 'mozliwy sekret (nazwa pliku)' };
  let a = decodeText(before);
  let b = decodeText(after);
  if (a === null || b === null) return { ...HIDDEN, hidden: 'plik binarny' };
  if (before.length > MAX_TEXT_BYTES || after.length > MAX_TEXT_BYTES) {
    return { ...HIDDEN, hidden: 'plik wiekszy niz 512 KiB' };
  }
  const notes: string[] = [];
  if (isJsonConfig(rel)) {
    const ra = redactJsonEnv(a);
    const rb = redactJsonEnv(b);
    if (ra !== null && rb !== null) {
      if (ra.envSignature !== rb.envSignature) notes.push('env zmieniony (tresc ukryta)');
      a = ra.text;
      b = rb.text;
    }
  }
  if (
    classifyStrict([
      { relPath: rel, bytes: new TextEncoder().encode(a) },
      { relPath: rel, bytes: new TextEncoder().encode(b) },
    ]).length > 0
  ) {
    return { ...HIDDEN, hidden: 'mozliwy sekret w tresci', notes };
  }
  const short = Math.max(splitLines(a).length, splitLines(b).length) <= DIFF_MAX_LINES;
  const diff = diffLines(a, b, { context: CONTEXT_LINES, hunks: wantHunks && short });
  const extra =
    short || !wantHunks ? [] : [`plik dluzszy niz ${DIFF_MAX_LINES} wierszy: tylko liczniki`];
  return {
    lines: { added: diff.added, removed: diff.removed },
    approximate: diff.approximate,
    hunks: diff.hunks,
    hidden: null,
    notes: [...notes, ...extra],
  };
}

const pluginIdOf = (slug: string): string => slug.slice(0, slug.lastIndexOf('@'));
const slugOfRel = (rel: string): string => rel.split('/')[1] ?? '';

/**
 * Porownuje plan z profilem. `root` to `null`, gdy katalogu firmy nie ma: wszystko jest wtedy dodane.
 * Odczyty ida przez `readRuntimeFile`, wiec dowiazania i niebezpieczne sciezki sa odrzucane tak samo
 * jak przy zapisie.
 */
export async function diffRuntime(
  root: RuntimeRoot | null,
  plan: RuntimePlan,
  options: DiffOptions,
): Promise<RuntimeDiff> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const loaded =
    root === null ? { manifest: null, corrupt: false } : await loadGenerationManifest(root);
  if (loaded.corrupt) {
    warnings.push(
      'manifest generowania jest uszkodzony: start nie usunie niczego, a pliki spoza planu zostana',
    );
  }
  const prev: readonly ManifestFile[] = loaded.manifest?.files ?? [];
  const prevByPath = new Map(prev.map((f) => [f.path, f]));
  const desired = new Map(plan.files.map((f) => [f.rel, f]));
  const areas = cleanupAreas(plan, prev, options.livePlugins);

  const files: FileDiff[] = [];
  const kept: KeptFile[] = [];
  let unchanged = 0;

  const read = async (rel: string): ReturnType<typeof readRuntimeFile> =>
    root === null ? { kind: 'missing' } : await readRuntimeFile(root, rel);

  // Pliki planu: dodane, zmienione, bez zmian.
  const pluginTouched = new Map<string, { added: number; changed: number }>();
  const touchPlugin = (rel: string, kind: 'added' | 'changed'): void => {
    const slug = slugOfRel(rel);
    const entry = pluginTouched.get(slug) ?? { added: 0, changed: 0 };
    entry[kind] += 1;
    pluginTouched.set(slug, entry);
  };
  const pushFile = (item: FileDiff): void => {
    if (item.area === 'plugin')
      touchPlugin(item.path, item.status === 'added' ? 'added' : 'changed');
    else files.push(item);
  };

  for (const file of plan.files) {
    const disk = await read(file.rel);
    const area = areaKind(file.rel);
    const base = {
      path: file.rel,
      area,
      newSize: file.bytes.length,
      newSha256: file.sha256,
      owner: file.owner ?? null,
    };
    if (disk.kind === 'unsafe') {
      blockers.push(`Niebezpieczny plik w profilu: ${file.rel}`);
      continue;
    }
    if (disk.kind === 'missing') {
      pushFile({
        ...base,
        status: 'added',
        outsideCwm: false,
        action: 'start utworzy plik',
        oldSize: null,
        oldSha256: null,
        modeOnly: false,
        lines: null,
        approximate: false,
        hunks: null,
        hidden: null,
        notes: [],
      });
      continue;
    }
    const diskSha = sha256Hex(disk.bytes);
    if (diskSha === file.sha256) {
      if (disk.mode === expectedMode(file.executable)) {
        unchanged += 1;
      } else {
        pushFile({
          ...base,
          status: 'changed',
          outsideCwm: false,
          action: 'start poprawi tryb pliku',
          oldSize: disk.bytes.length,
          oldSha256: diskSha,
          modeOnly: true,
          lines: null,
          approximate: false,
          hunks: null,
          hidden: null,
          notes: [
            `tryb ${disk.mode.toString(8)} zamiast ${expectedMode(file.executable).toString(8)}`,
          ],
        });
      }
      continue;
    }
    const owned = prevByPath.get(file.rel);
    const isSettings = file.rel === 'claude/settings.json';
    if (owned === undefined && !isSettings) {
      blockers.push(
        `Plik ${file.rel} istnieje i nie pochodzi z CWM: start odmowi zapisu (usun go albo przenies).`,
      );
      continue;
    }
    const outside = owned === undefined || owned.sha256 !== diskSha;
    const described = describeChange(file.rel, disk.bytes, file.bytes, !options.stat);
    const notes = [...described.notes];
    if (isSettings) {
      notes.push(`zmienione klucze: ${changedKeys(disk.bytes, file.bytes).join(', ') || '-'}`);
    }
    pushFile({
      ...base,
      status: 'changed',
      outsideCwm: outside,
      action: outside
        ? 'start nadpisze plik zmieniony poza CWM (kopia w generated/prev)'
        : 'start zastapi plik (poprzednia wersja w generated/prev)',
      oldSize: disk.bytes.length,
      oldSha256: diskSha,
      modeOnly: false,
      ...described,
      notes,
    });
  }

  // Pliki z poprzedniego manifestu, ktorych plan juz nie ma.
  const removedByPlugin = new Map<string, { removed: number; paths: ManifestFile[] }>();
  for (const entry of prev) {
    if (!areas.has(entry.area) || desired.has(entry.path)) continue;
    const disk = await read(entry.path);
    if (disk.kind === 'missing') continue;
    if (disk.kind === 'unsafe') {
      warnings.push(`${entry.path}: start pominie przy sprzataniu (niebezpieczny)`);
      continue;
    }
    const diskSha = sha256Hex(disk.bytes);
    if (diskSha !== entry.sha256) {
      kept.push({ path: entry.path, reason: 'zmieniony poza CWM, start zostawi go na miejscu' });
      continue;
    }
    if (entry.path.startsWith('plugins/')) {
      const slug = slugOfRel(entry.path);
      const bucket = removedByPlugin.get(slug) ?? { removed: 0, paths: [] };
      bucket.removed += 1;
      bucket.paths.push(entry);
      removedByPlugin.set(slug, bucket);
      continue;
    }
    files.push({
      path: entry.path,
      area: areaKind(entry.path),
      status: 'removed',
      outsideCwm: false,
      action: 'start usunie plik (kopia w generated/prev)',
      oldSize: disk.bytes.length,
      newSize: null,
      oldSha256: diskSha,
      newSha256: null,
      modeOnly: false,
      lines: null,
      approximate: false,
      hunks: null,
      hidden: null,
      notes: [],
      owner: null,
    });
  }

  // Migawki pluginow: jeden wpis na plugin (stara i nowa migawka tego samego pluginu to jedna zmiana).
  const plugins: PluginDiff[] = [];
  const planBySlug = new Map<string, PlannedFile[]>();
  for (const file of plan.files) {
    if (!file.rel.startsWith('plugins/')) continue;
    const slug = slugOfRel(file.rel);
    planBySlug.set(slug, [...(planBySlug.get(slug) ?? []), file]);
  }
  const staleLeft = new Map(removedByPlugin);
  for (const [slug, touched] of [...pluginTouched].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const id = pluginIdOf(slug);
    const old = [...staleLeft].find(([oldSlug]) => pluginIdOf(oldSlug) === id);
    if (old !== undefined) staleLeft.delete(old[0]);
    const prefix = `plugins/${slug}/`;
    const fresh = planBySlug.get(slug) ?? [];
    const oldFiles = old === undefined ? [] : old[1].paths;
    const oldByRel = new Map(
      oldFiles.map((f) => [f.path.slice(`plugins/${old?.[0] ?? ''}/`.length), f]),
    );
    const newByRel = new Map(fresh.map((f) => [f.rel.slice(prefix.length), f]));
    let changed = 0;
    let removed = 0;
    for (const [rel, f] of oldByRel) {
      const now = newByRel.get(rel);
      if (now === undefined) removed += 1;
      else if (now.sha256 !== f.sha256) changed += 1;
    }
    const addedNow =
      old === undefined
        ? touched.added + touched.changed
        : [...newByRel.keys()].filter((rel) => !oldByRel.has(rel)).length;
    plugins.push({
      id,
      status: old === undefined ? 'added' : 'changed',
      from: old?.[0] ?? null,
      to: slug,
      files: { added: addedNow, changed, removed },
    });
  }
  for (const [slug, bucket] of [...staleLeft].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    plugins.push({
      id: pluginIdOf(slug),
      status: 'removed',
      from: slug,
      to: null,
      files: { added: 0, changed: 0, removed: bucket.removed },
    });
  }

  const order: Record<DiffStatus, number> = { added: 0, changed: 1, removed: 2 };
  files.sort((x, y) => order[x.status] - order[y.status] || (x.path < y.path ? -1 : 1));
  return {
    rootExists: root !== null,
    manifestState: loaded.corrupt ? 'corrupt' : loaded.manifest === null ? 'missing' : 'ok',
    files,
    plugins,
    kept,
    blockers,
    warnings,
    unchanged,
  };
}
