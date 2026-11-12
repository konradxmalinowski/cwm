import type { JsonValue } from '../../model/item';

/**
 * Klasyfikator sekretow (ARCHITECTURE 8.4, ADR 0018). Cztery sygnaly: nazwa pliku, wzorce znanych
 * kluczy, entropia ciagu i nazwa klucza w strukturze. Trafienie niesie regule, plik, linie i
 * uzasadnienie, nigdy wartosc: renderer i logi nie moga dostac sekretu z klasyfikatora.
 *
 * Falszywe trafienie, ktorego nie da sie zrozumiec, konczy sie wylaczeniem funkcji przez
 * uzytkownika, wiec kazda regula woli przepuscic niz oznaczyc tekst o tokenach jako sekret.
 */

export type SecretRule = 'file-name' | 'known-key' | 'entropy' | 'key-name';
export type SecretConfidence = 'high' | 'medium';

export interface SecretHit {
  readonly rule: SecretRule;
  /** Sciezka pliku wzgledem elementu. */
  readonly relPath: string;
  readonly line: number | null;
  readonly confidence: SecretConfidence;
  /** Po polsku, bez wartosci. */
  readonly reason: string;
}

export interface SecretScanFile {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

export interface StructuredEntry {
  /** Sciezka klucza, np. `mcpServers.acme.env.ACME_TOKEN`. */
  readonly path: string;
  readonly value: JsonValue;
}

/** Po tylu trafieniach w jednym pliku kolejne nic nie wnosza, a kosztuja pamiec. */
const MAX_HITS_PER_FILE = 25;
/** Plik o nieznanym formacie czytamy jako tekst, ale nie dluzej niz tyle. */
const BINARY_SNIFF_BYTES = 8192;

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.p8',
  '.ppk',
  '.tfstate',
  '.tfvars',
]);
const SENSITIVE_NAMES = new Set([
  'auth.json',
  '.env',
  '.netrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  'kubeconfig',
  '.pgpass',
  '.htpasswd',
  'token.txt',
]);
const ENV_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return relPath.slice(slash + 1);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

export function classifyFileName(relPath: string): SecretHit | null {
  const name = baseName(relPath).toLowerCase();
  const ext = extensionOf(name);
  const make = (confidence: SecretConfidence, reason: string): SecretHit => ({
    rule: 'file-name',
    relPath,
    line: null,
    confidence,
    reason,
  });

  if (SENSITIVE_NAMES.has(name)) {
    return make('high', `Nazwa pliku „${name}” wskazuje na dane uwierzytelniające.`);
  }
  if (name.startsWith('.env.') && !ENV_TEMPLATE_SUFFIXES.some((s) => name.endsWith(s))) {
    return make('high', 'Plik środowiskowy „.env.*” zwykle trzyma zmienne z hasłami i tokenami.');
  }
  if (/^service-account.*\.json$/.test(name)) {
    return make('high', 'Plik „service-account*.json” zwykle trzyma klucz konta usługi.');
  }
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return make('high', `Rozszerzenie „${ext}” oznacza zwykle klucz albo certyfikat.`);
  }
  // Dokument opisujacy credentials (np. credentials-guide.md) nie jest plikiem z credentials.
  if (name.includes('credentials') && !DOC_EXTENSIONS.has(ext)) {
    return make('medium', 'Nazwa pliku zawiera „credentials”, więc może trzymać dane logowania.');
  }
  return null;
}

export interface KnownPattern {
  readonly pattern: RegExp;
  readonly reason: string;
}

export const KNOWN_PATTERNS: readonly KnownPattern[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
    reason: 'Linia zaczyna blok klucza prywatnego (-----BEGIN ... PRIVATE KEY-----).',
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/,
    reason: 'Ciąg przypomina klucz API z prefiksem „sk-”.',
  },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    reason: 'Ciąg przypomina token GitHub z prefiksem „gh*_”.',
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/,
    reason: 'Ciąg przypomina osobisty token GitHub („github_pat_”).',
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    reason: 'Ciąg przypomina identyfikator klucza AWS („AKIA”).',
  },
  {
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    reason: 'Ciąg przypomina token Slack („xox”).',
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    reason: 'Ciąg przypomina klucz API Google („AIza”).',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    reason: 'Ciąg ma budowę tokenu JWT.',
  },
];

