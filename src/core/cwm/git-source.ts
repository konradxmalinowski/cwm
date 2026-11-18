import { isLoopback } from './loopback';

/**
 * Czyste reguly pobierania pluginow z git (ADR 0048): adres, ref, srodowisko i argumenty procesu
 * `git` oraz kontrola listy plikow commita. Nic tu nie uruchamia procesu ani nie dotyka dysku;
 * proces `git` jest tylko w `infra/cwm/git-fetch.ts`.
 */

/** Pelny SHA-1 albo SHA-256 (maly hex). Skrot skrocony jest odrzucany: nie jest jednoznaczny. */
export const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Ref trafia do polecenia `git`, wiec nie zaczyna sie od `-` i ma waski zestaw znakow. */
export const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

const SHORT_HEX = /^[0-9a-f]{7,39}$/i;
const GIT_URL_MAX = 2048;
/** Znaki sterujace i formatujace, biale znaki oraz `\`: nie ma ich w poprawnym adresie. */
const URL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\\]/u;

/** Powod odrzucenia adresu repozytorium albo null. Komunikat nie przytacza adresu. */
export function gitUrlProblem(text: string): string | null {
  if (text.length === 0 || text.length > GIT_URL_MAX) return 'Adres repozytorium ma zla dlugosc.';
  if (URL_FORBIDDEN.test(text)) {
    return 'Adres repozytorium zawiera znaki sterujace, biale znaki albo odwrotny ukosnik.';
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return 'Adres repozytorium jest nieprawidlowy (oczekiwano https://host/sciezka).';
  }
  const allowed =
    parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback(parsed.hostname));
  if (!allowed) {
    return 'Adres repozytorium: dozwolone tylko https (http tylko dla petli zwrotnej); file, ext, git i ssh sa odrzucane.';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'Adres repozytorium nie moze zawierac nazwy uzytkownika ani hasla.';
  }
  if (parsed.hostname === '') return 'Adres repozytorium nie ma nazwy hosta.';
  if (parsed.search !== '' || parsed.hash !== '') {
    return 'Adres repozytorium nie moze miec zapytania (?) ani fragmentu (#).';
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    return 'Adres repozytorium nie ma sciezki do repozytorium.';
  }
  // `git` dostaje ten sam tekst, ktory sprawdzilismy: forma niekanoniczna (wielkie litery w schemacie,
  // cyfry pelnej szerokosci, `http:host:port/x`) moglaby byc przez `git` zinterpretowana inaczej niz przez URL.
  if (parsed.href !== text) {
    return `Adres repozytorium nie jest w formie kanonicznej (uzyj: ${parsed.href}).`;
  }
  return null;
}

/** Adres do wyswietlenia i do skrotu zatwierdzenia: bez danych logowania, zapytania i fragmentu. */
export function sanitizeGitUrl(text: string): string {
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[niepoprawny adres]';
  }
}

/** Powod odrzucenia refu albo null. Skrocony SHA jest odrzucany, bo `git` rozwiazalby go lokalnie. */
export function gitRefProblem(ref: string): string | null {
  if (!GIT_REF_PATTERN.test(ref)) return 'Ref: oczekiwano nazwy galezi, taga albo pelnego SHA.';
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) {
    return 'Ref ma niedozwolona forme.';
  }
  if (SHORT_HEX.test(ref)) return 'Ref wyglada na skrocony SHA: podaj pelny (40 albo 64 znaki).';
  return null;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
