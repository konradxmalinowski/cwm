import { redactSecrets } from '../security/secret-redactor';

/**
 * Redakcja raportu diagnostycznego (ADR 0053, rozwija ADR 0004). Czysta funkcja tekstu: ten sam
 * zestaw regul dziala na calej tresci raportu, wiec zadna sekcja nie ma wlasnej, rozjezdzajacej
 * sie wersji. Zamienniki sa stabilne w obrebie jednego raportu (ten sam element dostaje ten sam
 * znacznik), zeby zgloszenie dalo sie czytac bez znajomosci nazw. Zasada: gdy nie wiadomo,
 * redaguj.
 *
 * Kolejnosc regul jest czescia kontraktu:
 * 1. katalog domowy, 2. adresy URL w calosci (host, sciezka, zapytanie; `file:` jak sciezka),
 * 3. zdalne adresy scp (`git@host:org/repo`), 4. adresy e-mail, 5. nazwy elementow biblioteki,
 * 6. nazwa uzytkownika systemu, 7. sekrety i tokeny (klasyfikator logera), 8. adresy sieciowe
 * (IPv6, IPv4, nazwy domenowe, host:port), 9. sciezki z poczatkiem (`~/`, `/`, `C:\`, takze ze
 * spacjami), 10. sciezki wzgledne z separatorami. Nazwy i konto nie trafiaja w znaczniki
 * wstawione wczesniej, bo `<` i `>` sa dla nich granica slowa; sciezki traktuja znacznik jak
 * znany segment i ida dalej.
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
    label:
      'Adresy URL w całości (host, ścieżka, zapytanie), nazwy domenowe, adresy IP z portem i zdalne adresy git',
    replacement: 'https://<host>/<path-1>, <host>, <ip>',
  },
  { id: 'emails', label: 'Adresy e-mail', replacement: '<email>' },
  {
    id: 'secrets',
    label: 'Sekrety, znane formaty kluczy i ciągi o wysokiej entropii',
    replacement: '[ukryty sekret: <reguła>]',
  },
  {
    id: 'paths',
    label:
      'Nazwy katalogów i plików w ścieżkach, także względnych i ze spacjami, których aplikacja nie zna (na przykład projekty)',
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
  /** Ostrzezenia o ograniczeniach redakcji, do pokazania w raporcie. */
  readonly warnings: readonly string[];
}

/** Krotsze nazwy zjadalyby zwykle slowa w tekscie. */
const MIN_NAME_LENGTH = 4;
const MIN_USER_LENGTH = 3;
const MAX_NAMES = 5000;

/** Litera, cyfra albo znacznik: nazwa sasiadujaca z nimi jest czescia dluzszego slowa. */
const NAME_EDGE = String.raw`[\p{L}\p{N}<>]`;

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
  'bundle',
  'index.html',
  'item.json',
  '.mcp.json',
]);

