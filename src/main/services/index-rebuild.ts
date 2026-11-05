import { randomBytes } from 'node:crypto';

import { NOT_RECOVERABLE_FROM_FILES, type IndexStartupInfo } from '../../core/model/index-health';
import type { Clock } from '../../core/ports/clock';
import type { IndexStore } from '../../core/ports/index-store';
import type { ItemId } from '../../core/model/item';
import type { OperationLog } from '../../core/ports/operation-log';
import type { LibraryService } from '../../core/services/library/library-service';
import type {
  RebuildIndexPlanDto,
  RebuildIndexReportDto,
} from '../../shared/ipc/diagnostics-contract';
import type { Result } from '../../shared/ipc/library-contract';
import type { IndexOpenFailure } from '../bootstrap/index-startup';
import { notRestoredLines } from '../bootstrap/library-index';
import { stripPaths } from './diagnostics';
import type { OperationLock } from './write-lock';

/**
 * Reczna odbudowa indeksu z Diagnostyki (ADR 0030): plan, potem zastosowanie.
 *
 * Modul nie zna Electrona ani systemu plikow. Plik indeksu, kwarantanne i sonde dostaje jako
 * zamkniecia zwiazane w main ze sciezkami, ktorych renderer nigdy nie widzi.
 */

export interface IndexSnapshot {
  readonly store: IndexStore | null;
  readonly info: IndexStartupInfo;
}

export interface IndexRuntime {
  current(): IndexSnapshot;
  replace(next: IndexSnapshot): void;
}

export interface QuarantineProbeResult {
  readonly indexFilePresent: boolean;
  readonly status: 'recoverable' | 'blocked';
  readonly reason: string | null;
}

export interface IndexRebuildDeps {
  readonly runtime: IndexRuntime;
  readonly library: () => LibraryService | null;
  readonly lock: OperationLock;
  readonly clock: Clock;
  /** Sonda odczytem: czy obecny plik da sie odlozyc do kwarantanny. */
  readonly probe: () => QuarantineProbeResult;
  /** Przenosi plik indeksu do kwarantanny pod nazwa z `stamp`. Rzuca, gdy sie nie uda. */
  readonly quarantine: (stamp: string) => void;
  readonly openStore: () => IndexStore;
  readonly describeFailure: (error: unknown) => IndexOpenFailure | null;
  /** Log operacji nowego indeksu, albo `null`, gdy magazyn go nie ma. */
  readonly operationLogOf: (store: IndexStore) => OperationLog | null;
  readonly logUnexpected?: (error: unknown) => void;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly newPlanId?: () => string;
}

export const REBUILD_PLAN_TTL_MS = 10 * 60 * 1000;
/** Wpis logu odbudowy nie dotyczy elementu; kolumna `item_id` jest obowiazkowa. */
const INDEX_ITEM_ID = 'index' as ItemId;
const MAX_PENDING_PLANS = 8;
const MAX_REPORTED = 200;

interface Fingerprint {
  readonly itemDirs: number;
  readonly itemsToRestore: number;
  readonly outcome: IndexStartupInfo['outcome'];
  readonly reason: string | undefined;
  readonly indexFilePresent: boolean;
}

interface PendingPlan {
  readonly expiresAt: number;
  readonly fingerprint: Fingerprint;
  readonly stamp: string;
  readonly quarantineName: string;
  readonly blocked: boolean;
}

class RebuildStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RebuildStepError';
  }
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

const BUSY_MESSAGE =
  'Trwa inna operacja zapisu albo odbudowa indeksu. Poczekaj na jej koniec i spróbuj ponownie.';
const NATIVE_BLOCKED =
  'Moduł natywny bazy się nie ładuje. Odbudowa indeksu tego nie naprawi, bo problem nie leży w danych.';
const NOT_WRITABLE_BLOCKED =
  'Katalog danych aplikacji nie jest zapisywalny. Odbudowa wymaga zapisu, więc nie zostanie uruchomiona.';

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.itemDirs === b.itemDirs &&
    a.itemsToRestore === b.itemsToRestore &&
    a.outcome === b.outcome &&
    a.reason === b.reason &&
    a.indexFilePresent === b.indexFilePresent
  );
}

export class IndexRebuildService {
  private readonly plans = new Map<string, PendingPlan>();

