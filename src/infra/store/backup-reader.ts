import type { ToolId } from '../../core/model/item';
import type {
  BackupAfterView,
  BackupBeforeView,
  BackupEntryView,
  BackupManifestView,
  BackupReader,
} from '../../core/ports/backup-reader';
import type { FsBackupStore } from './backup';

/**
 * Czytnik kopii dla historii. MANIFEST leży na dysku, wiec jego ksztalt sprawdzamy jak kazde
 * wejscie: zly format to blad, a nie zapis czegokolwiek na jego podstawie.
 */

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function before(raw: unknown): BackupBeforeView | null {
  const r = rec(raw);
  if (r === null) return null;
  if (r['state'] === 'missing') return { state: 'missing' };
  if (r['state'] === 'symlink') {
    const linkTarget = str(r['linkTarget']);
    return linkTarget === null ? null : { state: 'symlink', linkTarget };
  }
  if (r['state'] === 'file') {
    const sha256 = str(r['sha256']);
    const backupFile = str(r['backupFile']);
    return sha256 === null || backupFile === null ? null : { state: 'file', sha256, backupFile };
  }
  if (r['state'] === 'directory') {
    const list = r['files'];
    if (!Array.isArray(list)) return null;
    const files: { relPath: string; sha256: string; mode: number; backupFile: string }[] = [];
    for (const raw of list as unknown[]) {
      const f = rec(raw);
      const relPath = str(f?.['relPath']);
      const sha256 = str(f?.['sha256']);
      const backupFile = str(f?.['backupFile']);
      const mode = Number.parseInt(str(f?.['mode']) ?? '', 8);
      if (relPath === null || sha256 === null || backupFile === null) return null;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) return null;
      files.push({ relPath, sha256, mode, backupFile });
    }
    return { state: 'directory', files };
  }
  return null;
}

function after(raw: unknown): BackupAfterView | null {
  const r = rec(raw);
  if (r === null) return null;
  if (r['state'] === 'directory' || r['state'] === 'missing') return { state: r['state'] };
  if (r['state'] === 'symlink') {
    const linkTarget = str(r['linkTarget']);
    return linkTarget === null ? null : { state: 'symlink', linkTarget };
  }
  if (r['state'] === 'file') {
    const sha256 = str(r['sha256']);
    return sha256 === null ? null : { state: 'file', sha256 };
  }
  return null;
}

export function parseManifestView(raw: unknown): BackupManifestView {
  const r = rec(raw);
  const backupId = str(r?.['backupId']);
  const tool = str(r?.['tool']);
  const list = r?.['entries'];
  if (r === null || r['format'] !== 'uasm-backup' || r['version'] !== 1) {
    throw new Error('nieznany format kopii');
  }
  if (backupId === null || tool === null || !Array.isArray(list)) {
    throw new Error('niepelny MANIFEST');
  }
  const entries: BackupEntryView[] = (list as unknown[]).map((e) => {
    const x = rec(e);
    const rootId = str(x?.['rootId']);
    const relPath = str(x?.['relPath']);
    const b = before(x?.['before']);
    const a = after(x?.['after']);
    if (rootId === null || relPath === null || b === null || a === null) {
      throw new Error('niepoprawny wpis MANIFEST');
    }
    return { rootId, relPath, before: b, after: a };
  });
  return { backupId, tool: tool as ToolId, entries };
}

export function fsBackupReader(store: FsBackupStore): BackupReader {
  return {
    readManifest: async (backupId) => parseManifestView(await store.readManifest(backupId)),
    readFile: (backupId, backupFile) => store.readBackupFile(backupId, backupFile),
  };
}
