import { TOOL_IDS, type ItemId, type ToolId } from '../../model/item';
import { MAX_FILE_BYTES } from '../../model/library-limits';
import type { PlanConflict, WritePlan, WritePlanEntry } from '../../model/plan';
import type { BackupEntryView, BackupReader } from '../../ports/backup-reader';
import type { OperationGroup, OperationLogReader } from '../../ports/operation-log';
import { SourceReadError, type SourceReader } from '../../ports/source-reader';
import type { Clock } from '../../ports/clock';
import type { ExportPlanReport, ExportService } from '../export/export-service';
import { sha256Bytes } from '../normalization/hash';
import { nameOf, parentOf } from '../sync/sync-hash';

/**
 * Historia i cofanie (ADR 0019). Historia to log operacji z indeksu, pogrupowany po kopii.
 * Cofniecie buduje plan zapisu z `backups/<id>/MANIFEST` i oddaje go `ExportService`, wiec
 * idzie zwyklym `export:apply`: z sondowaniem, zatwierdzeniem, wlasna kopia i wpisem w logu.
 * Dzieki temu cofniecie cofniecia dziala tak samo jak kazde inne.
 */

export type HistoryErrorCode =
  'unknown-operation' | 'not-revertible' | 'already-reverted' | 'backup-unreadable';

export class HistoryError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HistoryError';
  }
}

export interface HistoryEntry {
  readonly operationId: string;
  readonly at: string;
  readonly kind: string;
  readonly tool: ToolId | null;
  readonly summary: string;
  readonly itemIds: readonly string[];
  readonly revertible: boolean;
  readonly revertedBy: string | null;
}

export interface HistoryServiceDeps {
  readonly log: OperationLogReader;
  readonly backups: BackupReader;
  readonly reader: SourceReader;
  readonly exports: Pick<ExportService, 'adopt'>;
  readonly clock: Clock;
}

const DEFAULT_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;
const TOOL_NAMES: Record<ToolId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const WRITE_KINDS = new Set(['export', 'sync', 'rollback']);

type Current =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly bytes: Uint8Array }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'blocked' };

function plural(n: number): string {
  if (n === 1) return '1 element';
  const last = n % 10;
  return last >= 2 && last <= 4 && (n % 100 < 10 || n % 100 >= 20)
    ? `${n} elementy`
    : `${n} elementów`;
}

function kindOf(group: OperationGroup): string {
  const ops = new Set(group.rows.map((r) => r.operation));
  for (const kind of ['rollback', 'sync', 'export'] as const) if (ops.has(kind)) return kind;
  return group.rows[0]?.operation ?? 'unknown';
}

function summaryOf(kind: string, group: OperationGroup, count: number): string {
  const tool = group.rows.find((r) => r.tool !== undefined)?.tool;
  const toolName = tool === undefined ? 'narzędzia' : TOOL_NAMES[tool];
  const slug = group.rows[0]?.slug;
  const named = slug === null || slug === undefined ? 'element' : `element ${slug}`;
  switch (kind) {
    case 'export':
      return `Eksport do ${toolName}: ${plural(count)}`;
    case 'sync':
      return `Synchronizacja z ${toolName}: ${plural(count)}`;
    case 'rollback':
      return `Cofnięcie zapisu do ${toolName}: ${plural(count)}`;
    case 'create':
      return `Utworzono ${named}`;
    case 'update':
      return `Zmieniono ${named}`;
    case 'delete':
      return `Usunięto ${named}`;
    case 'adopt-disk':
      return `Przyjęto stan z dysku dla: ${named}`;
    case 'restore':
      return `Przywrócono wersję: ${named}`;
    case 'rebuild-index':
      return 'Odbudowano indeks biblioteki';
    default:
      return 'Operacja';
  }
}

export class HistoryService {
  constructor(private readonly deps: HistoryServiceDeps) {}

