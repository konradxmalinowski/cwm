import { redactSecrets } from '../security/secret-redactor';

/**
 * Redakcja raportu diagnostycznego (ADR 0053, rozwija ADR 0004). Czysta funkcja tekstu: ten sam
 * zestaw regul dziala na calej tresci raportu, wiec zadna sekcja nie ma wlasnej, rozjezdzajacej
 * sie wersji. Zamienniki sa stabilne w obrebie jednego raportu (ten sam element dostaje ten sam
 * znacznik), zeby zgloszenie dalo sie czytac bez znajomosci nazw.
 *
 * Kolejnosc regul jest czescia kontraktu:
 * 1. katalog domowy, 2. adresy URL (host razem z danymi logowania), 3. adresy e-mail, zanim nazwa
 * konta zjadlaby domene, 4. nazwa uzytkownika systemu, 5. nazwy elementow biblioteki, 6. sekrety
 * i tokeny (klasyfikator logera), 7. nazwy w sciezkach. Nazwy i konto nie trafiaja w znaczniki
 * wstawione wczesniej, bo `<` i `>` sa dla nich granica slowa.
 */

export type RedactionCategory =
  'home' | 'user' | 'names' | 'hosts' | 'emails' | 'secrets' | 'paths';

export interface RedactionCategoryInfo {
  readonly id: RedactionCategory;
  readonly label: string;
  readonly replacement: string;
}

/** Lista wypisywana na poczatku raportu: kazda regula, ktora zawsze dziala. */
export const REDACTION_CATEGORIES: readonly RedactionCategoryInfo[] = [
  { id: 'home', label: 'Katalog domowy', replacement: '~' },
  { id: 'user', label: 'Nazwa konta w systemie', replacement: '<user>' },
  {
    id: 'names',
    label: 'Nazwy elementów biblioteki (tytuły, identyfikatory, aliasy)',
    replacement: '<skill-1>, <agent-2> i tak dalej, ten sam element ma w raporcie ten sam znacznik',
  },
  {
    id: 'hosts',
    label: 'Adresy w URL: host, port i dane logowania',
    replacement: 'https://<host>',
  },
  { id: 'emails', label: 'Adresy e-mail', replacement: '<email>' },
  {
    id: 'secrets',
    label: 'Sekrety, znane formaty kluczy i ciągi o wysokiej entropii',
    replacement: '[ukryty sekret: <reguła>]',
  },
  {
    id: 'paths',
    label: 'Nazwy katalogów i plików w ścieżkach, których aplikacja nie zna (na przykład projekty)',
    replacement: '<path-1>',
  },
];

export interface RedactableItem {
  /** Rodzaj elementu (`skill`, `agent`, ...): wchodzi do znacznika. */
  readonly kind: string;
  /** Wszystkie nazwy jednego elementu; dzielą jeden znacznik. */
  readonly names: readonly string[];
}

export interface ReportRedactorOptions {
  /** Zamienia katalog domowy na `~` w dowolnym miejscu tekstu (`redactHomeInText` z infra). */
  readonly redactHome: (text: string) => string;
  /** Nazwa konta systemowego; `null` albo krotsza niz 3 znaki pomija regule. */
  readonly userName: string | null;
  readonly items: readonly RedactableItem[];
}

export interface ReportRedactor {
  redact(text: string): string;
}

/** Krotsze nazwy zjadalyby zwykle slowa w tekscie. */
const MIN_NAME_LENGTH = 4;
const MIN_USER_LENGTH = 3;
const MAX_NAMES = 5000;

/** Znak, ktory sasiadujac z nazwa oznacza, ze to czesc dluzszego slowa albo znacznika. */
const NAME_EDGE = String.raw`[\p{L}\p{N}_<>-]`;

/** Segmenty sciezek, ktore zostaja czytelne: nie niosa nazwy uzytkownika ani projektu. */
const KNOWN_SEGMENTS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'cwm',
  'agents',
  'config',
  'local',
  'share',
  'cache',
  'library',
  'application support',
  'appdata',
  'roaming',
  'programdata',
  'users',
  'home',
  'usr',
  'lib',
  'bin',
  'opt',
  'var',
  'tmp',
  'temp',
  'etc',
  'applications',
  'system',
  'volumes',
  'private',
  'node_modules',
  'dist',
  'main',
  'renderer',
  'preload',
  'resources',
  'app.asar',
  'electron',
  'userdata',
  'logs',
  'quarantine',
  'items',
  'objects',
  'backups',
  'skills',
  'commands',
  'hooks',
  'rules',
  'plugins',
  'marketplace',
  'documents',
  'desktop',
  'downloads',
  'skill.md',
  'claude.md',
  'agents.md',
  'settings.json',
  'config.toml',
  'app.log',
  'app.log.1',
  'index.db',
  'index.db-wal',
  'index.db-shm',
  'item.json',
  '.mcp.json',
]);

