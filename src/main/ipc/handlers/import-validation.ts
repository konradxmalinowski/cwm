import { gitRefInputProblem, gitUrlInputProblem } from '../../../core/services/import/git-input';
import type {
  ImportApplyRequest,
  ImportScanGitRequest,
  ImportScanRequest,
} from '../../../shared/ipc/import-contract';
import type { Parsed } from './library-validation';

/**
 * Walidacja ladunkow `import:*` (ARCHITECTURE 7.2, regula 2). Zadne pole nie niesie sciezki:
 * renderer podaje wylacznie identyfikatory z poprzedniej odpowiedzi main.
 */

const BAD_SHAPE = 'Nieprawidłowe żądanie.';
const MAX_ID = 128;
const MAX_ROOTS = 32;
const MAX_CANDIDATES = 5000;
/** Zapas ponad 64 znaki slugu: dluzsza nazwe odrzuci walidator slugow z czytelnym komunikatem, a nie limit ladunku. */
const MAX_RENAME_LENGTH = 256;

function fail<T>(field?: string): Parsed<T> {
  return {
    ok: false,
    message: field === undefined ? BAD_SHAPE : `${BAD_SHAPE} Pole „${field}” jest niepoprawne.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ID) return null;
    out.push(entry);
  }
  return out;
}

export function parseScanRequest(payload: unknown): Parsed<ImportScanRequest> {
  if (!isRecord(payload)) return fail();
  const rootIds = idList(payload['rootIds'], MAX_ROOTS);
  if (rootIds === null || rootIds.length === 0) return fail('rootIds');
  return { ok: true, value: { rootIds } };
}

/**
 * `import:scan-git`: adres i ref sa tekstem z pola formularza, wiec main sprawdza je od nowa tym samym
 * kodem co renderer. Nazwa schematu, danych logowania, zapytania i formy kanonicznej jest sprawdzana tu,
 * a nie w rendererze, bo renderer nie jest granica zaufania. Komunikat nigdy nie zawiera adresu.
 */
export function parseScanGitRequest(payload: unknown): Parsed<ImportScanGitRequest> {
  if (!isRecord(payload)) return fail();
  const rawUrl = payload['url'];
  if (typeof rawUrl !== 'string') return fail('url');
  const url = rawUrl.trim();
  const urlProblem = gitUrlInputProblem(url);
  if (urlProblem !== null) return { ok: false, message: urlProblem };
  const rawRef = payload['ref'];
  if (rawRef === undefined) return { ok: true, value: { url } };
  if (typeof rawRef !== 'string') return fail('ref');
  const ref = rawRef.trim();
  const refProblem = gitRefInputProblem(ref);
  if (refProblem !== null) return { ok: false, message: refProblem };
  return { ok: true, value: ref === '' ? { url } : { url, ref } };
}

/**
 * Mapa `candidateId` na nowy slug. Obiekt bez prototypu, zeby klucz `__proto__` z ladunku nie
 * zmienil jego prototypu; klucze musza nalezec do wybranych kandydatow. Sam slug waliduje serwis,
 * bo tylko on zna biblioteke i reszte partii.
 */
function renameMap(value: unknown, selected: ReadonlySet<string>): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_CANDIDATES) return null;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [candidateId, slug] of entries) {
    if (candidateId.length === 0 || candidateId.length > MAX_ID || !selected.has(candidateId)) {
      return null;
    }
    if (typeof slug !== 'string' || slug.length > MAX_RENAME_LENGTH) return null;
    out[candidateId] = slug;
  }
  return out;
}

export function parseApplyRequest(payload: unknown): Parsed<ImportApplyRequest> {
  if (!isRecord(payload)) return fail();
  const { scanToken } = payload;
  if (typeof scanToken !== 'string' || scanToken.length === 0 || scanToken.length > MAX_ID) {
    return fail('scanToken');
  }
  const candidateIds = idList(payload['candidateIds'], MAX_CANDIDATES);
  if (candidateIds === null) return fail('candidateIds');

  const value: ImportApplyRequest = { scanToken, candidateIds };
  for (const field of ['confirmedSecrets', 'replaceChanged'] as const) {
    const raw = payload[field];
    if (raw === undefined) continue;
    const list = idList(raw, MAX_CANDIDATES);
    if (list === null) return fail(field);
    value[field] = list;
  }
  if (payload['renames'] !== undefined) {
    const renames = renameMap(payload['renames'], new Set(candidateIds));
    if (renames === null) return fail('renames');
    value.renames = renames;
  }
  return { ok: true, value };
}
