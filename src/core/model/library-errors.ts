import type { StoreFailureCode } from '../ports/store-failure';

/**
 * Bledy warstwy biblioteki. `reason` jest kodem dla kodu (testy, UI wybierajace widok),
 * `message` jest tekstem dla uzytkownika i nie zawiera sciezek systemu plikow.
 */

export type ValidationReason =
  | 'field-invalid'
  | 'kind-immutable'
  | 'slug-invalid'
  | 'slug-reserved'
  | 'slug-collision'
  | 'asset-path-empty'
  | 'asset-path-too-long'
  | 'asset-path-absolute'
  | 'asset-path-traversal'
  | 'asset-path-empty-segment'
  | 'asset-path-backslash'
  | 'asset-path-control-char'
  | 'asset-path-forbidden-char'
  | 'asset-path-trailing-dot-or-space'
  | 'asset-path-reserved-name'
  | 'asset-path-temp-name'
  | 'asset-path-junk-name'
  | 'limit-exceeded'
  | 'asset-path-collision'
  | 'asset-path-file-dir-conflict'
  | 'item-json-malformed'
  | 'item-shape-invalid'
  | 'unknown-kind'
  | 'id-mismatch'
  | 'unsupported-format'
  | 'integrity-mismatch';

export type OperationFailureReason =
  | 'not-found'
  | 'backup-failed'
  | 'store-failed'
  | 'stale-plan'
  | 'plan-blocked'
  | 'not-inconsistent'
  | 'unrecoverable-unacknowledged'
  | 'id-collision'
  | 'version-record-missing';

export interface IssueDetail {
  readonly field?: string;
  readonly path?: string;
  readonly conflictsWith?: string;
}

export interface ValidationIssue {
  readonly reason: ValidationReason;
  readonly message: string;
  readonly detail?: IssueDetail;
}

/** Ostrzezenie nie blokuje zapisu (ADR 0026). */
export interface LibraryWarning {
  readonly code: 'slug-differs-from-declared-name' | 'operation-log-failed' | 'index-update-failed';
  readonly message: string;
}

export abstract class LibraryError extends Error {
  abstract readonly reason: ValidationReason | OperationFailureReason;
}

export class LibraryValidationError extends LibraryError {
  readonly reason: ValidationReason;
  readonly detail: IssueDetail | undefined;

  constructor(readonly issues: readonly [ValidationIssue, ...ValidationIssue[]]) {
    const [first] = issues;
    super(first.message);
    this.name = 'LibraryValidationError';
    this.reason = first.reason;
    this.detail = first.detail;
  }
}

export class LibraryOperationError extends LibraryError {
  constructor(
    readonly reason: OperationFailureReason,
    message: string,
    override readonly cause?: unknown,
    /** Rozpoznana przyczyna awarii magazynu; `undefined`, gdy blad nie pochodzi z magazynu. */
    readonly failure?: StoreFailureCode,
  ) {
    super(message);
    this.name = 'LibraryOperationError';
  }
}

export function validationError(
  reason: ValidationReason,
  message: string,
  detail?: IssueDetail,
): LibraryValidationError {
  return new LibraryValidationError([
    detail === undefined ? { reason, message } : { reason, message, detail },
  ]);
}

export function issue(
  reason: ValidationReason,
  message: string,
  detail?: IssueDetail,
): ValidationIssue {
  return detail === undefined ? { reason, message } : { reason, message, detail };
}
