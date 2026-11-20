import { createHash, randomBytes } from 'node:crypto';

import {
  hasRetentionLimits,
  parseRetentionSettings,
  type RetentionBlockReason,
  type RetentionReport,
  type RetentionSettings,
} from '../../core/model/retention';
import type { RetentionSettingsStore } from '../../core/ports/retention';
import type { RetentionService } from '../../core/services/retention/retention-service';
import type { Result } from '../../shared/ipc/library-contract';
import type { RetentionReportDto, RetentionStateDto } from '../../shared/ipc/retention-contract';
import type { OperationLock } from './write-lock';
import {
  CONFIRM_BUSY_MESSAGE,
  CONFIRM_CANCELLED_CODE,
  retentionCleanConfirmation,
  retentionTightenConfirmation,
  type ConfirmPort,
} from './native-confirm';

/**
 * Brama retencji w main (ADR 0056): zapis ustawien, podglad i wykonanie pod blokada wylaczna oraz
 * jednorazowy przebieg przy starcie. Nie zna Electrona ani systemu plikow.
 */

export interface RetentionRunnerDeps {
  readonly settings: RetentionSettingsStore;
  /** `null`, gdy biblioteka albo indeks nie sa otwarte: wtedy nie ma na czym liczyc osiagalnosci. */
  readonly service: () => RetentionService | null;
  readonly lock: OperationLock;
  /** Natywne okno w main (ADR 0063): autorytatywne potwierdzenie usuniecia i zaostrzenia limitu. */
  readonly confirm: ConfirmPort;
  readonly logUnexpected?: (error: unknown) => void;
  readonly logInfo?: (message: string) => void;
  readonly now?: () => number;
}

const BUSY_MESSAGE =
  'Trwa inna operacja zapisu, odbudowa indeksu albo czyszczenie. Poczekaj na jej koniec i spróbuj ponownie.';
const UNAVAILABLE_MESSAGE =
  'Czyszczenie historii jest niedostępne: biblioteka albo indeks nie zostały otwarte przy starcie.';
const INTERNAL_MESSAGE =
  'Wystąpił nieoczekiwany błąd czyszczenia historii. Szczegóły są w logu aplikacji.';
const CANCELLED_MESSAGE = 'Anulowano w oknie potwierdzenia. Nic nie zostało zmienione.';
const STALE_AFTER_DIALOG_MESSAGE =
  'Ustawienia zmieniły się albo podgląd wygasł w trakcie potwierdzania. Nic nie zostało usunięte. Sprawdź, ile zwolni, jeszcze raz.';

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Zapis, ktory wlacza limit albo go zmniejsza, moze przy najblizszym przebiegu usunac wiecej niz dotad. */
export function isTightening(current: RetentionSettings, next: RetentionSettings): boolean {
  const tighter = (a: number | null, b: number | null): boolean =>
    b !== null && (a === null || b < a);
  return (
    tighter(current.maxEntries, next.maxEntries) ||
    tighter(current.maxAgeDays, next.maxAgeDays) ||
    tighter(current.maxStoreMiB, next.maxStoreMiB)
  );
}

function sameSettings(a: RetentionSettings, b: RetentionSettings): boolean {
  return (
    a.maxEntries === b.maxEntries &&
    a.maxAgeDays === b.maxAgeDays &&
    a.maxStoreMiB === b.maxStoreMiB
  );
}

/** Token podgladu zyje krotko i sluzy raz: po tym czasie uzytkownik dostaje swiezy podglad. */
export const PREVIEW_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_TOKENS = 8;

