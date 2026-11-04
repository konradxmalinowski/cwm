import type { ItemId } from '../../model/item';
import { MAX_FILE_BYTES } from '../../model/library-limits';
import type { WritePlanEntry } from '../../model/plan';
import type { Clock } from '../../ports/clock';
import type { SourceReader } from '../../ports/source-reader';
import type { SyncedFile, SyncRecord, SyncStateStore } from '../../ports/sync-state';
import type { ApplyObserver, ExportApplyReport, ExportPlanReport } from '../export/export-service';
import { sha256Bytes } from '../normalization/hash';
import { materialHash } from './sync-hash';

/**
 * Zapisuje `SyncRecord` po kazdym udanym `export:apply` (takze wywolanym przez synchronizacje).
 * `writtenHash` to hash bajtow faktycznie obecnych w celu: odczyt po zapisie, bo brama moze
 * dostosowac konce linii do pliku docelowego. Dla dowiazania jest to hash materializacji.
 * Plan cofniecia nie zapisuje stanu, tylko go zapomina: po cofnieciu cel nie odpowiada
 * zadnej rewizji elementu, wiec element wraca do stanu `never` i nastepny plan pokaze roznice.
 */
export class SyncRecorder implements ApplyObserver {
  constructor(
    private readonly deps: {
      readonly state: SyncStateStore;
      readonly reader: SourceReader;
      readonly clock: Clock;
    },
  ) {}

  async applied(report: ExportPlanReport, result: ExportApplyReport): Promise<void> {
    const { plan } = report;
    if (plan.reverts !== undefined) {
      for (const id of new Set(plan.entries.flatMap((e) => e.itemIds))) {
        await this.deps.state.remove(id, plan.tool).catch(() => undefined);
      }
      return;
    }
    if (!result.verified || result.rolledBack) return;

    const outcomes = new Map(result.entries.map((e) => [e.entryId, e.outcome]));
    const files = new Map<ItemId, SyncedFile[]>();
    const broken = new Set<ItemId>();

    for (const [index, entry] of plan.entries.entries()) {
      const outcome = outcomes.get(report.entryIds[index] ?? '');
      const ok = outcome === 'written' || outcome === 'unchanged';
      const synced = ok ? await this.filesOf(entry) : null;
      for (const id of entry.itemIds) {
        if (synced === null) broken.add(id);
        else files.set(id, [...(files.get(id) ?? []), ...synced]);
      }
    }

    const known = new Map(report.items.map((i) => [i.itemId, i]));
    const at = this.deps.clock.now().toISOString();
    for (const [itemId, list] of files) {
      const item = known.get(itemId);
      if (item === undefined || broken.has(itemId) || list.length === 0) continue;
      const record: SyncRecord = {
        itemId,
        tool: plan.tool,
        itemRevision: item.revision,
        itemContentHash: item.contentHash,
        files: list,
        syncedAt: at,
        backupId: result.backupId,
      };
      await this.deps.state.put(record);
    }
  }

  private async filesOf(entry: WritePlanEntry): Promise<SyncedFile[] | null> {
    const base = { rootId: entry.rootId, scope: entry.scope };
    const linked =
      (entry.materialization === 'symlink' || entry.materialization === 'junction') &&
      (entry.action === 'link' || entry.action === 'unchanged');
    if (linked) {
      return [
        {
          ...base,
          relPath: entry.relPath,
          writtenHash: materialHash(entry.content, entry.files),
          materialization: entry.materialization ?? 'symlink',
        },
      ];
    }
    const targets: string[] =
      entry.files !== null
        ? entry.files.map((f) =>
            entry.relPath === '' ? f.relPath : `${entry.relPath}/${f.relPath}`,
          )
        : entry.content !== null || entry.action === 'unchanged'
          ? [entry.relPath]
          : [];
    if (targets.length === 0) return null;
    const out: SyncedFile[] = [];
    for (const relPath of targets) {
      try {
        const bytes = await this.deps.reader.read(entry.rootId, relPath, MAX_FILE_BYTES);
        out.push({ ...base, relPath, writtenHash: sha256Bytes(bytes) });
      } catch {
        return null;
      }
    }
    return out;
  }
}