  constructor(private readonly deps: IndexRebuildDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private purgeExpired(): void {
    const t = this.now();
    for (const [id, pending] of this.plans) {
      if (pending.expiresAt <= t) this.plans.delete(id);
    }
    while (this.plans.size >= MAX_PENDING_PLANS) {
      const oldest = this.plans.keys().next();
      if (oldest.done === true) break;
      this.plans.delete(oldest.value);
    }
  }

  private async fingerprint(library: LibraryService): Promise<Fingerprint> {
    const listed = await library.list();
    const { info } = this.deps.runtime.current();
    return {
      itemDirs: listed.items.length + listed.inconsistent.length + listed.problems.length,
      itemsToRestore: listed.items.length,
      outcome: info.outcome,
      reason: info.reason,
      indexFilePresent: this.deps.probe().indexFilePresent,
    };
  }

  private stampNow(): string {
    return this.deps.clock.now().toISOString().replace(/[:.]/g, '-');
  }

  async plan(): Promise<Result<RebuildIndexPlanDto>> {
    if (this.deps.lock.isRebuilding()) return err('busy', BUSY_MESSAGE);
    const library = this.deps.library();
    if (library === null) {
      return err(
        'library-unavailable',
        'Biblioteka jest niedostępna, więc nie ma z czego odbudować indeksu.',
      );
    }
    try {
      const fingerprint = await this.fingerprint(library);
      const { info } = this.deps.runtime.current();
      const probe = this.deps.probe();

      let blockedReason: string | null = null;
      if (info.outcome === 'refused' && info.reason === 'native-module') {
        blockedReason = NATIVE_BLOCKED;
      } else if (info.outcome === 'refused' && info.reason === 'not-writable') {
        blockedReason = NOT_WRITABLE_BLOCKED;
      } else if (probe.status === 'blocked') {
        blockedReason = probe.reason;
      }

      const stamp = this.stampNow();
      // Gdy pliku indeksu nie ma (np. odbudowa automatyczna padla po kwarantannie), nie ma czego odkladac.
      const quarantineName = probe.indexFilePresent ? `index-${stamp}.sqlite` : '';

      this.purgeExpired();
      const planId = (
        this.deps.newPlanId ?? ((): string => randomBytes(18).toString('base64url'))
      )();
      this.plans.set(planId, {
        expiresAt: this.now() + (this.deps.ttlMs ?? REBUILD_PLAN_TTL_MS),
        fingerprint,
        stamp,
        quarantineName,
        blocked: blockedReason !== null,
      });

      return ok({
        planId,
        quarantineName,
        itemsToRestore: fingerprint.itemsToRestore,
        notRecoverable: [...NOT_RECOVERABLE_FROM_FILES],
        currentOutcome: info.outcome,
        currentReason: info.message === undefined ? null : stripPaths(info.message),
        recoverability: blockedReason === null ? 'recoverable' : 'blocked',
        blockedReason,
      });
    } catch (error: unknown) {
      this.deps.logUnexpected?.(error);
      return err('internal', 'Nie udało się przygotować planu odbudowy indeksu.');
    }
  }

  async apply(planId: string, confirmed: boolean): Promise<Result<RebuildIndexReportDto>> {
    if (!confirmed) {
      return err(
        'confirmation-required',
        'Odbudowa wymaga potwierdzenia utraty logu operacji i stanu synchronizacji.',
      );
    }
    const release = this.deps.lock.tryEnterRebuild();
    if (release === null) return err('busy', BUSY_MESSAGE);
    try {
      return await this.applyLocked(planId);
    } catch (error: unknown) {
      if (error instanceof RebuildStepError) return err(error.code, error.message);
      this.deps.logUnexpected?.(error);
      return err(
        'internal',
        'Wystąpił nieoczekiwany błąd odbudowy indeksu. Szczegóły są w logu aplikacji.',
      );
    } finally {
      release();
    }
  }

  private async applyLocked(planId: string): Promise<Result<RebuildIndexReportDto>> {
    this.purgeExpired();
    const pending = this.plans.get(planId);
    if (pending === undefined) {
      return err(
        'plan-expired',
        'Plan odbudowy wygasł albo nie istnieje. Przygotuj go jeszcze raz.',
      );
    }
    // Plan jest jednorazowy: kazde zastosowanie, udane albo odrzucone, go zuzywa.
    this.plans.delete(planId);

    if (pending.blocked) {
      return err(
        'plan-blocked',
        'Odbudowa jest zablokowana: nie da się bezpiecznie odłożyć obecnego indeksu do kwarantanny.',
      );
    }
    const library = this.deps.library();
    if (library === null) {
      return err(
        'library-unavailable',
        'Biblioteka jest niedostępna, więc nie ma z czego odbudować indeksu.',
      );
    }
    const fresh = await this.fingerprint(library);
    if (!sameFingerprint(fresh, pending.fingerprint)) {
      return err(
        'stale-plan',
        'Stan na dysku zmienił się od przygotowania planu. Przygotuj go jeszcze raz.',
      );
    }

    let report;
    try {
      report = await library.syncIndex({ force: true, prepare: () => this.swapIndex(pending) });
    } catch (error: unknown) {
      if (error instanceof RebuildStepError) throw error;
      // Nowy indeks istnieje, ale nie dal sie wypelnic. Stary jest w kwarantannie.
      this.deps.logUnexpected?.(error);
      this.markFillFailed(pending.quarantineName);
      throw new RebuildStepError(
        'rebuild-failed',
        'Stary indeks został odłożony do kwarantanny, ale nie udało się wypełnić nowego z plików. Wyszukiwanie korzysta z plików.',
      );
    }
    if (report.status === 'unavailable') {
      throw new RebuildStepError('rebuild-failed', 'Nowy indeks nie jest dostępny.');
    }

    const notRestored = notRestoredLines(report.failed);
    const snapshot = this.deps.runtime.current();
    this.deps.runtime.replace({
      store: snapshot.store,
      info: {
        ...snapshot.info,
        restoredItems: report.restored,
        notRestored,
      },
    });
    await this.recordInLog(
      snapshot.store,
      pending.quarantineName,
      report.restored,
      report.failed.length,
    );

    return ok({
      quarantineName: pending.quarantineName,
      restoredItems: report.restored,
      failedItems: report.failed
        .slice(0, MAX_REPORTED)
        .map((f) => ({ id: f.id, reason: f.reason })),
      notRecoverable: [...NOT_RECOVERABLE_FROM_FILES],
    });
  }

  /** Zamyka obecny indeks, odklada plik do kwarantanny i otwiera nowy; wolane w kolejce biblioteki. */
  private swapIndex(pending: PendingPlan): void {
    const before = this.deps.runtime.current();
    this.deps.runtime.replace({ store: null, info: before.info });
    try {
      before.store?.close();
    } catch (error: unknown) {
      this.deps.logUnexpected?.(error);
    }

    if (pending.quarantineName !== '') {
      try {
        this.deps.quarantine(pending.stamp);
      } catch (cause: unknown) {
        // Plik zostal na miejscu, wiec otwieramy go z powrotem. Nie ma wariantu "usun i sprobuj".
        try {
          this.deps.runtime.replace({ store: this.deps.openStore(), info: before.info });
        } catch {
          this.deps.runtime.replace({ store: null, info: before.info });
        }
        this.deps.logUnexpected?.(cause);
        throw new RebuildStepError(
          'quarantine-failed',
          'Nie udało się odłożyć obecnego indeksu do kwarantanny, więc odbudowa nie została wykonana. Indeks jest bez zmian.',
        );
      }
    }

    try {
      const store = this.deps.openStore();
      this.deps.runtime.replace({
        store,
        info: {
          outcome: 'rebuilt',
          message: 'Indeks został odbudowany ręcznie z Diagnostyki.',
          ...(pending.quarantineName === '' ? {} : { quarantinedAs: pending.quarantineName }),
          restoredItems: 0,
          notRestored: [...NOT_RECOVERABLE_FROM_FILES],
        },
      });
    } catch (cause: unknown) {
      const failure = this.deps.describeFailure(cause);
      this.deps.runtime.replace({
        store: null,
        info: {
          outcome: 'refused',
          ...(failure === null ? {} : { reason: failure.reason }),
          message: `odbudowa indeksu nie przeszla: ${failure?.message ?? 'nieznana przyczyna'}`,
          ...(pending.quarantineName === '' ? {} : { quarantinedAs: pending.quarantineName }),
        },
      });
      this.deps.logUnexpected?.(cause);
      throw new RebuildStepError(
        'rebuild-failed',
        'Obecny indeks został odłożony do kwarantanny, ale nie udało się utworzyć nowego.',
      );
    }
  }

  private markFillFailed(quarantineName: string): void {
    const snapshot = this.deps.runtime.current();
    this.deps.runtime.replace({
      store: snapshot.store,
      info: {
        ...snapshot.info,
        restoredItems: 0,
        notRestored: [
          'zawartosc biblioteki (nie udalo sie wypelnic indeksu z plikow)',
          ...NOT_RECOVERABLE_FROM_FILES,
        ],
        ...(quarantineName === '' ? {} : { quarantinedAs: quarantineName }),
      },
    });
  }

  /** Wpis `rebuild-index` w logu nowego indeksu (ADR 0030). Awaria logu nie cofa odbudowy. */
  private async recordInLog(
    store: IndexStore | null,
    quarantineName: string,
    restored: number,
    failed: number,
  ): Promise<void> {
    const log = store === null ? null : this.deps.operationLogOf(store);
    if (log === null) return;
    try {
      await log.append({
        operation: 'rebuild-index',
        itemId: INDEX_ITEM_ID,
        itemKind: null,
        slug: null,
        at: this.deps.clock.now().toISOString(),
        before: null,
        after: null,
        note:
          `odbudowano z plikow: ${restored} elementow, nie wczytano: ${failed}` +
          (quarantineName === '' ? '' : `; stary indeks: ${quarantineName}`),
      });
    } catch (error: unknown) {
      this.deps.logUnexpected?.(error);
    }
  }
}
