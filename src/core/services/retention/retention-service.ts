import type { ItemId, Sha256 } from '../../model/item';
import type { RetentionBlockReason, RetentionReport } from '../../model/retention';
import type { BackupReader } from '../../ports/backup-reader';
import type { Clock } from '../../ports/clock';
import type { ObjectStore } from '../../ports/object-store';
import type { OperationLog } from '../../ports/operation-log';
import type {
  ObjectInventory,
  RetentionLibrary,
  RetentionLog,
  RetentionSettingsStore,
} from '../../ports/retention';
import { childHashes } from './object-refs';
import { groupLogRows, planRetention, type RetentionGroup } from './retention-plan';

/**
 * Przebieg retencji (ADR 0056): mark-and-sweep nad content store z suchym przebiegiem.
 *
 * Kolejnosc przy wykonaniu jest czescia gwarancji: najpierw znikaja wiersze logu (jedna transakcja,
 * trwala przed dalszymi krokami), dopiero potem pliki obiektow. Przerwanie w srodku zostawia
 * obiekty bez odwolan, a nastepny przebieg je usunie; odwrotna kolejnosc zostawialaby wpisy
 * historii wskazujace na brakujace obiekty. Wolajacy trzyma blokade wylaczna na zapisy: bez niej
 * obiekt wlozony przez trwajacy zapis (przed dopisaniem wiersza logu) wygladalby na osierocony.
 */

export interface RetentionServiceDeps {
  readonly log: RetentionLog;
  readonly objects: ObjectStore;
  readonly inventory: ObjectInventory;
  readonly backups: BackupReader;
  readonly library: RetentionLibrary;
  readonly settings: RetentionSettingsStore;
  /** Wpis `prune-history` w logu; `null`, gdy log jest niedostepny. */
  readonly audit: () => OperationLog | null;
  readonly clock: Clock;
  readonly onUnexpected?: (error: unknown) => void;
}

/** Wpis logu przyciecia nie dotyczy elementu; kolumna `item_id` jest obowiazkowa. */
const RETENTION_ITEM_ID = 'retention' as ItemId;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface Resolution {
  /** `true`, gdy ktorys korzen nie dal sie odczytac, wiec jego dzieci sa nieznane. */
  unreadable: boolean;
}

export class RetentionService {
  constructor(private readonly deps: RetentionServiceDeps) {}

  /**
   * Suchy przebieg (`apply: false`) liczy to samo co wykonanie, ale niczego nie zmienia.
   * Obiekty osierocone przez wczesniej przerwany przebieg sa liczone tak samo jak inne bez odwolan.
   */
  async run(options: { readonly apply: boolean }): Promise<RetentionReport> {
    const settings = await this.deps.settings.load();
    const rows = await this.deps.log.rows();
    const logGroups = groupLogRows(rows);
    const listing = await this.deps.inventory.list();
    const resolution: Resolution = { unreadable: false };
    const cache = new Map<Sha256, readonly Sha256[]>();

    const library = await this.deps.library.roots();
    if (library.unreadable > 0) {
      return this.blocked('library-unreadable', logGroups.length, listing);
    }
    const libraryHashes = await this.closure(library.hashes, cache, resolution);

    const groups: RetentionGroup[] = [];
    for (const group of logGroups) {
      const closed = await this.closure(group.rootHashes, cache, resolution);
      const backup = group.backupId === null ? [] : await this.backupHashes(group.backupId);
      groups.push({ ...group, hashes: [...new Set([...closed, ...backup])] });
    }
    if (resolution.unreadable) return this.blocked('object-unreadable', logGroups.length, listing);

    const plan = planRetention({
      settings,
      nowMs: this.deps.clock.now().getTime(),
      groups,
      libraryHashes,
      objectSizes: listing.objects,
    });

    const base = {
      blocked: null,
      entriesBefore: plan.entriesBefore,
      objectsBefore: plan.objectsBefore,
      bytesBefore: plan.bytesBefore,
      sizeLimitUnmet: plan.sizeLimitUnmet,
      objectsSkipped: listing.skipped,
    } as const;

    if (!options.apply) {
      return {
        ...base,
        applied: false,
        entriesRemoved: plan.pruneKeys.length,
        objectsRemoved: plan.sweep.length,
        bytesFreed: plan.bytesToFree,
        objectsFailed: 0,
      };
    }

    if (plan.pruneSeqs.length > 0) await this.deps.log.deleteRows(plan.pruneSeqs);

    let objectsRemoved = 0;
    let objectsFailed = 0;
    let bytesFreed = 0;
    for (const hash of plan.sweep) {
      try {
        if (await this.deps.inventory.remove(hash)) {
          objectsRemoved += 1;
          bytesFreed += listing.objects.get(hash) ?? 0;
        }
      } catch (error: unknown) {
        // Plik zostaje bez odwolan i zniknie w nastepnym przebiegu.
        objectsFailed += 1;
        this.deps.onUnexpected?.(error);
      }
    }

    const report: RetentionReport = {
      ...base,
      applied: true,
      entriesRemoved: plan.pruneKeys.length,
      objectsRemoved,
      bytesFreed,
      objectsFailed,
    };
    if (report.entriesRemoved > 0 || report.objectsRemoved > 0) await this.record(report);
    return report;
  }

