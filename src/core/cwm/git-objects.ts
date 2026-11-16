import { createHash } from 'node:crypto';

import type { GitTreeLimits } from './git-source';
import { foldName } from './names';

/**
 * Czyste funkcje na obiektach git (ADR 0048): skrot obiektu, parsowanie commita i drzewa oraz
 * weryfikacja kopii pluginu wzgledem przypietego commita. Nic tu nie uruchamia procesu ani nie
 * dotyka dysku: `cwm start` i `cwm diff` sprawdzaja kopie offline, bez `git`. Wiazacy jest lancuch
 * skrotow: commit (rowny przypietemu) -> drzewo glowne -> drzewa -> bloby (pliki kopii).
 */

export type GitHashAlgorithm = 'sha1' | 'sha256';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Algorytm wynika z dlugosci przypietego SHA: 40 znakow to SHA-1, 64 to SHA-256. */
export function gitAlgorithmOf(id: string): GitHashAlgorithm | null {
  if (/^[0-9a-f]{40}$/.test(id)) return 'sha1';
  if (/^[0-9a-f]{64}$/.test(id)) return 'sha256';
  return null;
}

const rawIdLength = (algorithm: GitHashAlgorithm): number => (algorithm === 'sha1' ? 20 : 32);

/** Surowy obiekt git: `<typ> <dlugosc>\0<tresc>` (to, co jest skrotowane, bez kompresji). */
export function gitRawObject(type: string, body: Uint8Array): Uint8Array {
  const header = encoder.encode(`${type} ${body.length}\0`);
  const raw = new Uint8Array(header.length + body.length);
  raw.set(header, 0);
  raw.set(body, header.length);
  return raw;
}

/** Skrot obiektu: hash calego surowego obiektu (naglowek plus tresc). */
export function gitObjectId(algorithm: GitHashAlgorithm, type: string, body: Uint8Array): string {
  return createHash(algorithm).update(gitRawObject(type, body)).digest('hex');
}

const hashRaw = (algorithm: GitHashAlgorithm, raw: Uint8Array): string =>
  createHash(algorithm).update(raw).digest('hex');

/** Rozbija surowy obiekt na typ i tresc; null, gdy naglowek jest niepoprawny albo dlugosc sie nie zgadza. */
export function splitGitObject(raw: Uint8Array): { type: string; body: Uint8Array } | null {
  const nul = raw.indexOf(0);
  if (nul < 0 || nul > 32) return null;
  const header = new TextDecoder().decode(raw.subarray(0, nul));
  const match = /^(commit|tree|blob|tag) (0|[1-9][0-9]{0,9})$/.exec(header);
  if (match === null) return null;
  const body = raw.subarray(nul + 1);
  if (Number(match[2]) !== body.length) return null;
  return { type: match[1] ?? '', body };
}

/** Linia `tree <id>` na poczatku tresci commita; null, gdy jej brak albo id ma zla dlugosc. */
export function parseGitCommitTree(body: Uint8Array, idLength: number): string | null {
  const newline = body.indexOf(10);
  if (newline < 0) return null;
  const line = new TextDecoder().decode(body.subarray(0, newline));
  const match = /^tree ([0-9a-f]+)$/.exec(line);
  if (match === null || (match[1] ?? '').length !== idLength) return null;
  return match[1] ?? null;
}

export interface GitTreeEntry {
  /** Tryb tak, jak zapisuje go git w drzewie (`40000` dla katalogu, bez zera na poczatku). */
  readonly mode: string;
  readonly name: string;
  readonly id: string;
}

/** Nazwa wpisu (bajty UTF-8) i sciezka: z zapasem na nazwy tymczasowe zapisu i katalog roboczy (NAME_MAX 255, PATH_MAX 1024). */
const NAME_MAX_BYTES = 200;
const PATH_MAX_BYTES = 512;

const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Powod odrzucenia nazwy wpisu drzewa albo null. */
function entryNameProblem(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return 'niepoprawna nazwa wpisu drzewa';
  if (name.includes('/') || name.includes('\\')) return 'nazwa wpisu drzewa ze znakiem ukosnika';
  if (FORBIDDEN_NAME_CHARS.test(name)) return 'nazwa wpisu drzewa ze znakiem sterujacym';
  if (name.toLowerCase() === '.git') return 'wpis drzewa o nazwie .git';
  if (encoder.encode(name).length > NAME_MAX_BYTES) return 'zbyt dluga nazwa wpisu drzewa';
  return null;
}

