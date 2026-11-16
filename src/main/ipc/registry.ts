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
 */
export const WRITE_CHANNELS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'library:save',
  'library:delete-apply',
  'library:repair',
  'import:apply',
  'export:apply',
  'sync:apply',
  'history:rollback',
]);

export const BUSY_RESULT = {
  ok: false,
  error: {
    code: 'busy',
    message: 'Trwa odbudowa indeksu. Spróbuj ponownie za chwilę.',
  },
} as const;

export interface IpcRegistryOptions {
  readonly lock?: OperationLock;
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
    const { lock } = this.options;
    if (lock === undefined || !WRITE_CHANNELS.has(channel)) {
      this.target.handle(channel, (_event: unknown, payload: unknown) => handler(payload));
      return;
    }
    this.target.handle(channel, async (_event: unknown, payload: unknown) => {
      const release = lock.tryEnterWrite();
      if (release === null) return BUSY_RESULT;
      try {
        return await handler(payload);
      } finally {
        release();
      }
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