  private blocked(
    reason: RetentionBlockReason,
    entries: number,
    listing: { readonly objects: ReadonlyMap<Sha256, number>; readonly skipped: number },
  ): RetentionReport {
    let bytes = 0;
    for (const size of listing.objects.values()) bytes += size;
    return {
      applied: false,
      blocked: reason,
      entriesBefore: entries,
      entriesRemoved: 0,
      objectsBefore: listing.objects.size,
      objectsRemoved: 0,
      bytesBefore: bytes,
      bytesFreed: 0,
      sizeLimitUnmet: false,
      objectsFailed: 0,
      objectsSkipped: listing.skipped,
    };
  }

  /** Korzenie i obiekty, na ktore te wskazuja. Nieczytelny korzen blokuje przebieg, bo jego dzieci sa nieznane. */
  private async closure(
    roots: readonly Sha256[],
    cache: Map<Sha256, readonly Sha256[]>,
    resolution: Resolution,
  ): Promise<readonly Sha256[]> {
    const out = new Set<Sha256>();
    for (const root of roots) {
      out.add(root);
      let children = cache.get(root);
      if (children === undefined) {
        children = await this.childrenOf(root, resolution);
        cache.set(root, children);
      }
      for (const child of children) out.add(child);
    }
    return [...out];
  }

  private async childrenOf(hash: Sha256, resolution: Resolution): Promise<readonly Sha256[]> {
    try {
      const bytes = await this.deps.objects.get(hash);
      return bytes === null ? [] : childHashes(bytes);
    } catch (error: unknown) {
      resolution.unreadable = true;
      this.deps.onUnexpected?.(error);
      return [];
    }
  }

  /** Kopie z MANIFEST wpisu. Brak kopii na dysku nie blokuje: cofniecie takiego wpisu i tak by sie nie udalo. */
  private async backupHashes(backupId: string): Promise<readonly Sha256[]> {
    let manifest;
    try {
      manifest = await this.deps.backups.readManifest(backupId);
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const entry of manifest.entries) {
      if (entry.before.state === 'file') found.push(entry.before.sha256);
      if (entry.before.state === 'directory') {
        for (const file of entry.before.files) found.push(file.sha256);
      }
    }
    return found.filter((hash) => HASH_PATTERN.test(hash)) as Sha256[];
  }

  /** Awaria wpisu w logu nie cofa przyciecia: to ono juz sie stalo. */
  private async record(report: RetentionReport): Promise<void> {
    const log = this.deps.audit();
    if (log === null) return;
    try {
      await log.append({
        operation: 'prune-history',
        itemId: RETENTION_ITEM_ID,
        itemKind: null,
        slug: null,
        at: this.deps.clock.now().toISOString(),
        before: null,
        after: null,
        note:
          `wpisow: ${report.entriesRemoved}, obiektow: ${report.objectsRemoved}, ` +
          `bajtow: ${report.bytesFreed}`,
      });
    } catch (error: unknown) {
      this.deps.onUnexpected?.(error);
    }
  }
}