  async list(limit?: number, before?: string): Promise<readonly HistoryEntry[]> {
    const size = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)), MAX_HISTORY_LIMIT);
    const groups = await this.deps.log.groups(size, before);
    const entries: HistoryEntry[] = [];
    for (const group of groups) entries.push(await this.entryOf(group));
    return entries;
  }

  private async entryOf(group: OperationGroup): Promise<HistoryEntry> {
    const kind = kindOf(group);
    // Wpis odbudowy indeksu nie dotyczy zadnego elementu: jego `itemId` to stala.
    const itemIds =
      kind === 'rebuild-index' ? [] : [...new Set(group.rows.map((r) => r.itemId as string))];
    const backupId = group.rows.find((r) => r.backupId !== undefined)?.backupId ?? null;
    const writes = WRITE_KINDS.has(kind) && backupId !== null;
    const revertedBy =
      writes && backupId !== null ? await this.deps.log.revertedBy(backupId) : null;
    return {
      operationId: group.key,
      at: group.rows[0]?.at ?? '',
      kind,
      tool: group.rows.find((r) => r.tool !== undefined)?.tool ?? null,
      summary: summaryOf(kind, group, itemIds.length),
      itemIds,
      revertible: writes && revertedBy === null,
      revertedBy,
    };
  }

  /** Plan przywrocenia stanu sprzed operacji; zastosowanie to zwykle `export:apply` z jego `planId`. */
  async rollback(operationId: string): Promise<ExportPlanReport> {
    const group = await this.deps.log.group(operationId);
    if (group === null)
      throw new HistoryError('unknown-operation', 'Nie znaleziono tej operacji w historii.');
    const kind = kindOf(group);
    const backupId = group.rows.find((r) => r.backupId !== undefined)?.backupId;
    if (!WRITE_KINDS.has(kind) || backupId === undefined) {
      throw new HistoryError(
        'not-revertible',
        'Tej operacji nie da się cofnąć: nie zapisała nic w narzędziu.',
      );
    }
    if ((await this.deps.log.revertedBy(backupId)) !== null) {
      throw new HistoryError('already-reverted', 'Ta operacja została już cofnięta.');
    }

    let manifest;
    try {
      manifest = await this.deps.backups.readManifest(backupId);
    } catch {
      throw new HistoryError(
        'backup-unreadable',
        'Kopia zapasowa tej operacji jest niedostępna albo uszkodzona.',
      );
    }
    if (!(TOOL_IDS as readonly string[]).includes(manifest.tool)) {
      throw new HistoryError('backup-unreadable', 'Kopia zapasowa tej operacji jest uszkodzona.');
    }

    const itemIds = [...new Set(group.rows.map((r) => r.itemId))] as ItemId[];
    const entries: WritePlanEntry[] = [];
    const conflicts: PlanConflict[] = [];
    for (const m of manifest.entries) {
      const built = await this.restoreEntry(backupId, m, itemIds);
      if (built === null) continue;
      if ('conflict' in built)
        conflicts.push({ itemIds, relPath: m.relPath, reason: built.conflict });
      else entries.push(built);
    }

    const draft: WritePlan = {
      planId: 'cofniecie',
      tool: manifest.tool,
      createdAt: this.deps.clock.now().toISOString(),
      entries,
      verdicts: [],
      refusals: [],
      conflicts,
      orphans: [],
      applicable: false,
      reverts: backupId,
    };
    return this.deps.exports.adopt(draft);
  }

  private async restoreEntry(
    backupId: string,
    m: BackupEntryView,
    itemIds: readonly ItemId[],
  ): Promise<WritePlanEntry | { conflict: string } | null> {
    if (m.before.state === 'directory')
      return this.restoreDirectory(backupId, m, m.before, itemIds);
    if (m.after.state === 'directory') {
      return {
        conflict:
          'Zapis zamienił dowiązanie do katalogu w katalog z plikami. Tego nie cofnę automatycznie; kopia jest w katalogu kopii zapasowych.',
      };
    }
    const cur = await this.currentOf(m.rootId, m.relPath);
    if (cur.kind === 'blocked') {
      return {
        conflict: 'Nie da się sprawdzić obecnego stanu pliku albo w jego miejscu jest katalog.',
      };
    }
    const base = {
      rootId: m.rootId,
      relPath: m.relPath,
      scope: 'whole-file' as const,
      itemIds,
      files: null,
      materialization: null,
      recoverability: null,
    };
    const previous = cur.kind === 'file' ? cur.bytes : null;
    const changedSince =
      cur.kind === 'file' && m.after.state === 'file' && sha256Bytes(cur.bytes) !== m.after.sha256;
    const warnings = changedSince
      ? [
          'Plik zmienił się po tej operacji. Cofnięcie nadpisze późniejsze zmiany; przed zapisem powstanie kopia.',
        ]
      : [];

    switch (m.before.state) {
      case 'missing':
        if (cur.kind === 'missing') return null;
        return { ...base, action: 'delete', content: null, previous, warnings };
      case 'symlink':
        return {
          ...base,
          action: 'restore-link',
          content: null,
          previous,
          linkTarget: m.before.linkTarget,
          warnings,
        };
      case 'file': {
        let bytes: Uint8Array;
        try {
          bytes = await this.deps.backups.readFile(backupId, m.before.backupFile);
        } catch {
          return { conflict: 'Plik w kopii zapasowej jest nieczytelny.' };
        }
        if (sha256Bytes(bytes) !== m.before.sha256) {
          return { conflict: 'Plik w kopii zapasowej nie zgadza się z sumą w MANIFEST.' };
        }
        const same = cur.kind === 'file' && sha256Bytes(cur.bytes) === m.before.sha256;
        return {
          ...base,
          action: same ? 'unchanged' : cur.kind === 'missing' ? 'create' : 'modify',
          content: bytes,
          previous,
          warnings,
        };
      }
    }
  }

  /**
   * Katalog zastapiony przez zapis: wpis katalogowy z pelna lista plikow z kopii. Brama zastapi
   * to, co jest teraz pod sciezka (dowiazanie aplikacji albo zwykly katalog), i zrobi wlasna kopie.
   */
  private async restoreDirectory(
    backupId: string,
    m: BackupEntryView,
    before: Extract<BackupEntryView['before'], { state: 'directory' }>,
    itemIds: readonly ItemId[],
  ): Promise<WritePlanEntry | { conflict: string }> {
    const files: { relPath: string; bytes: Uint8Array; mode: number }[] = [];
    for (const f of before.files) {
      let bytes: Uint8Array;
      try {
        bytes = await this.deps.backups.readFile(backupId, f.backupFile);
      } catch {
        return { conflict: 'Plik w kopii zapasowej jest nieczytelny.' };
      }
      if (sha256Bytes(bytes) !== f.sha256) {
        return { conflict: 'Plik w kopii zapasowej nie zgadza się z sumą w MANIFEST.' };
      }
      files.push({ relPath: f.relPath, bytes, mode: f.mode });
    }
    if (files.length === 0) {
      return { conflict: 'Kopia katalogu jest pusta, więc nie ma czego przywrócić.' };
    }
    let exists: boolean;
    try {
      const entries = await this.deps.reader.list(m.rootId, parentOf(m.relPath));
      const found = entries.find((e) => e.name === nameOf(m.relPath));
      if (found !== undefined && found.type === 'file') {
        return { conflict: 'W miejscu katalogu leży teraz plik. Nie zastąpię go katalogiem.' };
      }
      exists = found !== undefined;
    } catch (error: unknown) {
      if (!(error instanceof SourceReadError && error.failure === 'not-found')) {
        return { conflict: 'Nie da się sprawdzić obecnego stanu katalogu.' };
      }
      exists = false;
    }
    return {
      rootId: m.rootId,
      relPath: m.relPath,
      action: exists ? 'modify' : 'create',
      scope: 'whole-file',
      itemIds,
      content: null,
      files,
      previous: null,
      materialization: null,
      warnings: [
        'Cofnięcie zastąpi obecną zawartość katalogu stanem sprzed zapisu. Przed zapisem powstanie kopia.',
      ],
      recoverability: null,
    };
  }

  private async currentOf(rootId: string, relPath: string): Promise<Current> {
    try {
      const entries = await this.deps.reader.list(rootId, parentOf(relPath));
      const entry = entries.find((e) => e.name === nameOf(relPath));
      if (entry === undefined) return { kind: 'missing' };
      if (entry.type === 'symlink') return { kind: 'symlink' };
      if (entry.type !== 'file') return { kind: 'blocked' };
      return {
        kind: 'file',
        bytes: await this.deps.reader.read(rootId, relPath, MAX_FILE_BYTES),
      };
    } catch (error: unknown) {
      if (error instanceof SourceReadError && error.failure === 'not-found')
        return { kind: 'missing' };
      return { kind: 'blocked' };
    }
  }
}