/** Wpisy obiektu drzewa (`<tryb> <nazwa>\0<surowe id>`). Nazwy musza byc poprawnym UTF-8 i sie nie powtarzac. */
export function parseGitTree(
  body: Uint8Array,
  algorithm: GitHashAlgorithm,
): { ok: true; entries: GitTreeEntry[] } | { ok: false; message: string } {
  const idBytes = rawIdLength(algorithm);
  const entries: GitTreeEntry[] = [];
  const names = new Set<string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(32, at);
    const nul = space < 0 ? -1 : body.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + idBytes > body.length) {
      return { ok: false, message: 'uszkodzony obiekt drzewa' };
    }
    const mode = new TextDecoder().decode(body.subarray(at, space));
    if (!/^[0-7]{5,6}$/.test(mode)) return { ok: false, message: 'niepoprawny tryb w drzewie' };
    let name: string;
    try {
      name = decoder.decode(body.subarray(space + 1, nul));
    } catch {
      return { ok: false, message: 'nazwa wpisu drzewa nie jest poprawnym UTF-8' };
    }
    const problem = entryNameProblem(name);
    if (problem !== null) return { ok: false, message: problem };
    if (names.has(name)) return { ok: false, message: 'powtorzona nazwa wpisu drzewa' };
    names.add(name);
    const id = [...body.subarray(nul + 1, nul + 1 + idBytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    entries.push({ mode, name, id });
    at = nul + 1 + idBytes;
  }
  return { ok: true, entries };
}

/** Obiekt zwrocony przez `git cat-file --batch`. */
export interface GitBatchObject {
  readonly id: string;
  readonly type: string;
  readonly body: Uint8Array;
}

/**
 * Wyjscie `git cat-file --batch`: `<id> <typ> <rozmiar>\n<tresc>\n` na obiekt. Wpis `missing` to blad.
 * Id z naglowka nie jest zaufane: kazdy obiekt jest pozniej przeliczany na skrot.
 */
export function parseGitCatFileBatch(
  output: Uint8Array,
  idLength: number,
): { ok: true; objects: GitBatchObject[] } | { ok: false; message: string } {
  const objects: GitBatchObject[] = [];
  let at = 0;
  while (at < output.length) {
    const newline = output.indexOf(10, at);
    if (newline < 0 || newline - at > 200)
      return { ok: false, message: 'uszkodzone wyjscie cat-file' };
    const header = new TextDecoder().decode(output.subarray(at, newline));
    if (/ missing$/.test(header))
      return { ok: false, message: 'brak obiektu w pobranym repozytorium' };
    const match = new RegExp(
      `^([0-9a-f]{${idLength}}) (commit|tree|blob|tag) (0|[1-9][0-9]{0,9})$`,
    ).exec(header);
    if (match === null) return { ok: false, message: 'uszkodzony naglowek cat-file' };
    const size = Number(match[3]);
    const start = newline + 1;
    if (start + size + 1 > output.length || output[start + size] !== 10) {
      return { ok: false, message: 'uszkodzona tresc obiektu w cat-file' };
    }
    objects.push({
      id: match[1] ?? '',
      type: match[2] ?? '',
      body: output.subarray(start, start + size),
    });
    at = start + size + 1;
  }
  return { ok: true, objects };
}

export interface GitPlanEntry {
  readonly rel: string;
  /** Skrot bloba wskazany przez drzewo. */
  readonly id: string;
  readonly executable: boolean;
}

export type GitTreePlan =
  | {
      readonly ok: true;
      readonly entries: readonly GitPlanEntry[];
      /** Sciezki submoduli (tryb 160000): nie sa pobierane, wiec nie ma ich w kopii. */
      readonly submodules: readonly string[];
      /** Skroty obiektow lancucha: commit i wszystkie drzewa (kazdy raz). */
      readonly objectIds: ReadonlySet<string>;
      /** Suma rozmiarow surowych obiektow commita i drzew (licza sie do limitu rozmiaru). */
      readonly objectBytes: number;
    }
  | { readonly ok: false; readonly message: string };

const MAX_DEPTH = 16;
/** Gorna granica odwiedzonych wpisow: drzewo moze wskazywac to samo poddrzewo wiele razy (rozrost wykladniczy). */
const MAX_VISITED = 20_000;

/**
 * Lancuch od commita do blobow wylacznie z podanych obiektow (skrot kazdego jest przeliczany):
 * commit rowny `commit`, jego linia `tree`, kazde drzewo. Zwraca liste plikow, ktore ma miec kopia.
 */
