import {
  hasRetentionLimits,
  parseRetentionSettings,
  type RetentionReport,
} from '../../core/model/retention';
import type { RetentionSettingsStore } from '../../core/ports/retention';
import type { RetentionService } from '../../core/services/retention/retention-service';
import type { Result } from '../../shared/ipc/library-contract';
import type { RetentionReportDto, RetentionSettingsDto } from '../../shared/ipc/retention-contract';
import type { OperationLock } from './write-lock';

/**
 * Brama retencji w main (ADR 0056): zapis ustawien, podglad i wykonanie pod blokada wylaczna oraz
 * jednorazowy przebieg przy starcie. Nie zna Electrona ani systemu plikow.
 */

export interface RetentionRunnerDeps {
  readonly settings: RetentionSettingsStore;
  /** `null`, gdy biblioteka albo indeks nie sa otwarte: wtedy nie ma na czym liczyc osiagalnosci. */
  readonly service: () => RetentionService | null;
  readonly lock: OperationLock;
  readonly logUnexpected?: (error: unknown) => void;
  readonly logInfo?: (message: string) => void;
}

const BUSY_MESSAGE =
  'Trwa inna operacja zapisu, odbudowa indeksu albo czyszczenie. Poczekaj na jej koniec i spróbuj ponownie.';
const UNAVAILABLE_MESSAGE =
  'Czyszczenie historii jest niedostępne: biblioteka albo indeks nie zostały otwarte przy starcie.';
const INTERNAL_MESSAGE =
  'Wystąpił nieoczekiwany błąd czyszczenia historii. Szczegóły są w logu aplikacji.';

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Odpowiedz budowana jawnie z liczb: nic z bledu ani ze store'u nie wychodzi do renderera. */
function toDto(report: RetentionReport): RetentionReportDto {
  return {
    applied: report.applied,
    blocked: report.blocked,
    entriesBefore: report.entriesBefore,
    entriesRemoved: report.entriesRemoved,
    objectsBefore: report.objectsBefore,
    objectsRemoved: report.objectsRemoved,
    bytesBefore: report.bytesBefore,
    bytesFreed: report.bytesFreed,
    sizeLimitUnmet: report.sizeLimitUnmet,
    objectsFailed: report.objectsFailed,
    objectsSkipped: report.objectsSkipped,
  };
}

export class RetentionRunner {
  constructor(private readonly deps: RetentionRunnerDeps) {}

  async getSettings(): Promise<Result<RetentionSettingsDto>> {
    try {
      return ok({ ...(await this.deps.settings.load()) });
    } catch (error: unknown) {
      return this.internal(error);
    }
  }

  async setSettings(payload: unknown): Promise<Result<RetentionSettingsDto>> {
    const parsed = parseRetentionSettings(payload);
    if (!parsed.ok) return err('invalid-request', parsed.message);
    try {
      await this.deps.settings.save(parsed.value);
      return ok({ ...parsed.value });
    } catch (error: unknown) {
      return this.internal(error);
    }
  }

  preview(): Promise<Result<RetentionReportDto>> {
    return this.run(false);
  }

  apply(confirmed: boolean): Promise<Result<RetentionReportDto>> {
    if (!confirmed) {
      return Promise.resolve(
        err(
          'confirmation-required',
          'Czyszczenie wymaga potwierdzenia, że usunięte wpisy i obiekty nie wrócą.',
        ),
      );
    }
    return this.run(true);
  }

  /**
   * Przebieg przy starcie, tylko gdy wlaczono jakis limit (ADR 0056). Zajeta blokada to nie blad:
   * przebieg pominiety teraz wykona sie przy nastepnym starcie albo z ekranu.
   */
  async runAtStartup(): Promise<void> {
    try {
      if (!hasRetentionLimits(await this.deps.settings.load())) return;
      const result = await this.run(true);
      if (result.ok) {
        const r = result.value;
        this.deps.logInfo?.(
          `[cwm] retencja przy starcie: wpisow ${r.entriesRemoved}, obiektow ${r.objectsRemoved}, bajtow ${r.bytesFreed}` +
            (r.blocked === null ? '' : `, zablokowane: ${r.blocked}`),
        );
      }
    } catch (error: unknown) {
      this.deps.logUnexpected?.(error);
    }
  }

  private async run(apply: boolean): Promise<Result<RetentionReportDto>> {
    const service = this.deps.service();
    if (service === null) return err('unavailable', UNAVAILABLE_MESSAGE);
    const release = this.deps.lock.tryEnterExclusive();
    if (release === null) return err('busy', BUSY_MESSAGE);
    try {
      return ok(toDto(await service.run({ apply })));
    } catch (error: unknown) {
      return this.internal(error);
    } finally {
      release();
    }
  }

  private internal(error: unknown): Result<never> {
    this.deps.logUnexpected?.(error);
    return err('internal', INTERNAL_MESSAGE);
  }
}
