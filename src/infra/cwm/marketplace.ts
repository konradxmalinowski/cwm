import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  MARKETPLACE_CATALOG_FILE,
  MAX_MARKETPLACE_BYTES,
  parseMarketplaceCatalog,
  selectMarketplacePlugin,
  type MarketplaceCatalog,
  type MarketplaceFacts,
  type MarketplaceSource,
} from '../../core/cwm';
import { parentRejection } from './engine-process';
import { lstatLoose } from './paths';
import { readTextWithin } from './read';
import { realInside, type TreeFile } from './runtime-sources';

/**
 * Lokalny marketplace pluginow (ADR 0043). Tylko odczyt: katalog jest zaufany przez uzytkownika
 * (rejestruje go jawnie), ale tresc pluginu nie, wiec to, co stad wychodzi, idzie dalej tym samym
 * torem co plugin `local` (drzewo, skan, zatwierdzenie).
 */

export interface LoadedMarketplace {
  readonly name: string;
  /** Katalog marketplace'u po `realpath`. */
  readonly root: string;
  readonly catalog: MarketplaceCatalog;
}

export type MarketplaceLoad =
  | { readonly ok: true; readonly marketplace: LoadedMarketplace }
  | { readonly ok: false; readonly reason: string };

const currentUid = (): number | null =>
  typeof process.getuid === 'function' ? process.getuid() : null;

/**
 * Wpis (katalog albo plik) musi nalezec do biezacego uzytkownika i nie byc zapisywalny dla grupy
 * i innych: kto moze w nim zapisywac, moze podmienic tresc miedzy zatwierdzeniem a uzyciem.
 * Na Windowsie (brak uid) kontrola nie dziala; `cwm start` i tak tam odmawia.
 */
function ownerRejection(
  info: { readonly uid: number; readonly mode: number },
  uid: number | null,
): string | null {
  if (uid === null) return null;
  if (info.uid !== uid) return 'wlasciciel to ktos inny niz biezacy uzytkownik';
  if ((info.mode & 0o022) !== 0) return 'zapisywalny dla grupy lub innych';
  return null;
}

/** Katalog po `realpath`: istnieje, jest katalogiem, nalezy do uzytkownika, a jego rodzic tez jest bezpieczny. */
async function trustedDirectory(real: string, uid: number | null): Promise<string | null> {
  const info = await lstatLoose(real);
  if (info === null || !info.isDirectory()) return 'to nie jest katalog';
  const own = ownerRejection(info, uid);
  if (own !== null) return own;
  return uid === null ? null : parentRejection(real, uid);
}

/**
 * Wczytuje marketplace: katalog bezwzgledny, po `realpath` wlasnosc uzytkownika bez zapisu dla
 * grupy i innych (jak plik silnika), `.claude-plugin/marketplace.json` z limitem bajtow przed
 * dekodowaniem, ostra walidacja i zgodnosc nazwy z rejestracja.
 */
export async function loadMarketplace(
  name: string,
  source: MarketplaceSource,
): Promise<MarketplaceLoad> {
  const refuse = (reason: string): MarketplaceLoad => ({ ok: false, reason });
  if (!isAbsolute(source.path)) return refuse("sciezka marketplace'u nie jest bezwzgledna");
  let root: string;
  try {
    root = await realpath(source.path);
  } catch {
    return refuse("katalog marketplace'u nie istnieje albo jest nieczytelny");
  }
  const uid = currentUid();
  const dirProblem = await trustedDirectory(root, uid);
  if (dirProblem !== null) return refuse(`katalog marketplace'u: ${dirProblem}`);

  const file = join(root, MARKETPLACE_CATALOG_FILE);
  for (const path of [join(root, '.claude-plugin'), file]) {
    const info = await lstatLoose(path);
    if (info === null) return refuse(`brak ${MARKETPLACE_CATALOG_FILE}`);
    if (info.isSymbolicLink()) return refuse(`${MARKETPLACE_CATALOG_FILE}: dowiazanie symboliczne`);
    const problem = ownerRejection(info, uid);
    if (problem !== null) return refuse(`${MARKETPLACE_CATALOG_FILE}: ${problem}`);
  }
  const read = await readTextWithin(root, file, MAX_MARKETPLACE_BYTES);
  if (!read.ok) return refuse(`${MARKETPLACE_CATALOG_FILE}: ${read.message.replace(/\.+$/, '')}`);
  const parsed = parseMarketplaceCatalog(read.text);
  if (!parsed.ok) {
    const first = parsed.errors[0];
    return refuse(
      `${MARKETPLACE_CATALOG_FILE}: ${first === undefined ? 'niepoprawny' : `${first.path}: ${first.message.replace(/\.+$/, '')}`}`,
    );
  }
  if (parsed.value.name !== name) {
    return refuse(
      `nazwa w marketplace.json ("${parsed.value.name}") rozni sie od zarejestrowanej ("${name}")`,
    );
  }
  return { ok: true, marketplace: { name, root, catalog: parsed.value } };
}

