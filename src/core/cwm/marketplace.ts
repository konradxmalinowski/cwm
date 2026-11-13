import { Checker, CONTROL_CHARS, field, isPlainObject, type PlainObject } from './check';
import { escapeControlChars, fail, ok, type Result } from './errors';
import { ID_SPACE_PATTERN } from './kinds';
import { foldName, isAsciiName } from './names';
import { FORBIDDEN_KEYS, hasForbiddenKey } from './safe-keys';

/**
 * Katalog lokalnego marketplace'u (ADR 0043): `<korzen>/.claude-plugin/marketplace.json`. Plik jest
 * danymi z dysku, wiec walidacja jest ostra: nieznane pole to blad, a wpis, ktorego CWM nie umie
 * uzyc bezpiecznie (zrodlo inne niz `./sciezka`, deklaracje wykonawcze w katalogu), dostaje powod
 * zamiast byc po cichu pominiety albo zinterpretowany inaczej niz zrobi to silnik.
 */
export const MARKETPLACE_CATALOG_FILE = '.claude-plugin/marketplace.json';
export const MAX_MARKETPLACE_BYTES = 512 * 1024;
const MAX_PLUGINS = 500;
const MAX_SOURCE_DEPTH = 8;
const MAX_SOURCE_LENGTH = 1000;
const MAX_SEGMENT_BYTES = 255;
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const ROOT_KEYS = ['$schema', 'name', 'owner', 'metadata', 'plugins', 'description', 'version'];
/** Pola opisowe wpisu: nie wplywaja na to, co silnik uruchomi. */
const ENTRY_META_KEYS = [
  'name',
  'source',
  'description',
  'version',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'category',
  'tags',
  'strict',
];
/** Deklaracje procesow i tresci w wpisie marketplace'u. Silnik laduje plugin z katalogu (plugin.json), nie z wpisu. */
const ENTRY_EXEC_KEYS = [
  'hooks',
  'mcpServers',
  'lspServers',
  'commands',
  'agents',
  'skills',
  'outputStyles',
];

export interface MarketplacePlugin {
  readonly name: string;
  readonly version: string | null;
  readonly description: string | null;
  /** Zrodlo do pokazania uzytkownikowi: tekst z pliku albo opis zrodla obiektowego. */
  readonly declaredSource: string;
  /** Segmenty sciezki wzglednej wobec korzenia marketplace'u; null, gdy wpisu nie da sie uzyc. */
  readonly sourceParts: readonly string[] | null;
  /** Powod, dla ktorego wpis nie jest uzywalny; null dla uzywalnego. */
  readonly problem: string | null;
}

export interface MarketplaceCatalog {
  readonly name: string;
  readonly description: string | null;
  readonly plugins: readonly MarketplacePlugin[];
}

/** Opis zrodla obiektowego (`github`, `url`, `git`, `npm`...): tylko rodzaj, bez adresow z pliku. */
function describeObjectSource(value: PlainObject): string {
  const kind = field(value, 'source') ?? field(value, 'type');
  return typeof kind === 'string' && /^[a-z][a-z-]{0,31}$/.test(kind) ? kind : 'obiekt';
}

type SourceCheck =
  { readonly ok: true; readonly parts: string[] } | { readonly ok: false; readonly reason: string };

/**
 * `source` musi byc tekstem `./a/b`: wzgledna sciezka do katalogu pluginu w korzeniu marketplace'u.
 * Wspolna kontrola segmentow (`Checker.relativePath`: bez `..`, `\`, `%`, pustych segmentow, nazw
 * urzadzen Windows, NFC), a dodatkowo bez segmentow ukrytych (`.git`, `.claude-plugin`) i bez korzenia.
 */