/** Znacznik, ewentualnie z rozszerzeniem: `<skill-1>.db` nie jest nowa nazwa do ukrycia. */
const PLACEHOLDER = /^<[a-z0-9-]+>(?:\.[A-Za-z0-9]{1,8})?$/;
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'`)\]]*)/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PATH_PATTERN = /(?<![\w:/.<>~-])(?:~|[A-Za-z]:)?[\\/][^\s"'`)\]<>]*/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function isKnownSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..' || segment === '~') return true;
  if (PLACEHOLDER.test(segment)) return true;
  const lower = segment.toLowerCase();
  return KNOWN_SEGMENTS.has(lower) || KNOWN_SEGMENTS.has(lower.replace(/^\./, ''));
}

interface NameTable {
  readonly pattern: RegExp | null;
  readonly placeholders: ReadonlyMap<string, string>;
}

function buildNameTable(items: readonly RedactableItem[]): NameTable {
  const placeholders = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const item of items) {
    let marker: string | undefined;
    for (const raw of item.names) {
      const name = raw.trim();
      if (name.length < MIN_NAME_LENGTH || isKnownSegment(name) || placeholders.has(name)) continue;
      if (placeholders.size >= MAX_NAMES) break;
      if (marker === undefined) {
        const next = (counters.get(item.kind) ?? 0) + 1;
        counters.set(item.kind, next);
        marker = `<${item.kind}-${next}>`;
      }
      placeholders.set(name, marker);
    }
  }
  if (placeholders.size === 0) return { pattern: null, placeholders };
  // Dluzsze nazwy najpierw, zeby `acme-deploy` wygralo z `acme`.
  const alternatives = [...placeholders.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const pattern = new RegExp(`(?<!${NAME_EDGE})(?:${alternatives})(?!${NAME_EDGE})`, 'gu');
  return { pattern, placeholders };
}

export function createReportRedactor(options: ReportRedactorOptions): ReportRedactor {
  const names = buildNameTable(options.items);
  const userName = options.userName?.trim() ?? '';
  const userPattern =
    userName.length >= MIN_USER_LENGTH
      ? new RegExp(`(?<!${NAME_EDGE})${escapeRegExp(userName)}(?!${NAME_EDGE})`, 'giu')
      : null;
  const pathPlaceholders = new Map<string, string>();

  function pathMarker(segment: string): string {
    let marker = pathPlaceholders.get(segment);
    if (marker === undefined) {
      marker = `<path-${pathPlaceholders.size + 1}>`;
      pathPlaceholders.set(segment, marker);
    }
    return marker;
  }

  function redactPath(match: string): string {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const body = tail === '' ? match : match.slice(0, match.length - tail.length);
    const parts = body.split(/([\\/])/);
    const out = parts.map((part, index) => {
      // Parzyste indeksy to segmenty, nieparzyste to separatory zachowane z wejscia.
      if (index % 2 === 1) return part;
      if (index === 0 && /^(?:~|[A-Za-z]:)$/.test(part)) return part;
      return isKnownSegment(part) ? part : pathMarker(part);
    });
    return out.join('') + tail;
  }

  return {
    redact(text: string): string {
      let out = options.redactHome(text);
      out = out.replace(URL_PATTERN, (match, scheme: string, authority: string) => {
        if (authority === '') return match;
        if (scheme.toLowerCase() === 'app' && authority === 'bundle') return match;
        return `${scheme}://<host>`;
      });
      out = out.replace(EMAIL_PATTERN, '<email>');
      if (userPattern !== null) out = out.replace(userPattern, '<user>');
      if (names.pattern !== null) {
        out = out.replace(names.pattern, (name) => names.placeholders.get(name) ?? name);
      }
      out = redactSecrets(out).text;
      return out.replace(PATH_PATTERN, redactPath);
    },
  };
}
