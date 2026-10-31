import {
  STORE_FAILURE_CODES,
  type CodedStoreError,
  type StoreFailureCode,
} from '../../core/ports/store-failure';

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/** `replace`: rename, unlink, rmdir, czyli operacje, ktore na Windowsie zawodza na pliku zajetym przez inny program. */
export type FsOperation = 'read' | 'write' | 'replace';

/**
 * Jedyne miejsce mapowania errno na przyczyne awarii magazynu (`StoreFailureCode`).
 * Na Windowsie EPERM/EACCES z operacji `replace` to najczesciej plik zajety przez antywirus albo
 * indekser, wiec daja `busy`; przy odczycie i zwyklym zapisie to brak uprawnien, tak jak na POSIX.
 */
export function failureCodeFromErrno(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform,
  operation: FsOperation = 'read',
): StoreFailureCode {
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'no-space';
    case 'EACCES':
    case 'EPERM':
      return platform === 'win32' && operation === 'replace' ? 'busy' : 'permission-denied';
    case 'EROFS':
      return 'permission-denied';
    case 'EBUSY':
    case 'ETXTBSY':
      return 'busy';
    case 'ELOOP':
      return 'symlink';
    case 'ENAMETOOLONG':
      return 'path-too-deep';
    default:
      return 'unknown';
  }
}

/** Surowy blad fs opakowany tak, zeby niosl `failureCode`; oryginal zostaje w `cause`. */
export class StoreIoError extends Error implements CodedStoreError {
  constructor(
    readonly failureCode: StoreFailureCode,
    override readonly cause: unknown,
  ) {
    super('blad wejscia-wyjscia magazynu');
    this.name = 'StoreIoError';
  }
}

function hasFailureCode(error: unknown): error is CodedStoreError {
  return (
    error instanceof Error &&
    'failureCode' in error &&
    STORE_FAILURE_CODES.includes(error.failureCode as StoreFailureCode)
  );
}

/** Kazdy blad wychodzacy z magazynu przechodzi tu: ma `failureCode` albo dostaje go z errno. */
export function codedError(error: unknown): Error {
  if (hasFailureCode(error)) return error;
  return new StoreIoError(failureCodeFromErrno(errnoCode(error)), error);
}

/** Jedyne opakowanie metod magazynu: kazdy rzucony blad wychodzi z `failureCode`. */
export async function guarded<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error: unknown) {
    throw codedError(error);
  }
}