function checkRelativeSource(value: string): SourceCheck {
  if (value.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: `zrodlo jest dluzsze niz ${MAX_SOURCE_LENGTH} znakow` };
  }
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, reason: 'zrodlo zawiera znaki sterujace lub formatujace' };
  }
  const probe = new Checker();
  if (!value.startsWith('./') || probe.relativePath(value, 'source') === null) {
    return {
      ok: false,
      reason:
        'zrodlo ma byc tekstem "./sciezka" wzgledem korzenia marketplace\'u, bez ".." i znakow specjalnych',
    };
  }
  const parts = value.slice(2).split('/');
  const encoder = new TextEncoder();
  if (parts.some((part) => encoder.encode(part).length > MAX_SEGMENT_BYTES)) {
    return { ok: false, reason: `segment zrodla jest dluzszy niz ${MAX_SEGMENT_BYTES} bajtow` };
  }
  if (parts.length > MAX_SOURCE_DEPTH)
    return { ok: false, reason: 'zrodlo jest zbyt gleboko zagniezdzone' };
  if (parts.some((part) => part.startsWith('.'))) {
    return {
      ok: false,
      reason: 'zrodlo nie moze zawierac segmentow ukrytych (zaczynajacych sie od ".")',
    };
  }
  return { ok: true, parts };
}

function readEntry(c: Checker, raw: unknown, path: string): MarketplacePlugin | null {
  if (!isPlainObject(raw)) {
    c.add(path, 'Oczekiwano obiektu.');
    return null;
  }
  const entry = raw;
  const name = field(entry, 'name');
  if (typeof name !== 'string' || name === '' || name.length > 128) {
    c.add(`${path}.name`, 'Oczekiwano niepustej nazwy pluginu (do 128 znakow).');
    return null;
  }

  const problems: string[] = [];
  const unknown = Object.keys(entry).filter(
    (key) => !ENTRY_META_KEYS.includes(key) && !ENTRY_EXEC_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    problems.push(
      `nieznane pola wpisu: ${unknown
        .slice(0, 5)
        .map((k) => JSON.stringify(k.slice(0, 40)))
        .join(', ')}`,
    );
  }
  if (!PLUGIN_NAME.test(name) || !isAsciiName(name)) {
    problems.push('nazwa pluginu spoza ASCII albo z niedozwolonymi znakami');
  }
  const exec = ENTRY_EXEC_KEYS.filter((key) => Object.hasOwn(entry, key));
  if (exec.length > 0) {
    problems.push(
      `wpis deklaruje ${exec.join(', ')}: silnik czyta je z plugin.json w katalogu pluginu, nie z marketplace.json`,
    );
  }
  if (field(entry, 'strict') === false) {
    problems.push('strict: false (wpis zastepuje plugin.json) nie jest obslugiwane');
  }

  const sourceValue = field(entry, 'source');
  let declaredSource = 'brak';
  let parts: string[] | null = null;
  if (sourceValue === undefined) {
    problems.push('brak pola source');
  } else if (typeof sourceValue === 'string') {
    const shown = sourceValue.length > 200 ? `${sourceValue.slice(0, 200)}...` : sourceValue;
    declaredSource = escapeControlChars(shown);
    const checked = checkRelativeSource(sourceValue);
    if (checked.ok) parts = checked.parts;
    else problems.push(checked.reason);
  } else if (isPlainObject(sourceValue)) {
    const kind = describeObjectSource(sourceValue);
    declaredSource = `obiekt (${kind})`;
    problems.push(
      `zrodlo typu ${kind} nie jest obslugiwane: cwm uzywa tylko lokalnych pluginow ("./sciezka" w katalogu marketplace'u), bez pobierania z sieci`,
    );
  } else {
    problems.push('zrodlo ma byc tekstem "./sciezka"');
  }

  const versionValue = field(entry, 'version');
  const version =
    typeof versionValue === 'string' && VERSION.test(versionValue) ? versionValue : null;
  if (versionValue !== undefined && version === null) problems.push('wersja w nieznanym formacie');
  const descriptionValue = field(entry, 'description');
  const description =
    typeof descriptionValue === 'string' && descriptionValue.length <= 500
      ? descriptionValue
      : null;

  return {
    name,
    version,
    description,
    declaredSource,
    sourceParts: problems.length === 0 ? parts : null,
    problem: problems.length === 0 ? null : problems.join('; '),
  };
}

/**
 * Parsuje i sprawdza `marketplace.json`. Blad struktury (nie JSON, zabronione klucze, nieznane pola
 * korzenia, `metadata.pluginRoot`, wpis bez nazwy) odrzuca caly katalog. Blad pojedynczego wpisu
 * zostaje przy wpisie (`problem`), zeby `cwm marketplace show` pokazal reszte. Wpisy o tej samej
 * nazwie po zwinieciu wielkosci liter i Unicode (`foldName`) dostaja wspolny powod: nie wiadomo,
 * ktory z nich jest "ten", a sobowtory nie moga wybierac sie nawzajem.
 */
