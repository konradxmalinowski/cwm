import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sha256, Timestamp, ToolId } from '../../core/model/item';
import type { Clock } from '../../core/ports/clock';
import { systemClock } from '../../core/ports/clock';
import { sha256Bytes } from '../../core/services/normalization/hash';
import { writeFileAtomic, type AtomicOps } from '../fs/atomic';
import { readBounded } from '../fs/bounded-read';

/**
 * Katalog `backups/<id>/` z plikiem `MANIFEST` (ADR 0019): forma kopii czytelna bez aplikacji.
 * Obok content store, ktory jest zrodlem dla rollbacku; ten katalog sluzy odzyskaniu recznemu,
 * gdyby aplikacja nie chciala sie uruchomic.
 */

export type BackupBefore =
  | { readonly state: 'missing' }
  | { readonly state: 'file'; readonly bytes: Uint8Array; readonly mode: number }
  | { readonly state: 'symlink'; readonly linkTarget: string }
  /** Zwykly katalog zastapiony w calosci: kazdy plik, takze spoza planu. */
  | {
      readonly state: 'directory';
      readonly files: readonly {
        readonly relPath: string;
        readonly bytes: Uint8Array;
        readonly mode: number;
      }[];
    };

export type BackupAfter =
  | { readonly state: 'file'; readonly bytes: Uint8Array }
  | { readonly state: 'symlink'; readonly linkTarget: string }
  /** Dowiazanie do katalogu zastapione katalogiem z plikami. */
  | { readonly state: 'directory' }
  /** Plik albo dowiazanie usuniete przy cofaniu operacji. */
  | { readonly state: 'missing' };

export interface BackupItem {
  readonly rootId: string;
  readonly relPath: string;
  /** Sciezka bezwzgledna celu: tylko w MANIFEST na dysku, nigdy w raporcie dla renderera. */
  readonly path: string;
  readonly action: string;
  readonly before: BackupBefore;
  readonly after: BackupAfter;
}

export type ManifestBefore =
  | { readonly state: 'missing' }
  | {
      readonly state: 'file';
      readonly sha256: Sha256;
      readonly size: number;
      readonly mode: string;
      readonly backupFile: string;
    }
  | { readonly state: 'symlink'; readonly linkTarget: string }
  | {
      readonly state: 'directory';
      readonly files: readonly {
        readonly relPath: string;
        readonly sha256: Sha256;
        readonly size: number;
        readonly mode: string;
        readonly backupFile: string;
      }[];
    };

export type ManifestAfter =
  | { readonly state: 'file'; readonly sha256: Sha256; readonly size: number }
  | { readonly state: 'symlink'; readonly linkTarget: string }
  | { readonly state: 'directory' }
  | { readonly state: 'missing' };

export interface ManifestEntry {
  readonly index: number;
  readonly rootId: string;
  readonly relPath: string;
  readonly path: string;
  readonly action: string;
  readonly before: ManifestBefore;
  readonly after: ManifestAfter;
}

export interface BackupManifest {
  /** Zapis zawsze `cwm-backup`; kopie z v0.1.0 maja `uasm-backup` i zostaja czytelne (ADR 0035). */
  readonly format: 'cwm-backup' | 'uasm-backup';
  readonly version: 1;
  readonly backupId: string;
  readonly createdAt: Timestamp;
  readonly planId: string;
  readonly tool: ToolId;
  /** Instrukcja odzyskania recznego, po polsku. */
  readonly note: string;
  readonly entries: readonly ManifestEntry[];
}

const MANIFEST_NAME = 'MANIFEST';
const MANIFEST_LIMIT = 16 * 1024 * 1024;

const NOTE =
  'Kopia stanu plików sprzed eksportu. Dla wpisu "file" odzyskasz plik, kopiując backupFile ' +
  '(względem tego katalogu) na path. Dla "missing" plik nie istniał: po cofnięciu należy go usunąć. ' +
  'Dla "symlink" przywróć dowiązanie o wskazanym linkTarget. ' +
  'Dla "directory" katalog path istniał i został zastąpiony: usuń to, co jest teraz pod path, ' +
  'i odtwórz katalog, kopiując każdy plik z listy files (backupFile na path/relPath).';

export class BackupError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupStoreOptions {
  readonly clock?: Clock;
  readonly atomicOps?: Partial<AtomicOps>;
}

export class FsBackupStore {
  private readonly clock: Clock;

