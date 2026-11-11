import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path, { isAbsolute, join, resolve } from 'node:path';

/**
 * Harness izolacji testow, przeniesiony z generatora (ARCHITECTURE 12.2).
 * Trzy rzeczy, ktore ma robic:
 *
 * 1. Odmowic startu, jesli katalog bazowy testow lezy w zywej konfiguracji
 *    wlasciciela albo jest katalogiem domowym.
 * 2. Policzyc odcisk kontrolny plikow wlasciciela przed i po przebiegu
 *    i porownac je na koncu (kanarek).
 * 3. Dac kazdemu testowi wlasne drzewo tymczasowe.
 *
 * Koszt tego mechanizmu jest zerowy, a stawka w tym projekcie jest wyzsza niz
 * w generatorze: aplikacja ma prawo zapisu do katalogow konfiguracyjnych.
 */

export const OWNER_CONFIG_ROOTS = ['.claude', '.codex', '.agents'] as const;

const OWNER_FILES = [
  '.claude.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/CLAUDE.md',
  '.codex/config.toml',
  '.codex/hooks.json',
  '.codex/AGENTS.md',
] as const;

const OWNER_DIRS = [
  '.claude',
  '.claude/agents',
  '.claude/skills',
  '.claude/commands',
  '.codex',
  '.codex/agents',
  '.codex/skills',
  '.agents',
] as const;

/**
 * Minimalny kontrakt na modul `path`. Istnieje po to, zeby test mogl podstawic
 * `path.win32` i sprawdzic semantyke Windowsa na dowolnym systemie.
 */
export interface PathApi {
  resolve(...segments: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(value: string): boolean;
}

/**
 * Czy `child` lezy w `parent`.
 *
 * Wartownik `isAbsolute` nie jest ozdoba: na Windowsie `path.relative` miedzy
 * sciezkami na roznych dyskach nie zwraca `..`, tylko gotowa sciezke absolutna
 * do celu. Bez tego sprawdzenia `D:\\a\\repo` wychodzilo jako lezace
 * w `C:\\Users\\x\\.claude`, czyli bezpiecznik blokowal caly obszar roboczy CI.
 * Regula pochodzi z generatora i tam byla kompletna - tu zostala zgubiona
 * i przywrocona po awarii na runnerze Windows.
 */
export function isInsideWith(pathApi: PathApi, child: string, parent: string): boolean {
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !pathApi.isAbsolute(rel);
}

export function isInside(child: string, parent: string): boolean {
  return isInsideWith(path, child, parent);
}

/**
 * Katalog domowy wlasciciela. `os.homedir()` czyta `USERPROFILE` na Windowsie
 * i `HOME` na POSIX, ale moze zwrocic pusta wartosc, jesli zadnego z nich nie
 * ma. Wtedy bezpiecznik ma powiedziec wprost, ze nie zdolal ustalic katalogu
 * domowego, a nie ze baza testow lezy w zywej konfiguracji - mylacy komunikat
 * kosztuje pol godziny czytania logu.
 */
const UNKNOWN_HOME_MESSAGE =
  'nie udalo sie ustalic katalogu domowego (pusty os.homedir(), brak USERPROFILE i HOME) - ' +
  'bezpiecznik testow odmawia startu, bo nie ma jak sprawdzic, czy katalog bazowy jest poza ' +
  'konfiguracja wlasciciela';

export function resolveHomeDir(): string {
  const candidates = [safeHomedir(), process.env['USERPROFILE'], process.env['HOME']];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && isAbsolute(candidate)) {
      return resolve(candidate);
    }
  }
  throw new Error(UNKNOWN_HOME_MESSAGE);
}

/**
 * Podany katalog domowy musi byc uzywalny. Pusta albo relatywna wartosc
 * znaczy, ze nie wiemy, gdzie jest konfiguracja wlasciciela - a wtedy jedyna
 * uczciwa odpowiedz to odmowa z komunikatem o niewiedzy, nie o trafieniu.
 */
function usableHome(home: string): string {
  if (home === '' || !isAbsolute(home)) throw new Error(UNKNOWN_HOME_MESSAGE);
  return resolve(home);
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

export function assertTestBaseIsSafe(base: string, home?: string): void {
  const resolvedBase = resolve(base);
  const resolvedHome = home === undefined ? resolveHomeDir() : usableHome(home);

  if (resolvedBase === resolvedHome) {
    throw new Error('katalog bazowy testow nie moze byc katalogiem domowym');
  }

  for (const root of OWNER_CONFIG_ROOTS) {
    const live = join(resolvedHome, root);
    if (resolvedBase === live || isInside(resolvedBase, live)) {
      throw new Error(
        `katalog bazowy testow ${resolvedBase} lezy w zywej konfiguracji ~/${root} - przerywam`,
      );
    }
  }
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function hashDirEntries(path: string): string | null {
  try {
    const entries = readdirSync(path, { withFileTypes: true })
      .map((entry) => {
        const kind = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f';
        let size = '';
        if (kind === 'f') {
          try {
            size = String(statSync(join(path, entry.name)).size);
          } catch {
            size = '?';
          }
        }
        return `${kind}:${entry.name}:${size}`;
      })
      .sort();
    return createHash('sha256').update(entries.join('\n')).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Odcisk kontrolny: tresc kilku plikow wlasciciela plus lista wpisow w jego
 * katalogach konfiguracyjnych. Odczyt, nigdy zapis.
 *
 * Ograniczenie, swiadome: lista wpisow jest jednopoziomowa, wiec zmiana
 * zagniezdzona glebiej w ~/.claude/skills/<skill>/ nie zostanie zauwazona.
 * Pelne przejscie drzewa kosztowaloby przy kazdym przebiegu testow wiecej, niz
 * jest warte, bo zapis do konfiguracji wlasciciela i tak nie ma w tym etapie
 * zadnej sciezki w kodzie.
 */
export function ownerFingerprint(home: string = homedir()): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const file of OWNER_FILES) {
    out[`file:${file}`] = hashFile(join(home, file));
  }
  for (const dir of OWNER_DIRS) {
    out[`dir:${dir}`] = hashDirEntries(join(home, dir));
  }
  return out;
}

export function diffFingerprints(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): string[] {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

export function resolveTestBase(): string {
  const override = process.env['CWM_TEST_TMPDIR'];
  if (override !== undefined && override !== '') return resolve(override);
  return resolve(join(process.cwd(), 'tests', '.tmp'));
}

export function ensureTestBase(base: string = resolveTestBase()): string {
  assertTestBaseIsSafe(base);
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return base;
}

const createdTrees: string[] = [];

/** Kazdy test dostaje wlasne drzewo. Nazwy syntetyczne, konwencja acme-* (ADR 0004). */
export function createTempTree(prefix = 'acme-case-'): string {
  const base = ensureTestBase();
  const dir = mkdtempSync(join(base, prefix));
  createdTrees.push(dir);
  return dir;
}

export function removeTempTrees(): void {
  const base = resolveTestBase();
  while (createdTrees.length > 0) {
    const dir = createdTrees.pop();
    if (dir === undefined) continue;
    if (!isInside(dir, base)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}