export function parseMarketplaceCatalog(text: string): Result<MarketplaceCatalog> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail([{ path: '$', message: 'marketplace.json nie jest poprawnym JSON.' }]);
  }
  if (hasForbiddenKey(parsed)) {
    return fail([{ path: '$', message: 'marketplace.json zawiera zabroniony klucz.' }]);
  }
  const c = new Checker();
  const root = c.object(parsed, '$', ROOT_KEYS, ['name', 'plugins']);
  if (!root) return fail(c.errors);

  const name = c.string(
    field(root, 'name'),
    'name',
    ID_SPACE_PATTERN,
    'male litery ASCII, cyfry, -',
  );
  const owner = field(root, 'owner');
  if (owner !== undefined) {
    const o = c.object(owner, 'owner', ['name', 'email', 'url'], ['name']);
    if (o) for (const key of Object.keys(o)) c.string(field(o, key), `owner.${key}`);
  }
  const metadata = field(root, 'metadata');
  if (metadata !== undefined) {
    const m = c.object(metadata, 'metadata', ['description', 'version', 'pluginRoot']);
    if (m && Object.hasOwn(m, 'pluginRoot')) {
      c.add('metadata.pluginRoot', 'pluginRoot zmienia znaczenie "source" i nie jest obslugiwane.');
    }
  }
  for (const key of ['description', 'version', '$schema']) {
    const value = field(root, key);
    if (value !== undefined) c.string(value, key);
  }

  const list = field(root, 'plugins');
  const entries: MarketplacePlugin[] = [];
  if (!Array.isArray(list)) c.add('plugins', 'Oczekiwano listy pluginow.');
  else if (list.length > MAX_PLUGINS) c.add('plugins', `Najwyzej ${MAX_PLUGINS} pluginow.`);
  else {
    (list as unknown[]).forEach((raw, index) => {
      const entry = readEntry(c, raw, `plugins[${index}]`);
      if (entry !== null) entries.push(entry);
    });
  }
  if (c.errors.length > 0 || name === null) return fail(c.errors);

  const groups = new Map<string, number>();
  for (const entry of entries) {
    const key = foldName(entry.name);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const plugins = entries.map((entry): MarketplacePlugin => {
    if ((groups.get(foldName(entry.name)) ?? 0) < 2) return entry;
    const reason = 'nazwa powtorzona po zwinieciu wielkosci liter i Unicode';
    return {
      ...entry,
      sourceParts: null,
      problem: entry.problem === null ? reason : `${entry.problem}; ${reason}`,
    };
  });
  const description = field(root, 'description');
  return ok({
    name,
    description: typeof description === 'string' ? description : null,
    plugins,
  });
}

export type MarketplaceSelection =
  | { readonly ok: true; readonly plugin: MarketplacePlugin; readonly parts: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Wpis pluginu po nazwie (porownanie `foldName`). Nazwa spoza ASCII, brak wpisu, kolizja i wpis
 * z `problem` to odmowa z powodem. Zwracane `parts` sa juz sprawdzone, ale granice katalogu
 * (dowiazania, `realpath`) sprawdza dopiero warstwa infra.
 */
export function selectMarketplacePlugin(
  catalog: MarketplaceCatalog,
  wanted: string,
): MarketplaceSelection {
  if (!isAsciiName(wanted) || FORBIDDEN_KEYS.has(wanted)) {
    return { ok: false, reason: 'nazwa pluginu spoza ASCII' };
  }
  const key = foldName(wanted);
  const matches = catalog.plugins.filter((plugin) => foldName(plugin.name) === key);
  const [first] = matches;
  if (first === undefined) {
    return { ok: false, reason: `marketplace "${catalog.name}" nie ma pluginu "${wanted}"` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `marketplace "${catalog.name}" ma kilka wpisow o nazwie "${wanted}"`,
    };
  }
  if (first.problem !== null || first.sourceParts === null) {
    return {
      ok: false,
      reason: `wpis "${first.name}" w marketplace "${catalog.name}" jest nieuzywalny: ${first.problem ?? 'brak zrodla'}`,
    };
  }
  return { ok: true, plugin: first, parts: first.sourceParts };
}
