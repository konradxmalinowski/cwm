import type { ToolId } from '../model/item';

/**
 * Odczyt kopii `backups/<id>/` zrobionej przed zapisem do narzedzia (ADR 0019). Widok MANIFEST
 * bez sciezek bezwzglednych: core zna tylko `rootId` i sciezke wzgledna roota.
 */
export type BackupBeforeView =
  | { readonly state: 'missing' }
  | { readonly state: 'file'; readonly sha256: string; readonly backupFile: string }
  | { readonly state: 'symlink'; readonly linkTarget: string }
  /** Katalog zastapiony w calosci; `relPath` plikow wzgledem tego katalogu. */
  | {
      readonly state: 'directory';
      readonly files: readonly {
        readonly relPath: string;
        readonly sha256: string;
        readonly mode: number;
        readonly backupFile: string;
      }[];
    };

export type BackupAfterView =
  | { readonly state: 'file'; readonly sha256: string }
  | { readonly state: 'symlink'; readonly linkTarget: string }
  | { readonly state: 'directory' }
  | { readonly state: 'missing' };

export interface BackupEntryView {
  readonly rootId: string;
  readonly relPath: string;
  readonly before: BackupBeforeView;
  readonly after: BackupAfterView;
}

export interface BackupManifestView {
  readonly backupId: string;
  readonly tool: ToolId;
  readonly entries: readonly BackupEntryView[];
}

export interface BackupReader {
  /** Rzuca, gdy kopii nie ma albo MANIFEST jest nieczytelny albo ma zly ksztalt. */
  readManifest(backupId: string): Promise<BackupManifestView>;
  readFile(backupId: string, backupFile: string): Promise<Uint8Array>;
}
