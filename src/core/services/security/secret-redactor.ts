import {
  ASSIGNMENT,
  ENTROPY_MIN_LENGTH,
  KNOWN_PATTERNS,
  LONG_TOKEN,
  SENSITIVE_KEY,
  classifyFileName,
  isEntropyCandidate,
  looksLikeSecretValue,
  type SecretRule,
} from './secret-classifier';

/**
 * Redakcja trafien klasyfikatora w tekscie (ARCHITECTURE 8.4). Trafienie zamieniamy na znacznik
 * `[ukryty sekret: <regula>]`, reszta linii zostaje, zeby diff i log dalo sie czytac. Funkcja jest
 * czysta: te same reguly co `classifySecrets`, ale zamiast opisu trafienia zwraca tekst.
 */

export interface RedactionResult {
  readonly text: string;
  /** Reguly, ktore zadzialaly, bez powtorzen. Nigdy wartosci. */
  readonly rules: readonly SecretRule[];
}

export function secretMarker(rule: SecretRule): string {
  return `[ukryty sekret: ${rule}]`;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly rule: SecretRule;
}

const PRIVATE_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const GLOBAL_KNOWN = KNOWN_PATTERNS.map((p) => new RegExp(p.pattern.source, 'g'));
const VALUE_AFTER_SEPARATOR = /^(\s*["']?[^=:"']+["']?\s*[:=]\s*)(\S.*)$/;
const PUNCTUATION_ONLY = /^[\s{}[\],]*$/;

function lineSpans(line: string): Span[] {
  const spans: Span[] = [];
  for (const re of GLOBAL_KNOWN) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length, rule: 'known-key' });
    }
  }
  ASSIGNMENT.lastIndex = 0;
  for (const m of line.matchAll(ASSIGNMENT)) {
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    if (SENSITIVE_KEY.test(key) && looksLikeSecretValue(value)) {
      const end = m.index + m[0].length;
      spans.push({ start: end - value.length, end, rule: 'key-name' });
    }
  }
  for (const m of line.matchAll(LONG_TOKEN)) {
    if (m[0].length >= ENTROPY_MIN_LENGTH && isEntropyCandidate(m[0])) {
      spans.push({ start: m.index, end: m.index + m[0].length, rule: 'entropy' });
    }
  }
  return spans;
}

function applySpans(line: string, spans: readonly Span[], used: Set<SecretRule>): string {
  if (spans.length === 0) return line;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) {
      // Trafienie nakladajace sie na poprzednie: zostaje jeden znacznik.
      continue;
    }
    out += line.slice(cursor, span.start) + secretMarker(span.rule);
    used.add(span.rule);
    cursor = span.end;
  }
  return out + line.slice(cursor);
}

function redactFileNameLine(line: string, used: Set<SecretRule>): string {
  if (PUNCTUATION_ONLY.test(line)) return line;
  used.add('file-name');
  const m = VALUE_AFTER_SEPARATOR.exec(line);
  return m === null ? secretMarker('file-name') : `${m[1] ?? ''}${secretMarker('file-name')}`;
}

/**
 * Redaguje tekst. `relPath` jest opcjonalne: plik o nazwie wskazujacej na dane uwierzytelniajace
 * (`auth.json`, `.env`, `*.pem`) traci wartosci w calosci, bo jego tresc jest sekretem z definicji.
 */
export function redactSecrets(text: string, relPath?: string): RedactionResult {
  const used = new Set<SecretRule>();
  const wholeFile = relPath !== undefined && classifyFileName(relPath) !== null;
  const parts = text.split(/(\r?\n)/);
  let inPrivateKey = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    if (line.length === 0) continue;
    if (inPrivateKey) {
      if (PRIVATE_END.test(line)) inPrivateKey = false;
      parts[i] = secretMarker('known-key');
      used.add('known-key');
      continue;
    }
    if (PRIVATE_BEGIN.test(line)) {
      inPrivateKey = !PRIVATE_END.test(line);
      parts[i] = secretMarker('known-key');
      used.add('known-key');
      continue;
    }
    parts[i] = wholeFile ? redactFileNameLine(line, used) : applySpans(line, lineSpans(line), used);
  }
  return { text: parts.join(''), rules: [...used] };
}