interface PendingPreview {
  readonly expiresAt: number;
  readonly entries: number;
  readonly objects: number;
  readonly bytes: number;
  readonly settings: RetentionSettings;
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Odpowiedz budowana jawnie z liczb: nic z bledu ani ze store'u nie wychodzi do renderera. */
function toDto(report: RetentionReport, previewToken: string | null): RetentionReportDto {
  return {
    previewToken,
    ageRuleSkipped: report.ageRuleSkipped,
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
  private readonly previews = new Map<string, PendingPreview>();
  private startupNotice: RetentionBlockReason | null = null;

  constructor(private readonly deps: RetentionRunnerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async getSettings(): Promise<Result<RetentionStateDto>> {
    try {
      return ok(this.state(await this.deps.settings.load()));
    } catch (error: unknown) {
      return this.internal(error);
    }
  }

  /**
   * Zapis wlaczajacy albo zaostrzajacy limit wymaga `confirmed: true`: uzytkownik ma wczesniej
   * obejrzec podglad (ADR 0056), bo nastepny start usunalby wpisy bez pytania.
   */
  async setSettings(payload: unknown): Promise<Result<RetentionStateDto>> {
    const parsed = parseRetentionSettings(payload);
    if (!parsed.ok) return err('invalid-request', parsed.message);
    const confirmed =
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { confirmed?: unknown }).confirmed === true;
    try {
      const current = await this.deps.settings.load();
      if (isTightening(current, parsed.value)) {
        if (!confirmed) {
          return err(
            'confirmation-required',
            'Włączenie albo zaostrzenie limitu wymaga potwierdzenia po obejrzeniu podglądu, bo kolejne czyszczenie usunie wpisy historii.',
          );
        }
        // Przebieg przy starcie usuwa bez pytania, wiec to okno jest ostatnim potwierdzeniem (ADR 0063).
        const outcome = await this.deps.confirm.confirm(
          retentionTightenConfirmation(current, parsed.value),
        );
        if (outcome === 'busy') return err('busy', CONFIRM_BUSY_MESSAGE);
        if (outcome !== 'accept') return err(CONFIRM_CANCELLED_CODE, CANCELLED_MESSAGE);
      }
      await this.deps.settings.save(parsed.value);
      return ok(this.state(parsed.value));
    } catch (error: unknown) {
      return this.internal(error);
    }
  }

  /** Bez `settings` w ladunku podglad liczy na zapisanych ustawieniach. */
  async preview(payload?: unknown): Promise<Result<RetentionReportDto>> {
    let candidate: RetentionSettings | undefined;
    const raw =
      typeof payload === 'object' && payload !== null ? (payload as { settings?: unknown }) : null;
    if (raw?.settings !== undefined) {
      const parsed = parseRetentionSettings(raw.settings);
      if (!parsed.ok) return err('invalid-request', parsed.message);
      candidate = parsed.value;
    }
    return this.run({ apply: false, ...(candidate === undefined ? {} : { settings: candidate }) });
  }

  async apply(confirmed: boolean, token: string): Promise<Result<RetentionReportDto>> {
    if (!confirmed) {
      return err(
        'confirmation-required',
        'Czyszczenie wymaga potwierdzenia, że usunięte wpisy i obiekty nie wrócą.',
      );
    }
    const pending = this.previews.get(token);
    // Token jest jednorazowy: kazde uzycie, udane albo odrzucone, go zuzywa.
    this.previews.delete(token);
    if (pending === undefined || pending.expiresAt <= this.now()) {
      return err(
        'plan-expired',
        'Podgląd wygasł albo nie istnieje. Sprawdź, ile zwolni, jeszcze raz.',
      );
    }
    try {
      if (!sameSettings(await this.deps.settings.load(), pending.settings)) {
        return err(
          'stale-plan',
          'Ustawienia zmieniły się od podglądu. Sprawdź, ile zwolni, jeszcze raz.',
        );
      }
    } catch (error: unknown) {
      return this.internal(error);
    }
    // Okno przed blokada wylaczna: decyzja uzytkownika nie wstrzymuje zapisow. Liczby z podgladu w main.
    const outcome = await this.deps.confirm.confirm(
      retentionCleanConfirmation({
        entries: pending.entries,
        objects: pending.objects,
        bytes: pending.bytes,
      }),
    );
    if (outcome === 'busy') return err('busy', CONFIRM_BUSY_MESSAGE);
    if (outcome !== 'accept') return err(CONFIRM_CANCELLED_CODE, CANCELLED_MESSAGE);
    const result = await this.run({
      apply: true,
      ceiling: { entries: pending.entries, objects: pending.objects },
      recheck: pending,
    });
    if (result.ok && result.value.blocked === 'plan-changed') {
      return err(
        'plan-changed',
        'Stan zmienił się od podglądu i czyszczenie usunęłoby więcej, niż pokazano. Nic nie zostało usunięte. Sprawdź podgląd jeszcze raz.',
      );
    }
    return result;
  }

  /**
   * Przebieg przy starcie, tylko gdy wlaczono jakis limit (ADR 0056). `skip` to powod, dla ktorego
   * log tego startu nie jest wiarygodny (nowy, odbudowany albo odlozony indeks). Zajeta blokada to
   * nie blad: przebieg pominiety teraz wykona sie przy nastepnym starcie albo z ekranu.
   */
  async runAtStartup(skip: RetentionBlockReason | null = null): Promise<void> {
    try {
      if (!hasRetentionLimits(await this.deps.settings.load())) return;
      if (skip !== null) {
        this.startupNotice = skip;
        return;
      }
      const result = await this.run({ apply: true, unattended: true });
      if (result.ok) {
        const r = result.value;
        this.startupNotice = r.blocked;
        this.deps.logInfo?.(
          `[cwm] retencja przy starcie: wpisow ${r.entriesRemoved}, obiektow ${r.objectsRemoved}, bajtow ${r.bytesFreed}` +
            (r.blocked === null ? '' : `, zablokowane: ${r.blocked}`),
        );
      }
    } catch (error: unknown) {
      this.deps.logUnexpected?.(error);
    }
  }

  private state(settings: RetentionSettings): RetentionStateDto {
    return { ...settings, startupNotice: this.startupNotice };
  }

  private async run(options: {
    apply: boolean;
    settings?: RetentionSettings;
    unattended?: boolean;
    ceiling?: { entries: number; objects: number };
    /** Podglad, ktory potwierdzono w oknie: sprawdzany jeszcze raz pod blokada wylaczna. */
    recheck?: PendingPreview;
  }): Promise<Result<RetentionReportDto>> {
    const service = this.deps.service();
    if (service === null) return err('unavailable', UNAVAILABLE_MESSAGE);
    const release = this.deps.lock.tryEnterExclusive();
    if (release === null) return err('busy', BUSY_MESSAGE);
    try {
      // Okno trwalo poza blokada: limity i waznosc podgladu moglyby sie zmienic w trakcie decyzji.
      const { recheck } = options;
      if (
        recheck !== undefined &&
        (recheck.expiresAt <= this.now() ||
          !sameSettings(await this.deps.settings.load(), recheck.settings))
      ) {
        return err('stale-plan', STALE_AFTER_DIALOG_MESSAGE);
      }
      const report = await service.run(options);
      let token: string | null = null;
      if (!options.apply && report.blocked === null) {
        token = this.issueToken(report, options.settings ?? (await this.deps.settings.load()));
      }
      return ok(toDto(report, token));
    } catch (error: unknown) {
      return this.internal(error);
    } finally {
      release();
    }
  }

  /** Hash liczb planu i czasu z losowa sola; sam hash nie niesie uprawnienia, liczy sie wpis w pamieci main. */
  private issueToken(report: RetentionReport, settings: RetentionSettings): string {
    const t = this.now();
    for (const [key, pending] of this.previews) {
      if (pending.expiresAt <= t) this.previews.delete(key);
    }
    while (this.previews.size >= MAX_TOKENS) {
      const oldest = this.previews.keys().next();
      if (oldest.done === true) break;
      this.previews.delete(oldest.value);
    }
    const token = createHash('sha256')
      .update(`${report.entriesRemoved}:${report.objectsRemoved}:${report.bytesFreed}:${t}:`)
      .update(randomBytes(16))
      .digest('hex');
    this.previews.set(token, {
      expiresAt: t + PREVIEW_TOKEN_TTL_MS,
      entries: report.entriesRemoved,
      objects: report.objectsRemoved,
      bytes: report.bytesFreed,
      settings,
    });
    return token;
  }

  private internal(error: unknown): Result<never> {
    this.deps.logUnexpected?.(error);
    return err('internal', INTERNAL_MESSAGE);
  }
}