const TLS_VARS = ['SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

export interface GitEnvInput {
  /** Srodowisko procesu CWM. Nie jest modyfikowane. */
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** Pusty katalog roboczy 0700: to `HOME`, `XDG_CONFIG_HOME` i `TMPDIR` procesu (zadnego ~/.netrc ani ~/.ssh). */
  readonly scratchDir: string;
  /** Katalog pliku `git` (po `realpath`), zeby `git` znalazl swoje pomocniki. */
  readonly gitDir: string;
  /** Adres to http na petli zwrotnej (tylko testy i lokalne serwery). */
  readonly allowLoopbackHttp: boolean;
  /** Katalog repozytorium i drzewa roboczego (`GIT_DIR`, `GIT_WORK_TREE`), gdy polecenie ich potrzebuje. */
  readonly repository?: { readonly gitDir: string; readonly workTree: string };
}

/**
 * Srodowisko procesu `git` budowane od zera, nie z `process.env`. Z rodzica przechodza tylko zmienne
 * proxy i sciezki certyfikatow; nic z nazwa sekretu, nic z `GIT_*`, `SSH_*` ani `HOME`.
 */
export function buildGitEnv(input: GitEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${input.gitDir}:/usr/bin:/bin`,
    HOME: input.scratchDir,
    XDG_CONFIG_HOME: input.scratchDir,
    TMPDIR: input.scratchDir,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: input.allowLoopbackHttp ? 'https:http' : 'https',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  for (const name of [...PROXY_VARS, ...TLS_VARS]) {
    const value = input.parent[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  if (input.allowLoopbackHttp) {
    env['NO_PROXY'] = LOOPBACK_NO_PROXY;
    env['no_proxy'] = LOOPBACK_NO_PROXY;
  }
  if (input.repository !== undefined) {
    env['GIT_DIR'] = input.repository.gitDir;
    env['GIT_WORK_TREE'] = input.repository.workTree;
  }
  return env;
}

/**
 * Opcje `-c` przed kazdym poleceniem `git`: bez hookow, bez protokolow poza https (http tylko na
 * petli zwrotnej), bez przekierowan, bez submodulow, bez filtrow LFS, bez pomocnikow hasel,
 * z kontrola obiektow i nazw plikow.
 */
export function gitHardeningArgs(allowLoopbackHttp: boolean): string[] {
  const settings = [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.attributesFile=/dev/null',
    'core.autocrlf=false',
    'core.protectHFS=true',
    'core.protectNTFS=true',
    'protocol.allow=never',
    'protocol.https.allow=always',
    `protocol.http.allow=${allowLoopbackHttp ? 'always' : 'never'}`,
    'protocol.file.allow=never',
    'protocol.ext.allow=never',
    'protocol.git.allow=never',
    'protocol.ssh.allow=never',
    'http.followRedirects=false',
    'http.sslVerify=true',
    'credential.helper=',
    'transfer.fsckObjects=true',
    'fetch.fsckObjects=true',
    'fetch.recurseSubmodules=false',
    'submodule.recurse=false',
    'filter.lfs.smudge=',
    'filter.lfs.process=',
    'filter.lfs.clean=',
    'filter.lfs.required=false',
    'gc.auto=0',
    'maintenance.auto=false',
    'advice.detachedHead=false',
  ];
  return settings.flatMap((setting) => ['-c', setting]);
}

export interface GitTreeLimits {
  readonly files: number;
  readonly fileBytes: number;
  readonly bytes: number;
}

export type GitTreeCheck =
  | {
      readonly ok: true;
      readonly files: number;
      readonly bytes: number;
      /** Sciezki wpisow typu submodul (tryb 160000): nie sa pobierane, w drzewie zostalyby puste. */
      readonly submodules: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

const LISTING_ENTRY = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/;

/** Tekst ze sciezki repozytorium do komunikatu: znaki sterujace i formatujace jako `?`, krotko. */
function printable(text: string): string {
  const clean = [...text].map((ch) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch) ? '?' : ch)).join('');
  return clean.length > 80 ? `${clean.slice(0, 80)}...` : clean;
}

/**
 * Kontrola wyniku `git ls-tree -r -t -l -z <commit>` przed wypakowaniem: tylko zwykle pliki (dowiazanie
 * to blad), limity liczby i rozmiaru, brak skladnika `.git`. Submoduly sa zbierane, nie odrzucane.
 */
export function checkGitTreeListing(raw: string, limits: GitTreeLimits): GitTreeCheck {
  const fail = (message: string): GitTreeCheck => ({ ok: false, message });
  const submodules: string[] = [];
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const match = LISTING_ENTRY.exec(record);
    if (match === null) return fail('nieczytelna lista plikow commita');
    const [, mode = '', , , size = '', path = ''] = match;
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) {
      return fail(`sciezka ze znakiem sterujacym lub formatujacym: ${printable(path)}`);
    }
    if (path.split('/').some((part) => part.toLowerCase() === '.git')) {
      return fail(`sciezka ze skladnikiem .git: ${printable(path)}`);
    }
    // Dwie sciezki rozniace sie tylko wielkoscia liter nie istnieja razem na APFS i NTFS: jedna nadpisalaby
    // druga, a `SKILL.md` i `skill.md` w jednym drzewie to atak na to, co adapter przeczyta. Odmowa jest jawna.
    const folded = path.normalize('NFC').toLowerCase();
    if (seen.has(folded)) {
      return fail(`sciezki roznia sie tylko wielkoscia liter: ${printable(path)}`);
    }
    seen.add(folded);
    // `ls-tree -t` wypisuje tez katalogi; ich skroty zbiera `gitListedTreeIds`.
    if (mode === '040000') continue;
    if (mode === '160000') {
      submodules.push(printable(path));
      continue;
    }
    if (mode === '120000') return fail(`dowiazanie symboliczne w repozytorium: ${printable(path)}`);
    if (mode !== '100644' && mode !== '100664' && mode !== '100755') {
      return fail(`nieobslugiwany tryb ${mode}: ${printable(path)}`);
    }
    const length = Number(size);
    if (!Number.isSafeInteger(length)) return fail('nieczytelny rozmiar pliku w commicie');
    if (length > limits.fileBytes) return fail(`plik wiekszy niz limit: ${printable(path)}`);
    files += 1;
    bytes += length;
    if (files > limits.files) return fail(`wiecej niz ${limits.files} plikow`);
    if (bytes > limits.bytes) return fail('drzewo wieksze niz limit');
  }
  if (files === 0) return fail('commit nie zawiera zadnego pliku');
  return { ok: true, files, bytes, submodules };
}

/** Skroty obiektow drzew z wyniku `git ls-tree -r -t -l -z` (bez glownego: ten wynika z commita). Bez powtorzen. */
export function gitListedTreeIds(raw: string): string[] {
  const ids = new Set<string>();
  for (const record of raw.split('\0')) {
    const match = LISTING_ENTRY.exec(record);
    if (match !== null && match[1] === '040000' && match[2] === 'tree') ids.add(match[3] ?? '');
  }
  return [...ids];
}

/** Skroty blobow (pliki 100644 i 100755) z tego samego wyniku, bez powtorzen. */
export function gitListedBlobIds(raw: string): string[] {
  const ids = new Set<string>();
  for (const record of raw.split('\0')) {
    const match = LISTING_ENTRY.exec(record);
    if (
      match !== null &&
      (match[1] === '100644' || match[1] === '100664' || match[1] === '100755') &&
      match[2] === 'blob'
    ) {
      ids.add(match[3] ?? '');
    }
  }
  return [...ids];
}
