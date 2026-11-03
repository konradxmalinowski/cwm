import type { RootId } from '../model/item';

/**
 * Odczyt drzewa narzedzia tylko do odczytu (ARCHITECTURE 5.1, ADR 0022). Adapter zna
 * wylacznie `RootId` i sciezki wzgledne z `/`; sciezka bezwzgledna nie wychodzi poza infra.
 */
export type SourceEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SourceEntry {
  readonly name: string;
  readonly type: SourceEntryType;
  /** Rozmiar w bajtach dla `file`, inaczej null. */
  readonly size: number | null;
}

export type SourceReadFailure =
  'not-found' | 'permission-denied' | 'too-large' | 'not-a-file' | 'outside-root' | 'unknown';

export class SourceReadError extends Error {
  constructor(
    readonly failure: SourceReadFailure,
    readonly relPath: string,
    message: string,
  ) {
    super(message);
    this.name = 'SourceReadError';
  }
}

export interface SymlinkTarget {
  /** Cel wzgledem tego samego roota albo null, gdy dowiazanie wychodzi poza root. */
  readonly relPath: string | null;
  /** Stabilny klucz celu do wykrywania aliasow (ten sam plik pod dwiema nazwami). */
  readonly identity: string | null;
}

export interface SourceReader {
  /** `relPath` pusty to sam root. Rzuca `SourceReadError`, nigdy nie idzie za dowiazaniem. */
  list(root: RootId, relPath: string): Promise<readonly SourceEntry[]>;
  /** Czyta zwykly plik do `maxBytes`; wiekszy daje `too-large`. Nie idzie za dowiazaniem. */
  read(root: RootId, relPath: string, maxBytes: number): Promise<Uint8Array>;
  /** Rozwiazuje dowiazanie wylacznie w obrebie roota. */
  resolveSymlink(root: RootId, relPath: string): Promise<SymlinkTarget>;
  /** Tryb pliku na POSIX, null tam, gdzie nie ma sensu (Windows). */
  mode(root: RootId, relPath: string): Promise<number | null>;
}
