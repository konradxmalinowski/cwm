import { randomBytes } from 'node:crypto';

import {
  parseLibraryGitSettings,
  type LibraryGitOperation,
  type LibraryGitSettings,
} from '../../core/model/library-git';
import type { LibraryGit, LibraryGitSettingsStore } from '../../core/ports/library-git';
import type { Result } from '../../shared/ipc/library-contract';
import type { IpcChannel } from '../../shared/ipc/channels';
import type { VersioningStateDto } from '../../shared/ipc/versioning-contract';
import type { OperationLock } from './write-lock';

/**
 * Kanaly zapisujace biblioteke i typ operacji w temacie commita (ADR 0060). `history:rollback`,
 * `export:apply` i `sync:apply` zapisuja poza biblioteka (konfiguracje narzedzi), wiec ich tu nie ma.
 */
export const VERSIONED_CHANNELS: Readonly<Partial<Record<IpcChannel, LibraryGitOperation>>> = {
  'library:save': 'save',
  'library:delete-apply': 'delete',
  'library:repair': 'repair',
  'import:apply': 'import',
  'projects:remove': 'detach',
};

export interface LibraryGitRunnerDeps {
  readonly settings: LibraryGitSettingsStore;
  readonly git: LibraryGit;
  readonly lock: OperationLock;
  readonly logUnexpected?: (error: unknown) => void;
  readonly logInfo?: (message: string) => void;
  readonly logWarn?: (message: string) => void;
  readonly now?: () => number;
  readonly newNonce?: () => string;
}

const BUSY_MESSAGE =
  'Trwa odbudowa indeksu albo czyszczenie historii. Poczekaj na jej koniec i spróbuj ponownie.';
const INTERNAL_MESSAGE =
  'Wystąpił nieoczekiwany błąd wersjonowania. Szczegóły są w logu aplikacji.';
const CONSENT_REQUIRED_MESSAGE =
  'Dołączenie elementów prywatnych wymaga potwierdzenia, że ich treść trafi do historii Git i w niej zostanie.';
const CONSENT_EXPIRED_MESSAGE =
  'Potwierdzenie wygasło albo zostało już użyte. Odśwież stan i potwierdź jeszcze raz.';

/** Jednorazowy znacznik zgody zyje krotko: wydaje go odczyt stanu, a zapis zgody go zuzywa (ADR 0060, punkt 6). */
export const CONSENT_NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_NONCES = 16;

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Brama wersjonowania w main (ADR 0060). Commit po operacji biblioteki idzie w osobnej kolejce, po
 * zwolnieniu blokady zapisu operacji, i nigdy nie zmienia jej wyniku: awaria gita to ostrzezenie
 * w stanie, nie blad. Kazda synchronizacja doprowadza repozytorium do aktualnego stanu biblioteki,
 * wiec pominiety albo nieudany commit nadrabia sie przy nastepnym.
 */
export class LibraryGitRunner {
  private queue: Promise<void> = Promise.resolve();
  private warning: string | null = null;
  private readonly nonces = new Map<string, number>();

  constructor(private readonly deps: LibraryGitRunnerDeps) {}

  /** Konczy sie, gdy skonczyly sie wszystkie zaplanowane synchronizacje (do uzycia w testach i przy zamknieciu). */
  idle(): Promise<void> {
    return this.queue;
  }

  async getState(): Promise<Result<VersioningStateDto>> {
    try {
      return ok(await this.state(await this.deps.settings.load()));
    } catch (error: unknown) {
      return this.internal(error);
    }
  }

  /**
   * Wlaczenie albo zmiana zgody robi pelna synchronizacje, zanim ustawienia zostana zapisane: gdy git
   * zawiedzie, ustawienia zostaja bez zmian, a uzytkownik dostaje powod. Wylaczenie zapisuje sie od
   * razu i nie dotyka repozytorium.
   */
  async setSettings(payload: unknown): Promise<Result<VersioningStateDto>> {
    const parsed = parseLibraryGitSettings(payload);
    if (!parsed.ok) return err('invalid-request', parsed.message);
    const next = parsed.value;
    const extra =
      typeof payload === 'object' && payload !== null
        ? (payload as { acknowledged?: unknown; nonce?: unknown })
        : {};
    try {
      const current = await this.deps.settings.load();
      // Zgoda na prywatne elementy jest decyzja uzytkownika, wiec main sprawdza ja sam: potwierdzenie i
      // jednorazowy znacznik z odczytu stanu. Renderer nie moze jej "przeskoczyc" pojedynczym wywolaniem.
      const grantsPrivate = next.enabled && next.includePrivate;
      if (grantsPrivate && !(current.enabled && current.includePrivate)) {
        if (extra.acknowledged !== true) return err('consent-required', CONSENT_REQUIRED_MESSAGE);
        if (!this.consumeNonce(extra.nonce)) return err('consent-expired', CONSENT_EXPIRED_MESSAGE);
      }
      if (next.enabled) {
        const availability = await this.deps.git.probe();
        if (!availability.available) return err('git-unavailable', availability.message);
        if (!current.enabled || current.includePrivate !== next.includePrivate) {
          const result = await this.enqueue(() =>
            this.deps.git.sync({
              operation: current.enabled ? 'resync' : 'enable',
              includePrivate: next.includePrivate,
              guard: () => this.deps.lock.tryEnterWrite(),
            }),
          );
          if (!result.ok) {
            this.warning = result.message;
            return err('git-failed', result.message);
          }
          if (result.skipped === true) return err('busy', BUSY_MESSAGE);
          this.warning = null;
        }
      }
      await this.deps.settings.save(next);
      return ok(await this.state(next));
    } catch (error: unknown) {
      return this.internal(error);
    }
  }