export type MarketplacePluginResolution =
  | {
      readonly ok: true;
      /** Katalog pluginu po `realpath`, wewnatrz marketplace'u. */
      readonly dir: string;
      readonly facts: MarketplaceFacts;
      readonly version: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Katalog pluginu z segmentow `source`: kazdy skladnik sciezki to zwykly katalog (dowiazanie
 * choćby wewnatrz marketplace'u jest odmowa), nalezy do uzytkownika i nie jest zapisywalny dla
 * grupy i innych, a wynik po `realpath` lezy w marketplace'ie.
 */
async function pluginDirectory(
  root: string,
  parts: readonly string[],
): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
  const uid = currentUid();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info: Awaited<ReturnType<typeof lstatLoose>>;
    try {
      info = await lstatLoose(current);
    } catch {
      return { ok: false, reason: 'sciezka pluginu jest nieczytelna albo zbyt dluga' };
    }
    if (info === null) return { ok: false, reason: 'katalog pluginu nie istnieje' };
    if (info.isSymbolicLink()) {
      return { ok: false, reason: `dowiazanie symboliczne na sciezce pluginu (${part})` };
    }
    if (!info.isDirectory()) return { ok: false, reason: `${part} nie jest katalogiem` };
    const problem = ownerRejection(info, uid);
    if (problem !== null) return { ok: false, reason: `katalog ${part}: ${problem}` };
  }
  const real = await realInside(root, current);
  if (real === null) return { ok: false, reason: 'katalog pluginu wychodzi poza marketplace' };
  return { ok: true, dir: real };
}

/** Rozwiazuje `source.marketplace` + `source.plugin` do katalogu pluginu i pol zatwierdzenia. */
export async function resolveMarketplacePlugin(
  marketplaces: Readonly<Record<string, MarketplaceSource>> | undefined,
  marketplace: string,
  plugin: string,
): Promise<MarketplacePluginResolution> {
  const refuse = (reason: string): MarketplacePluginResolution => ({ ok: false, reason });
  const source =
    marketplaces !== undefined && Object.hasOwn(marketplaces, marketplace)
      ? marketplaces[marketplace]
      : undefined;
  if (source === undefined) {
    return refuse(
      `marketplace "${marketplace}" nie jest zarejestrowany (cwm marketplace add ${marketplace} <katalog>)`,
    );
  }
  const loaded = await loadMarketplace(marketplace, source);
  if (!loaded.ok) return refuse(`marketplace "${marketplace}": ${loaded.reason}`);
  const selected = selectMarketplacePlugin(loaded.marketplace.catalog, plugin);
  if (!selected.ok) return refuse(selected.reason);
  const dir = await pluginDirectory(loaded.marketplace.root, selected.parts);
  if (!dir.ok) return refuse(`plugin "${plugin}" w marketplace "${marketplace}": ${dir.reason}`);
  return {
    ok: true,
    dir: dir.dir,
    version: selected.plugin.version,
    facts: {
      marketplace,
      plugin: selected.plugin.name,
      declaredSource: selected.plugin.declaredSource,
      marketplaceRoot: loaded.marketplace.root,
      resolvedPath: dir.dir,
    },
  };
}

/**
 * Kontrola po odczycie drzewa: katalog pluginu nadal rozwiazuje sie do tej samej sciezki. Podmiana
 * skladnika sciezki na dowiazanie w trakcie odczytu (wymaga prawa zapisu, ktorego kontrola
 * wlasciciela odmawia innym) konczy sie bledem zamiast zatwierdzeniem cudzych plikow.
 */
export async function directoryUnchanged(dir: string): Promise<boolean> {
  try {
    return (await realpath(dir)) === dir;
  } catch {
    return false;
  }
}

/** `version` z `.claude-plugin/plugin.json` w drzewie pluginu; null, gdy brak pliku, pola albo JSON jest nieczytelny. */
export function pluginJsonVersion(files: readonly TreeFile[]): string | null {
  const file = files.find((f) => f.rel.toLowerCase() === '.claude-plugin/plugin.json');
  if (file === undefined) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(file.bytes)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const version = (parsed as Record<string, unknown>)['version'];
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Ostrzezenia o rozjezdzie wersji (nie blokuja): wersja zasobu, wpis marketplace'u i plugin.json. */
export function versionWarnings(
  label: string,
  resourceVersion: string,
  entryVersion: string | null,
  files: readonly TreeFile[],
): string[] {
  const warnings: string[] = [];
  const manifestVersion = pluginJsonVersion(files);
  if (manifestVersion !== null && manifestVersion !== resourceVersion) {
    warnings.push(
      `${label}: wersja w plugin.json (${manifestVersion}) rozni sie od wersji zasobu (${resourceVersion}).`,
    );
  }
  if (entryVersion !== null && entryVersion !== resourceVersion) {
    warnings.push(
      `${label}: wersja we wpisie marketplace'u (${entryVersion}) rozni sie od wersji zasobu (${resourceVersion}).`,
    );
  }
  return warnings;
}
