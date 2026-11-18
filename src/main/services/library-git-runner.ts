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
}

const BUSY_MESSAGE =
  'Trwa odbudowa indeksu albo czyszczenie historii. Poczekaj na jej koniec i spróbuj ponownie.';
const INTERNAL_MESSAGE =
  'Wystąpił nieoczekiwany błąd wersjonowania. Szczegóły są w logu aplikacji.';
const SKIPPED_WARNING =
  'Część zmian nie trafiła jeszcze do Git, bo trwała odbudowa indeksu albo czyszczenie historii. Trafi do historii przy następnej operacji.';

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
    const release = this.deps.lock.tryEnterWrite();
    if (release === null) return err('busy', BUSY_MESSAGE);
    try {
      await this.queue;
      const current = await this.deps.settings.load();
      if (next.enabled) {
        const availability = await this.deps.git.probe();
        if (!availability.available) return err('git-unavailable', availability.message);
        const wasEnabled = current.enabled;
        const operation = wasEnabled ? 'resync' : 'enable';
        if (!wasEnabled || current.includePrivate !== next.includePrivate) {
          const result = await this.deps.git.sync({
            operation,
            includePrivate: next.includePrivate,
          });
          if (!result.ok) {
            this.warning = result.message;
            return err('git-failed', result.message);
          }
          this.warning = null;
        }
      }
      await this.deps.settings.save(next);
      return ok(await this.state(next));
    } catch (error: unknown) {
      return this.internal(error);
    } finally {
      release();
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

  private schedule(operation: LibraryGitOperation): void {
    this.queue = this.queue.then(
      () => this.runScheduled(operation),
      () => this.runScheduled(operation),
    );
  }

  private async runScheduled(operation: LibraryGitOperation): Promise<void> {
    try {
      const settings = await this.deps.settings.load();
      if (!settings.enabled) return;
      const release = this.deps.lock.tryEnterWrite();
      if (release === null) {
        this.warning = SKIPPED_WARNING;
        return;
      }
      try {
        const result = await this.deps.git.sync({
          operation,
          includePrivate: settings.includePrivate,
        });
        if (result.ok) {
          this.warning = null;
          if (result.committed) {
            this.deps.logInfo?.(
              `[cwm] wersjonowanie biblioteki: ${operation}, elementow ${result.items}`,
            );
          }
        } else {
          this.warning = result.message;
          this.deps.logWarn?.(`[cwm] wersjonowanie biblioteki nie powiodło się: ${result.message}`);
        }
      } finally {
        release();
      }
    } catch (error: unknown) {
      this.warning = INTERNAL_MESSAGE;
      this.deps.logUnexpected?.(error);
    }
  }

  private async state(settings: LibraryGitSettings): Promise<VersioningStateDto> {
    const availability = await this.deps.git.probe();
    // Repozytorium czytamy tez przy wylaczonej funkcji i bez gita w PATH: wtedy tylko liczniki z dysku.
    const status = await this.deps.git.status(settings.includePrivate);
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
      itemsExcludedUnreadable: status.items.excludedUnreadable,
      warning: this.warning,
    };
  }

  private internal(error: unknown): Result<never> {
    this.deps.logUnexpected?.(error);
    return err('internal', INTERNAL_MESSAGE);
  }
}