  /** Wolane po udanym handlerze kanalu zapisujacego; nie czeka i nie rzuca. */
  afterWrite(channel: IpcChannel): void {
    const operation = VERSIONED_CHANNELS[channel];
    if (operation === undefined) return;
    this.schedule(operation);
  }

  /** Nadrabia zmiany, ktore nie trafily do historii (poprzednia sesja skonczyla sie awaria gita). */
  catchUp(): void {
    this.schedule('resync');
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private schedule(operation: LibraryGitOperation): void {
    void this.enqueue(() => this.runScheduled(operation));
  }

  private async runScheduled(operation: LibraryGitOperation): Promise<void> {
    try {
      const settings = await this.deps.settings.load();
      if (!settings.enabled) return;
      const result = await this.deps.git.sync({
        operation,
        includePrivate: settings.includePrivate,
        guard: () => this.deps.lock.tryEnterWrite(),
      });
      if (!result.ok) {
        this.warning = result.message;
        this.deps.logWarn?.(`[cwm] wersjonowanie biblioteki nie powiodło się: ${result.message}`);
        return;
      }
      // Zajeta blokada (odbudowa indeksu, czyszczenie) to nie awaria: nastepna synchronizacja nadrobi zmiany.
      if (result.skipped === true) return;
      this.warning = null;
      if (result.committed) {
        this.deps.logInfo?.(
          `[cwm] wersjonowanie biblioteki: ${operation}, elementow ${result.items}`,
        );
      }
    } catch (error: unknown) {
      this.warning = INTERNAL_MESSAGE;
      this.deps.logUnexpected?.(error);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private issueNonce(): string {
    const t = this.now();
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt <= t) this.nonces.delete(key);
    }
    while (this.nonces.size >= MAX_NONCES) {
      const oldest = this.nonces.keys().next();
      if (oldest.done === true) break;
      this.nonces.delete(oldest.value);
    }
    const nonce = (this.deps.newNonce ?? ((): string => randomBytes(18).toString('base64url')))();
    this.nonces.set(nonce, t + CONSENT_NONCE_TTL_MS);
    return nonce;
  }

  /** Znacznik sluzy raz: kazde uzycie, udane albo nie, go zuzywa. */
  private consumeNonce(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const expiresAt = this.nonces.get(value);
    this.nonces.delete(value);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  private async state(settings: LibraryGitSettings): Promise<VersioningStateDto> {
    const availability = await this.deps.git.probe();
    // Repozytorium czytamy tez przy wylaczonej funkcji i bez gita w PATH: wtedy tylko liczniki z dysku.
    const status = await this.deps.git.status(settings.includePrivate, settings.enabled);
    return {
      enabled: settings.enabled,
      includePrivate: settings.includePrivate,
      available: availability.available,
      unavailableMessage: availability.available ? null : availability.message,
      repository: status.repository,
      commits: status.commits,
      lastCommitAt: status.last?.at ?? null,
      lastCommitSubject: status.last?.subject ?? null,
      itemsIncluded: status.items.included,
      itemsExcludedPrivate: status.items.excludedPrivate,
      itemsExcludedSecrets: status.items.excludedSecrets,
      itemsExcludedGitEntry: status.items.excludedGitEntry,
      itemsExcludedUnreadable: status.items.excludedUnreadable,
      warning: this.warning,
      consentNonce: this.issueNonce(),
    };
  }

  private internal(error: unknown): Result<never> {
    this.deps.logUnexpected?.(error);
    return err('internal', INTERNAL_MESSAGE);
  }
}