export const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|credential)/i;

/** Klucz: wartosc w YAML, TOML, JSON, .env i frontmatterze. Grupy: nazwa klucza, wartosc. */
export const ASSIGNMENT =
  /(?:^|[\s{,[(])["']?([A-Za-z0-9_.-]{0,60}(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_.-]{0,60})["']?\s*[:=]\s*["']?([^\s"',;#]+)/gi;

const PLACEHOLDER_FRAGMENTS = [
  'xxxx',
  '****',
  'your',
  'example',
  'changeme',
  'placeholder',
  'redacted',
  'dummy',
  'sample',
  'secrets.',
  'process.env',
  'env.',
];

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (/^[$<{%[(]/.test(value) || /^(?:https?:|\.{0,2}\/|~)/.test(lower)) return true;
  if (PLACEHOLDER_FRAGMENTS.some((f) => lower.includes(f))) return true;
  return new Set(value).size <= 2;
}

/** Wartosc wyglada jak sekret, a nie jak slowo, liczba albo nazwa: litery i cyfry albo wysoka entropia. */
export function looksLikeSecretValue(value: string): boolean {
  if (value.length < 8 || looksLikePlaceholder(value)) return false;
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  if (hasLetter && hasDigit) return true;
  return value.length >= 12 && shannonEntropy(value) >= 3.5 && /[^A-Za-z0-9]/.test(value);
}

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_THRESHOLD = 4.2;
export const LONG_TOKEN = /[A-Za-z0-9_+=-]{32,}/g;

export function isEntropyCandidate(token: string): boolean {
  // Hash gita albo sumy kontrolnej to hex: w dokumentacji skilli wystepuje czesto i nie jest sekretem.
  if (/^[0-9a-fA-F]+$/.test(token)) return false;
  // Sumy integralnosci (sha512-...) wyrazenie zwykle lapie razem z prefiksem.
  if (/^sha(?:256|384|512)-/i.test(token)) return false;
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

function scanLines(relPath: string, text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < MAX_HITS_PER_FILE; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0 || line.length > 20_000) continue;
    const lineNo = i + 1;

    const known = KNOWN_PATTERNS.find((p) => p.pattern.test(line));
    if (known !== undefined) {
      hits.push({
        rule: 'known-key',
        relPath,
        line: lineNo,
        confidence: 'high',
        reason: known.reason,
      });
    }

    ASSIGNMENT.lastIndex = 0;
    for (const match of line.matchAll(ASSIGNMENT)) {
      const key = match[1] ?? '';
      const value = match[2] ?? '';
      if (SENSITIVE_KEY.test(key) && looksLikeSecretValue(value)) {
        hits.push({
          rule: 'key-name',
          relPath,
          line: lineNo,
          confidence: 'medium',
          reason: `Klucz „${key}” ma przypisaną wartość wyglądającą na sekret.`,
        });
        break;
      }
    }

    if (known === undefined) {
      for (const match of line.matchAll(LONG_TOKEN)) {
        const token = match[0];
        if (token.length >= ENTROPY_MIN_LENGTH && isEntropyCandidate(token)) {
          hits.push({
            rule: 'entropy',
            relPath,
            line: lineNo,
            confidence: 'medium',
            reason: 'Długi ciąg znaków o wysokiej entropii przypomina losowo wygenerowany klucz.',
          });
          break;
        }
      }
    }
  }
  return hits;
}

export function classifySecrets(files: readonly SecretScanFile[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const file of files) {
    const byName = classifyFileName(file.relPath);
    if (byName !== null) hits.push(byName);
    if (looksBinary(file.bytes)) continue;
    hits.push(...scanLines(file.relPath, new TextDecoder('utf-8').decode(file.bytes)));
  }
  return dedupe(hits);
}

/** Nazwa klucza w strukturze, ktorej adapter nie zmapowal (`unmappedKeys`). */
export function classifyStructured(
  relPath: string,
  entries: readonly StructuredEntry[],
): SecretHit[] {
  const hits: SecretHit[] = [];
  const visit = (path: string, value: JsonValue): void => {
    if (hits.length >= MAX_HITS_PER_FILE) return;
    if (typeof value === 'string') {
      const key = path.slice(path.lastIndexOf('.') + 1);
      if (SENSITIVE_KEY.test(key) && looksLikeSecretValue(value)) {
        hits.push({
          rule: 'key-name',
          relPath,
          line: null,
          confidence: 'medium',
          reason: `Klucz „${path}” ma przypisaną wartość wyglądającą na sekret.`,
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(`${path}.${i}`, v as JsonValue));
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) visit(`${path}.${k}`, v);
    }
  };
  for (const entry of entries) visit(entry.path, entry.value);
  return hits;
}

function dedupe(hits: readonly SecretHit[]): SecretHit[] {
  const seen = new Set<string>();
  const result: SecretHit[] = [];
  for (const hit of hits) {
    const key = `${hit.rule}|${hit.relPath}|${hit.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit);
  }
  return result;
}

/**
 * Szersza regula liniowa dla importu z niezaufanego zrodla (cwm import): nazwa sekretu, `:` lub `=`
 * i wartosc co najmniej 4 znaki. Lapie tez placeholdery, bo tam nadmiar trafien jest tansi niz
 * przeoczenie. Osobna funkcja, zeby `classifySecrets` (aplikacja desktopowa) zostalo bez zmian.
 */
export const STRICT_LINE_RULE =
  /(?:password|passwd|secret|api[_-]?key|token|aws_secret_access_key)\s*[:=]\s*\S{4,}/i;

/** Jak `classifySecrets`, plus regula `STRICT_LINE_RULE` takze dla plikow binarnych (wzorzec ASCII w bajtach). */
export function classifyStrict(input: readonly SecretScanFile[]): SecretHit[] {
  // Plik UTF-16 jest skanowany takze po zdekodowaniu (inaczej bajty zerowe chowaja tekst).
  const files = input.flatMap((file) => {
    const wide = utf16Text(file.bytes);
    return wide === null
      ? [file]
      : [file, { relPath: file.relPath, bytes: new TextEncoder().encode(wide) }];
  });
  const hits = classifySecrets(files);
  for (const file of files) {
    const binary = looksBinary(file.bytes);
    const text = binary
      ? new TextDecoder('latin1').decode(file.bytes)
      : new TextDecoder('utf-8').decode(file.bytes);
    const lines = binary ? [text] : text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.length <= 20_000 || binary) {
        if (STRICT_LINE_RULE.test(line)) {
          hits.push({
            rule: 'key-name',
            relPath: file.relPath,
            line: binary ? null : i + 1,
            confidence: 'medium',
            reason: binary
              ? 'Plik binarny zawiera ciąg „hasło/token/klucz = wartość”.'
              : 'Linia przypisuje wartość do nazwy typu hasło, token albo klucz.',
          });
          break;
        }
      }
    }
  }
  return dedupe(hits);
}

/**
 * Poziom wysokiej pewnosci dla importu (cwm import): sekrety, ktorych nie da sie dolaczyc nawet po
 * przegladzie. Trafienie niesie powod i numer wiersza, nigdy wartosc. `hard: false` to adres z
 * danymi logowania wygladajacy na wzor (user:password, ${VAR}, host example/localhost): plik jest
 * oznaczony, ale uzytkownik moze go dolaczyc.
 */
export interface HardSecretHit {
  readonly reason: string;
  readonly line: number | null;
  readonly hard: boolean;
}

const HARD_RULES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, reason: 'blok klucza prywatnego' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, reason: 'identyfikator klucza AWS' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, reason: 'klucz API sk-ant-' },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/, reason: 'klucz API sk-proj-' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/, reason: 'klucz API sk-' },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, reason: 'token GitHub' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/, reason: 'osobisty token GitHub' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, reason: 'token GitLab' },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, reason: 'token Slack' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    reason: 'token JWT',
  },
];

const URL_USERINFO = /:\/\/([^/@\s:]*):([^/@\s]+)@([^/\s:?#]*)/g;
const PLACEHOLDER_PASSWORD =
  /^(?:password|passwd|pass|pwd|secret|changeme|your[-_a-z]*|x+|\*+|\$\{[^}]*\}|\$[A-Za-z_]\w*|<[^>]*>|\{\{[^}]*\}\}|%[^%]*%)$/i;
const PLACEHOLDER_HOST =
  /^(?:localhost|127\.0\.0\.1|\[::1\]|(?:[^.]+\.)*example(?:\.[a-z]+)?|.*\.(?:test|invalid|localhost|example))$/i;

function urlHit(line: string): 'real' | 'placeholder' | null {
  let found: 'real' | 'placeholder' | null = null;
  for (const match of line.matchAll(URL_USERINFO)) {
    const password = match[2] ?? '';
    const host = match[3] ?? '';
    if (PLACEHOLDER_PASSWORD.test(password) || PLACEHOLDER_HOST.test(host)) found ??= 'placeholder';
    else return 'real';
  }
  return found;
}

/** Dluga linia jest skanowana oknami z nakladka, a nie pomijana (ukrycie sekretu w jednej linii). */
const HARD_WINDOW = 20_000;
const HARD_OVERLAP = 512;

function* windows(line: string): Generator<string> {
  if (line.length <= HARD_WINDOW) {
    yield line;
    return;
  }
  for (let start = 0; start < line.length; start += HARD_WINDOW - HARD_OVERLAP) {
    yield line.slice(start, start + HARD_WINDOW);
  }
}

/** Tekst UTF-16 (BOM albo naprzemienne bajty zerowe) jako tekst; null, gdy plik na to nie wyglada. */
export function utf16Text(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const sample = Math.min(bytes.length, 512) & ~1;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) evenNul += 1;
    if (bytes[i + 1] === 0) oddNul += 1;
  }
  const pairs = sample / 2;
  if (oddNul > pairs * 0.4 && evenNul < pairs * 0.1)
    return new TextDecoder('utf-16le').decode(bytes);
  if (evenNul > pairs * 0.4 && oddNul < pairs * 0.1)
    return new TextDecoder('utf-16be').decode(bytes);
  return null;
}

function scanHard(text: string, binary: boolean): HardSecretHit | null {
  const lines = binary ? [text] : text.split(/\r?\n/);
  let soft: HardSecretHit | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = binary ? null : i + 1;
    for (const chunk of windows(line)) {
      for (const rule of HARD_RULES) {
        if (rule.pattern.test(chunk)) return { reason: rule.reason, line: lineNo, hard: true };
      }
      const url = urlHit(chunk);
      if (url === 'real') return { reason: 'adres z danymi logowania', line: lineNo, hard: true };
      if (url === 'placeholder') {
        soft ??= { reason: 'adres z danymi logowania (wzor)', line: lineNo, hard: false };
      }
    }
  }
  return soft;
}

export function findHardSecret(bytes: Uint8Array): HardSecretHit | null {
  const wide = utf16Text(bytes);
  if (wide !== null) {
    const hit = scanHard(wide, false);
    if (hit?.hard === true) return hit;
    const rest = scanHard(new TextDecoder('latin1').decode(bytes), true);
    return rest?.hard === true ? rest : (hit ?? rest);
  }
  const binary = looksBinary(bytes);
  return scanHard(new TextDecoder(binary ? 'latin1' : 'utf-8').decode(bytes), binary);
}