/** Znacznik, ewentualnie z rozszerzeniem: `<skill-1>.db` nie jest nowa nazwa do ukrycia. */
const PLACEHOLDER = /^<[a-z0-9-]+>(?:\.[A-Za-z0-9]{1,8})?(?:[?#]<[a-z]+>)?$/;
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'`)\]]*)([^\s"'`)\]]*)/gi;
const SCP_PATTERN = /(?<![\w.@-])[\w.-]+@[A-Za-z0-9.-]+:(?!\d)[^\s"'`]+/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Adresy sieciowe. Wersje (`Chromium: 140.0.0.0`) nie sa adresami: slowo kluczowe przed liczba
// wylacza regule, a reszta czterech oktetow 0-255 jest adresem.
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4_PATTERN = new RegExp(
  String.raw`(?<![\w.])(?<!(?:chrom(?:e|ium)|electron|node|version|wersja)[/: ]{1,2})${OCTET}(?:\.${OCTET}){3}(?::\d{1,5})?(?!\w|\.\d)`,
  'gi',
);
const IPV6_PATTERN = new RegExp(
  [
    String.raw`\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\](?::\d{1,5})?`,
    String.raw`(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])`,
    String.raw`(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}(?![\w:])`,
  ].join('|'),
  'g',
);
const TLDS = [
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'io',
  'dev',
  'ai',
  'info',
  'biz',
  'cloud',
  'xyz',
  'online',
  'site',
  'tech',
  'pl',
  'de',
  'uk',
  'eu',
  'fr',
  'es',
  'nl',
  'ch',
  'se',
  'fi',
  'cz',
  'dk',
  'ru',
  'cn',
  'jp',
  'br',
  'au',
  'ca',
  'internal',
  'local',
  'lan',
  'corp',
  'intranet',
  'home',
  'test',
  'example',
  'invalid',
  'localdomain',
];
const FQDN_PATTERN = new RegExp(
  String.raw`(?<![\w@.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:${TLDS.join('|')})(?![\w-])(?::\d{1,5})?`,
  'gi',
);
const HOST_PORT_PATTERN = /(?<![\w.\\/@-])[A-Za-z][A-Za-z0-9-]{1,62}:\d{2,5}(?![\w:])/g;

// Sciezka z poczatkiem: segmenty moga miec spacje, ale tylko gdy po nich idzie separator, wiec
// slowa po ostatnim segmencie zostaja poza sciezka.
const WORD = String.raw`[^\s\\/"'` + '`' + String.raw`~]`;
const SEGMENT = `${WORD}+(?: +${WORD}+)*`;
const ANCHORED_PATH = new RegExp(
  String.raw`(?<![\w.])(?:~|[A-Za-z]:)?[\\/](?:${SEGMENT}[\\/])*${WORD}*`,
  'g',
);
const REL_SEGMENT = String.raw`(?:<[a-z0-9-]+>|[\w.@+-])+`;
const RELATIVE_PATH = new RegExp(
  String.raw`(?<![\w/\\~.@<>+-])${REL_SEGMENT}(?:[\\/]${REL_SEGMENT})+`,
  'g',
);
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function isKnownSegment(segment: string): boolean {
  if (segment.trim() === '' || segment === '.' || segment === '..' || segment === '~') return true;
  if (PLACEHOLDER.test(segment)) return true;
  const lower = segment.toLowerCase();
  return KNOWN_SEGMENTS.has(lower) || KNOWN_SEGMENTS.has(lower.replace(/^\./, ''));
}

interface NameTable {
  readonly pattern: RegExp | null;
  readonly placeholders: ReadonlyMap<string, string>;
  readonly truncated: boolean;
}

function buildNameTable(items: readonly RedactableItem[]): NameTable {
  const placeholders = new Map<string, string>();
  const counters = new Map<string, number>();
  let truncated = false;
  for (const item of items) {
    let marker: string | undefined;
    for (const raw of item.names) {
      const name = raw.trim();
      if (name.length < MIN_NAME_LENGTH || placeholders.has(name)) continue;
      if (placeholders.size >= MAX_NAMES) {
        truncated = true;
        break;
      }
      if (marker === undefined) {
        const next = (counters.get(item.kind) ?? 0) + 1;
        counters.set(item.kind, next);
        marker = `<${item.kind}-${next}>`;
      }
      placeholders.set(name, marker);
    }
  }
  if (placeholders.size === 0) return { pattern: null, placeholders, truncated };
  // Dluzsze nazwy najpierw, zeby `acme-deploy` wygralo z `acme`.
  const alternatives = [...placeholders.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const pattern = new RegExp(`(?<!${NAME_EDGE})(?:${alternatives})(?!${NAME_EDGE})`, 'gu');
  return { pattern, placeholders, truncated };
}

export function createReportRedactor(options: ReportRedactorOptions): ReportRedactor {
  const names = buildNameTable(options.items);
  const userName = options.userName?.trim() ?? '';
  const userPattern =
    userName.length >= MIN_USER_LENGTH
      ? new RegExp(`(?<!${NAME_EDGE})${escapeRegExp(userName)}(?!${NAME_EDGE})`, 'giu')
      : null;
  const pathPlaceholders = new Map<string, string>();
  const warnings = names.truncated
    ? [
        `Lista nazw elementów do ukrycia została obcięta do ${MAX_NAMES}: nazwy poza limitem mogą zostać w tekście. Sprawdź podgląd.`,
      ]
    : [];

  function pathMarker(segment: string): string {
    let marker = pathPlaceholders.get(segment);
    if (marker === undefined) {
      marker = `<path-${pathPlaceholders.size + 1}>`;
      pathPlaceholders.set(segment, marker);
    }
    return marker;
  }

  /** Segmenty rozdzielone `/` i `\`: znane i znaczniki zostaja, reszta dostaje `<path-N>`. */
  function redactSegments(body: string): string {
    return body
      .split(/([\\/])/)
      .map((part, index) => {
        if (index % 2 === 1) return part;
        if (index === 0 && /^(?:~|[A-Za-z]:)$/.test(part)) return part;
        return isKnownSegment(part) ? part : pathMarker(part);
      })
      .join('');
  }

  function redactAnchored(match: string): string {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const body = tail === '' ? match : match.slice(0, match.length - tail.length);
    return redactSegments(body) + tail;
  }

  function redactUrl(match: string, scheme: string, authority: string, rest: string): string {
    const lower = scheme.toLowerCase();
    if (lower === 'app' && authority === 'bundle') return match;
    // `file:` niesie sciezke: `file://~/x`, `file:///Volumes/x`.
    if (lower === 'file' || authority === '') {
      return `${scheme}://${redactSegments(authority + rest)}`;
    }
    const cut = rest.search(/[?#]/);
    const pathPart = cut === -1 ? rest : rest.slice(0, cut);
    const suffix = cut === -1 ? '' : rest[cut] === '?' ? '?<query>' : '#<fragment>';
    return `${scheme}://<host>${redactSegments(pathPart)}${suffix}`;
  }

  function redactRelative(token: string): string {
    const separators = token.match(/[\\/]/g)?.length ?? 0;
    const last = token.split(/[\\/]/).pop() ?? '';
    const looksLikePath =
      separators >= 2 || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last) || token.startsWith('.');
    return looksLikePath ? redactSegments(token) : token;
  }

  return {
    warnings,
    redact(text: string): string {
      let out = options.redactHome(text);
      out = out.replace(URL_PATTERN, redactUrl);
      out = out.replace(SCP_PATTERN, '<host>');
      out = out.replace(EMAIL_PATTERN, '<email>');
      if (names.pattern !== null) {
        out = out.replace(names.pattern, (name) => names.placeholders.get(name) ?? name);
      }
      if (userPattern !== null) out = out.replace(userPattern, '<user>');
      out = redactSecrets(out).text;
      out = out.replace(IPV6_PATTERN, '<ip>');
      out = out.replace(IPV4_PATTERN, '<ip>');
      out = out.replace(FQDN_PATTERN, '<host>');
      out = out.replace(HOST_PORT_PATTERN, '<host>');
      out = out.replace(ANCHORED_PATH, redactAnchored);
      return out.replace(RELATIVE_PATH, redactRelative);
    },
  };
}
