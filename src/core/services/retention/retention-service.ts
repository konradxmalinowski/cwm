import type { ItemId, Sha256 } from '../../model/item';
import type {
  RetentionBlockReason,
  RetentionReport,
  RetentionSettings,
} from '../../model/retention';
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
import {
  MIN_KEPT_GROUPS,
  groupLogRows,
  planRetention,
  type RetentionGroup,
} from './retention-plan';

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
  /** Szew testowy: produkcja zawsze uzywa `MIN_KEPT_GROUPS`. */
  readonly minKeepGroups?: number;
}

export interface RetentionRunOptions {
  readonly apply: boolean;
  /** Limity zamiast zapisanych (podglad zmiany, ktora jeszcze nie jest zapisana). */
  readonly settings?: RetentionSettings;
  /** Przebieg bez udzialu uzytkownika (start aplikacji): ostrzejsze bezpieczniki. */
  readonly unattended?: boolean;
  /** Wykonanie przerywa sie, gdy przeliczony plan usuwa wiecej, niz pokazal podglad. */
  readonly ceiling?: { readonly entries: number; readonly objects: number };
}

/** Wpis logu przyciecia nie dotyczy elementu; kolumna `item_id` jest obowiazkowa. */
const RETENTION_ITEM_ID = 'retention' as ItemId;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
/** Przebieg bez nadzoru nie usuwa wiecej niz ta czesc wpisow. */
const UNATTENDED_MAX_PRUNE_RATIO = 0.9;

interface Closure {
  readonly hashes: readonly Sha256[];
  /** Ktorys korzen jest uszkodzony, nieczytelny albo go brakuje. */
  readonly unreadable: boolean;
}

interface Children {
  readonly hashes: readonly Sha256[];
  readonly readable: boolean;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class RetentionService {
  constructor(private readonly deps: RetentionServiceDeps) {}

  /**
   * Suchy przebieg (`apply: false`) liczy to samo co wykonanie, ale niczego nie zmienia.
   * Obiekty osierocone przez wczesniej przerwany przebieg sa liczone tak samo jak inne bez odwolan.
   *
   * Znane ograniczenie (zaakceptowane): wolajacy trzyma blokade wylaczna przez caly przebieg, tez
   * podczas odczytu korzeni, wiec przy duzej historii zapisy dostaja `busy` przez dluzszy czas.
   * Raport postepu albo limit czasu to otwarta sprawa.
   */
  async run(options: RetentionRunOptions): Promise<RetentionReport> {
    const settings = options.settings ?? (await this.deps.settings.load());
    const rows = await this.deps.log.rows();
    const logGroups = groupLogRows(rows);
    const listing = await this.deps.inventory.list();
    const cache = new Map<Sha256, Children>();
    const blocked = (reason: RetentionBlockReason): RetentionReport =>
      this.blocked(reason, logGroups.length, listing);

    const library = await this.deps.library.roots();
    if (library.rootMissing) return blocked('library-missing');
    if (library.unreadable > 0) return blocked('library-unreadable');
    if (library.hashes.length === 0 && logGroups.length > 0 && listing.objects.size > 0) {
      return blocked('library-empty');
    }
    const libraryClosure = await this.closure(library.hashes, cache);
    if (libraryClosure.unreadable) return blocked('object-unreadable');

    const groups: RetentionGroup[] = [];
    for (const group of logGroups) {
      const closed = await this.closure(group.rootHashes, cache);
      const backup = group.backupId === null ? null : await this.backupHashes(group.backupId);
      groups.push({
        ...group,
        hashes: [...new Set([...closed.hashes, ...(backup?.hashes ?? [])])],
        unreadable: closed.unreadable || backup?.readable === false,
      });
    }

    const plan = planRetention({
      settings,
      nowMs: this.deps.clock.now().getTime(),
      groups,
      libraryHashes: libraryClosure.hashes,
      objectSizes: listing.objects,
      minKeepGroups: this.deps.minKeepGroups ?? MIN_KEPT_GROUPS,
    });

    // Nieczytelny korzen grupy, ktora i tak znika, nie jest przeszkoda; w zachowanej grupie tak,
    // bo jej dzieci sa nieznane i mogly by zostac uznane za sieroty.
    const pruned = new Set(plan.pruneKeys);
    if (groups.some((g) => g.unreadable === true && !pruned.has(g.key))) {
      return blocked('object-unreadable');
    }
    if (options.unattended === true) {
      if (logGroups.length === 0 && plan.sweep.length > 0) return blocked('empty-log');
      if (plan.pruneKeys.length > plan.entriesBefore * UNATTENDED_MAX_PRUNE_RATIO) {
        return blocked('mass-prune');
      }
    }
    const { ceiling } = options;
    if (
      options.apply &&
      ceiling !== undefined &&
      (plan.pruneKeys.length > ceiling.entries || plan.sweep.length > ceiling.objects)
    ) {
      return blocked('plan-changed');
    }

    const base = {
      blocked: null,
      entriesBefore: plan.entriesBefore,
      objectsBefore: plan.objectsBefore,
      bytesBefore: plan.bytesBefore,
      sizeLimitUnmet: plan.sizeLimitUnmet,
      objectsSkipped: listing.skipped,
      ageRuleSkipped: plan.ageRuleSkipped,
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
      ageRuleSkipped: false,
    };
  }

  /** Korzenie i obiekty, na ktore te wskazuja. Nieczytelny albo brakujacy korzen jest zgloszony, bo jego dzieci sa nieznane. */
  private async closure(roots: readonly Sha256[], cache: Map<Sha256, Children>): Promise<Closure> {
    const out = new Set<Sha256>();
    let unreadable = false;
    for (const root of roots) {
      out.add(root);
      let children = cache.get(root);
      if (children === undefined) {
        children = await this.childrenOf(root);
        cache.set(root, children);
      }
      if (!children.readable) unreadable = true;
      for (const child of children.hashes) out.add(child);
    }
    return { hashes: [...out], unreadable };
  }

  private async childrenOf(hash: Sha256): Promise<Children> {
    try {
      const bytes = await this.deps.objects.get(hash);
      // Korzen z wiersza logu albo z biblioteki, ktorego nie ma w store, to historia z dziura:
      // nie wiadomo, na co wskazywal.
      return bytes === null
        ? { hashes: [], readable: false }
        : { hashes: childHashes(bytes), readable: true };
    } catch (error: unknown) {
      this.deps.onUnexpected?.(error);
      return { hashes: [], readable: false };
    }
  }

  /**
   * Kopie z MANIFEST wpisu. Brak katalogu kopii (ENOENT) nie blokuje: cofniecie takiego wpisu i tak
   * by sie nie udalo. Kazdy inny blad (uprawnienia, uszkodzony MANIFEST) to kopia nieczytelna.
   */
  private async backupHashes(backupId: string): Promise<Children> {
    let manifest;
    try {
      manifest = await this.deps.backups.readManifest(backupId);
    } catch (error: unknown) {
      if (isNotFound(error)) return { hashes: [], readable: true };
      this.deps.onUnexpected?.(error);
      return { hashes: [], readable: false };
    }
    const found: string[] = [];
    for (const entry of manifest.entries) {
      if (entry.before.state === 'file') found.push(entry.before.sha256);
      if (entry.before.state === 'directory') {
        for (const file of entry.before.files) found.push(file.sha256);
      }
    }
    return { hashes: found.filter((hash) => HASH_PATTERN.test(hash)) as Sha256[], readable: true };
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