  constructor(
    private readonly backupsDir: string,
    private readonly options: BackupStoreOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  /** Tworzy katalog kopii z plikami i MANIFEST. Przy bledzie sprzata po sobie i rzuca `BackupError`. */
  async create(
    meta: { readonly planId: string; readonly tool: ToolId },
    items: readonly BackupItem[],
  ): Promise<{ readonly backupId: string; readonly manifest: BackupManifest }> {
    const now = this.clock.now();
    // Znaczniki czasu bez ':' (Windows) i z losowym sufiksem: dwa zapisy w tej samej milisekundzie nie zderzaja sie.
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
    const backupId = `${stamp}-${randomBytes(3).toString('hex')}`;
    const dir = join(this.backupsDir, backupId);
    const writeOptions =
      this.options.atomicOps === undefined ? {} : { ops: this.options.atomicOps };

    try {
      await mkdir(this.backupsDir, { recursive: true, mode: 0o700 });
      // Bez `recursive`: kolizja nazwy jest bledem, nie cichym wspoldzieleniem katalogu.
      await mkdir(dir, { mode: 0o700 });
      await mkdir(join(dir, 'files'), { mode: 0o700 });

      const entries: ManifestEntry[] = [];
      let index = 0;
      for (const item of items) {
        index++;
        let before: ManifestBefore;
        if (item.before.state === 'file') {
          const name = `files/${String(index).padStart(4, '0')}-${safeName(item.relPath)}`;
          await writeFileAtomic(join(dir, ...name.split('/')), item.before.bytes, {
            mode: 0o600,
            ...writeOptions,
          });
          before = {
            state: 'file',
            sha256: sha256Bytes(item.before.bytes),
            size: item.before.bytes.length,
            mode: item.before.mode.toString(8).padStart(4, '0'),
            backupFile: name,
          };
        } else if (item.before.state === 'directory') {
          const files: Extract<ManifestBefore, { state: 'directory' }>['files'][number][] = [];
          let n = 0;
          for (const f of item.before.files) {
            n++;
            const name = `files/${String(index).padStart(4, '0')}-${String(n).padStart(3, '0')}-${safeName(f.relPath)}`;
            await writeFileAtomic(join(dir, ...name.split('/')), f.bytes, {
              mode: 0o600,
              ...writeOptions,
            });
            files.push({
              relPath: f.relPath,
              sha256: sha256Bytes(f.bytes),
              size: f.bytes.length,
              mode: f.mode.toString(8).padStart(4, '0'),
              backupFile: name,
            });
          }
          before = { state: 'directory', files };
        } else {
          before = item.before;
        }
        const after: ManifestAfter =
          item.after.state === 'file'
            ? {
                state: 'file',
                sha256: sha256Bytes(item.after.bytes),
                size: item.after.bytes.length,
              }
            : item.after;
        // `item.after` jest tu juz zawezone do symlink/directory, wiec pasuje do ManifestAfter.
        entries.push({
          index,
          rootId: item.rootId,
          relPath: item.relPath,
          path: item.path,
          action: item.action,
          before,
          after,
        });
      }

      const manifest: BackupManifest = {
        format: 'cwm-backup',
        version: 1,
        backupId,
        createdAt: now.toISOString(),
        planId: meta.planId,
        tool: meta.tool,
        note: NOTE,
        entries,
      };
      // MANIFEST na koncu: jego obecnosc znaczy, ze wszystkie pliki kopii juz leza na dysku.
      await writeFileAtomic(
        join(dir, MANIFEST_NAME),
        new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
        { mode: 0o600, ...writeOptions },
      );
      return { backupId, manifest };
    } catch (error: unknown) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new BackupError('Nie udało się zapisać kopii zapasowej.', error);
    }
  }

  async readManifest(backupId: string): Promise<BackupManifest> {
    if (!/^[0-9A-Za-z-]+$/.test(backupId))
      throw new BackupError('Niepoprawny identyfikator kopii.');
    const { bytes } = await readBounded(
      join(this.backupsDir, backupId, MANIFEST_NAME),
      MANIFEST_LIMIT,
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as BackupManifest;
  }

  async readBackupFile(backupId: string, backupFile: string): Promise<Uint8Array> {
    if (!/^files\/[^/\\]+$/.test(backupFile) || !/^[0-9A-Za-z-]+$/.test(backupId)) {
      throw new BackupError('Niepoprawna nazwa pliku kopii.');
    }
    return (
      await readBounded(
        join(this.backupsDir, backupId, 'files', backupFile.slice(6)),
        MANIFEST_LIMIT,
      )
    ).bytes;
  }
}

/** Nazwa pliku w kopii: sama koncowka sciezki, skrocona; pelna sciezka jest w MANIFEST. */
function safeName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const cleaned = [...base].filter((ch) => ch.charCodeAt(0) > 0x1f && !'<>:"|?*\\'.includes(ch));
  return cleaned.slice(0, 80).join('') || 'plik';
}