export function planGitTree(
  commit: string,
  objects: ReadonlyMap<string, Uint8Array>,
  limits: GitTreeLimits,
): GitTreePlan {
  const fail = (message: string): GitTreePlan => ({ ok: false, message });
  const algorithm = gitAlgorithmOf(commit);
  if (algorithm === null) return fail('przypiety commit nie jest pelnym SHA');
  const objectIds = new Set<string>();
  let objectBytes = 0;

  const load = (id: string, type: string): { body: Uint8Array } | string => {
    const raw = objects.get(id);
    if (raw === undefined) return `brak obiektu ${type} ${id.slice(0, 12)} w zapisanych obiektach`;
    if (hashRaw(algorithm, raw) !== id) {
      return `obiekt ${type} ${id.slice(0, 12)} ma inny skrot niz oczekiwany`;
    }
    const split = splitGitObject(raw);
    if (split === null || split.type !== type) {
      return `obiekt ${id.slice(0, 12)} nie jest poprawnym obiektem typu ${type}`;
    }
    if (!objectIds.has(id)) {
      objectIds.add(id);
      objectBytes += raw.length;
    }
    return { body: split.body };
  };

  const commitObject = load(commit, 'commit');
  if (typeof commitObject === 'string') return fail(commitObject);
  const rootId = parseGitCommitTree(commitObject.body, commit.length);
  if (rootId === null) return fail('commit nie ma poprawnej linii tree');

  const entries: GitPlanEntry[] = [];
  const submodules: string[] = [];
  let visited = 0;
  const walk = (treeId: string, prefix: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) return 'drzewo zbyt gleboke';
    const tree = load(treeId, 'tree');
    if (typeof tree === 'string') return tree;
    const parsed = parseGitTree(tree.body, algorithm);
    if (!parsed.ok) return parsed.message;
    for (const entry of parsed.entries) {
      visited += 1;
      if (visited > MAX_VISITED) return 'za duzo wpisow w drzewach commita';
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        const problem = walk(entry.id, rel, depth + 1);
        if (problem !== null) return problem;
      } else if (entry.mode === '160000') {
        submodules.push(rel);
      } else if (entry.mode === '100644' || entry.mode === '100664' || entry.mode === '100755') {
        // 100664 to dawny tryb zapisywany przez stare wersje git: zwykly plik bez bitu wykonywania.
        if (encoder.encode(rel).length > PATH_MAX_BYTES) return 'zbyt dluga sciezka w drzewie';
        entries.push({ rel, id: entry.id, executable: entry.mode === '100755' });
        if (entries.length > limits.files) return `wiecej niz ${limits.files} plikow`;
      } else if (entry.mode === '120000') {
        return 'dowiazanie symboliczne w repozytorium';
      } else {
        return `nieobslugiwany tryb ${entry.mode} w drzewie`;
      }
    }
    return null;
  };
  const problem = walk(rootId, '', 0);
  if (problem !== null) return fail(problem);
  if (entries.length === 0) return fail('commit nie zawiera zadnego pliku');
  // Ta sama kontrola co `readTree`: nazwy rozniace sie tylko wielkoscia liter albo normalizacja Unicode.
  const folded = new Set<string>();
  for (const entry of entries) {
    const key = entry.rel.split('/').map(foldName).join('/');
    if (folded.has(key)) return fail(`kolizja wielkosci liter: ${printable(entry.rel)}`);
    folded.add(key);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { ok: true, entries, submodules, objectIds, objectBytes };
}

export interface GitCopyFile {
  readonly rel: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export type GitCopyVerdict =
  | { readonly ok: true; readonly files: number; readonly submodules: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Kopia pluginu jest dokladnie tym, co wynika z przypietego commita: lancuch obiektow sie zgadza,
 * zbior sciezek i tryby wykonywania sa te same, a kazdy plik ma skrot bloba z drzewa. Nadmiarowy
 * obiekt, brakujacy albo dodatkowy plik to odmowa. Limity jak dla `readTree`; obiekty drzew licza sie
 * do limitu rozmiaru.
 */
export function verifyGitCopy(
  commit: string,
  objects: ReadonlyMap<string, Uint8Array>,
  files: readonly GitCopyFile[],
  limits: GitTreeLimits,
): GitCopyVerdict {
  const fail = (message: string): GitCopyVerdict => ({ ok: false, message });
  const algorithm = gitAlgorithmOf(commit);
  if (algorithm === null) return fail('przypiety commit nie jest pelnym SHA');
  const plan = planGitTree(commit, objects, limits);
  if (!plan.ok) return fail(plan.message);
  for (const id of objects.keys()) {
    if (!plan.objectIds.has(id))
      return fail(`nadmiarowy obiekt ${id.slice(0, 12)} w zapisanych obiektach`);
  }
  if (files.length !== plan.entries.length) {
    return fail(
      `liczba plikow kopii (${files.length}) rozni sie od liczby w commicie (${plan.entries.length})`,
    );
  }
  const byRel = new Map(files.map((file) => [file.rel, file]));
  let bytes = plan.objectBytes;
  for (const entry of plan.entries) {
    const file = byRel.get(entry.rel);
    if (file === undefined) return fail(`brak pliku w kopii: ${printable(entry.rel)}`);
    if (file.executable !== entry.executable) {
      return fail(`bit wykonywania rozni sie od commita: ${printable(entry.rel)}`);
    }
    if (file.bytes.length > limits.fileBytes)
      return fail(`plik wiekszy niz limit: ${printable(entry.rel)}`);
    bytes += file.bytes.length;
    if (bytes > limits.bytes) return fail('drzewo wieksze niz limit');
    if (gitObjectId(algorithm, 'blob', file.bytes) !== entry.id) {
      return fail(`tresc pliku rozni sie od bloba w commicie: ${printable(entry.rel)}`);
    }
  }
  return { ok: true, files: files.length, submodules: plan.submodules };
}

/** Sciezka do komunikatu: znaki sterujace jako `?`, krotko. */
function printable(text: string): string {
  const clean = [...text].map((ch) => (FORBIDDEN_NAME_CHARS.test(ch) ? '?' : ch)).join('');
  return clean.length > 80 ? `${clean.slice(0, 80)}...` : clean;
}
