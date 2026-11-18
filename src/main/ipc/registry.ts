import { IMPLEMENTED_CHANNELS, type IpcChannel, isIpcChannel } from '../../shared/ipc/channels';
import type { OperationLock } from '../services/write-lock';

/**
 * Minimalny kontrakt na `ipcMain.handle`. Rejestr nie importuje Electrona,
 * zeby dal sie przetestowac jednostkowo bez uruchamiania aplikacji.
 */
export interface IpcHandleTarget {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
}

export type IpcHandler = (payload: unknown) => unknown;

/**
 * Kanaly, ktore zapisuja (biblioteka, import, eksport, synchronizacja, cofniecie). Wchodza pod
 * wspolna blokade z reczna odbudowa indeksu (ADR 0030): w trakcie odbudowy odpowiadaja `busy`.
 *
 * Kazdy nowy kanal, ktory zapisuje obiekty do content store albo wiersze do logu operacji, musi
 * byc na tej liscie. Przebieg retencji (ADR 0056) jest bezpieczny tylko dlatego, ze zadnego takiego
 * zapisu nie ma w jego trakcie; kanal poza lista moglby wlozyc obiekt, zanim dopisze wiersz logu,
 * i obiekt wygladalby na osierocony.
 */
export const WRITE_CHANNELS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'library:save',
  'library:delete-apply',
  'library:repair',
  'import:apply',
  'export:apply',
  'sync:apply',
  'history:rollback',
  // Usuniecie projektu odpina jego elementy w bibliotece (ADR 0059).
  'projects:remove',
]);

export const BUSY_RESULT = {
  ok: false,
  error: {
    code: 'busy',
    message: 'Trwa odbudowa indeksu albo czyszczenie historii. Spróbuj ponownie za chwilę.',
  },
} as const;

export interface IpcRegistryOptions {
  readonly lock?: OperationLock;
  /**
   * Wolane po zakonczonym handlerze kanalu z `WRITE_CHANNELS`, po zwolnieniu blokady (ADR 0060).
   * Nie jest awaitowane i nie moze zmienic wyniku operacji: wyjatek jest polykany.
   */
  readonly afterWrite?: (channel: IpcChannel, result: unknown) => void;
}

export class IpcRegistry {
  private readonly registered = new Set<IpcChannel>();

  constructor(
    private readonly target: IpcHandleTarget,
    private readonly options: IpcRegistryOptions = {},
  ) {}

  register(channel: IpcChannel, handler: IpcHandler): void {
    if (!isIpcChannel(channel)) {
      throw new Error(
        `odmowa rejestracji: kanal "${String(channel)}" nie jest na zamknietej liscie IPC`,
      );
    }
    if (this.registered.has(channel)) {
      throw new Error(`odmowa rejestracji: kanal "${channel}" jest juz zarejestrowany`);
    }
    this.registered.add(channel);
    const { lock, afterWrite } = this.options;
    if (lock === undefined || !WRITE_CHANNELS.has(channel)) {
      this.target.handle(channel, (_event: unknown, payload: unknown) => handler(payload));
      return;
    }
    this.target.handle(channel, async (_event: unknown, payload: unknown) => {
      const release = lock.tryEnterWrite();
      if (release === null) return BUSY_RESULT;
      let result: unknown;
      try {
        result = await handler(payload);
      } finally {
        release();
      }
      try {
        afterWrite?.(channel, result);
      } catch {
        // Warstwa opcjonalna (Git) nie psuje operacji, ktora sie udala.
      }
      return result;
    });
  }

  list(): IpcChannel[] {
    return [...this.registered].sort();
  }

  /**
   * Lista kanalow zadeklarowanych jako zaimplementowane w tym etapie musi sie
   * pokrywac z tym, co faktycznie zarejestrowano. Inaczej deklaracja w
   * `channels.ts` rozjechalaby sie z rzeczywistoscia po cichu.
   */
  assertImplementedRegistered(): void {
    const missing = IMPLEMENTED_CHANNELS.filter((channel) => !this.registered.has(channel));
    if (missing.length > 0) {
      throw new Error(`kanaly zadeklarowane jako gotowe bez handlera: ${missing.join(', ')}`);
    }
  }
}
