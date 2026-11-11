import {
  isAlias,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type YAMLError,
} from 'yaml';
import type { Result, ValidationError } from '../../core/cwm';

/**
 * Limit liczony w jednostkach UTF-16 stringa, nie w bajtach. Kto czyta plik, musi sprawdzic rozmiar
 * (`stat`) i ograniczyc odczyt w bajtach przed dekodowaniem, bo ten limit dziala dopiero na tekscie.
 */
export const MAX_MANIFEST_UTF16_UNITS = 256 * 1024;

export interface PositionedError extends ValidationError {
  readonly line: number;
  readonly col: number;
}

export type ParseYamlResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly PositionedError[] };

const OPTIONS = {
  // Schemat core YAML 1.2: bez dat, binariow i znacznikow niestandardowych.
  schema: 'core',
  version: '1.2',
  merge: false,
  uniqueKeys: true,
  strict: true,
  prettyErrors: true,
} satisfies ParseOptions & DocumentOptions & SchemaOptions;

/** Zamienia tekst YAML na dane. Nie wykonuje niczego i nie czyta plikow. */
export function parseManifestYaml(text: string): ParseYamlResult {
  if (text.length > MAX_MANIFEST_UTF16_UNITS) {
    return failAt(`Manifest jest wiekszy niz ${MAX_MANIFEST_UTF16_UNITS} jednostek UTF-16.`, 1, 1);
  }
  try {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { ...OPTIONS, lineCounter });
    // Nierozpoznany znacznik yaml zglasza jako ostrzezenie i zostawia tekst. Tu to blad.
    const problems = [...doc.errors, ...doc.warnings].map(toPositioned);
    problems.push(...forbiddenNodes(doc, lineCounter));
    if (problems.length > 0) return { ok: false, errors: problems };
    // Manifesty nie uzywaja aliasow, wiec limit 0 odrzuca kazdy (ochrona przed "billion laughs").
    return { ok: true, value: doc.toJS({ maxAliasCount: 0 }) as unknown };
  } catch (error) {
    return failAt(error instanceof Error ? error.message : 'Nieprawidlowy YAML.', 1, 1);
  }
}

/** Parsuje YAML i od razu sprawdza go walidatorem z rdzenia (np. `validateProjectManifest`). */
export function parseAndValidate<T>(
  text: string,
  validate: (input: unknown) => Result<T>,
): Result<T> | { readonly ok: false; readonly errors: readonly PositionedError[] } {
  const parsed = parseManifestYaml(text);
  return parsed.ok ? validate(parsed.value) : parsed;
}

/** Aliasy i jawne znaczniki (`!!str`, `!cos`) nie maja w manifestach zastosowania, wiec sa bledem. */
function forbiddenNodes(doc: Document, lineCounter: LineCounter): PositionedError[] {
  const found: PositionedError[] = [];
  visit(doc, {
    Node(_key, node) {
      const explicitTag = !isAlias(node) && node.tag !== undefined;
      if (!isAlias(node) && !explicitTag) return;
      const offset = node.range?.[0] ?? 0;
      const { line, col } = lineCounter.linePos(offset);
      found.push({
        path: '$',
        message: isAlias(node)
          ? 'Aliasy YAML sa zabronione.'
          : 'Jawne znaczniki YAML sa zabronione.',
        line,
        col,
      });
    },
  });
  return found;
}

function toPositioned(error: YAMLError): PositionedError {
  const position = error.linePos?.[0];
  // Pierwsza linia komunikatu, bez fragmentu zrodla, ktory prettyErrors dokleja pod spodem.
  const message = error.message.split('\n')[0] ?? error.code;
  return { path: '$', message, line: position?.line ?? 1, col: position?.col ?? 1 };
}

function failAt(message: string, line: number, col: number): ParseYamlResult {
  return { ok: false, errors: [{ path: '$', message, line, col }] };
}
