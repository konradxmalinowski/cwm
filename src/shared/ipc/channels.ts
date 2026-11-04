/**
 * Zamknieta lista kanalow IPC (ADR 0008, ARCHITECTURE 7.2).
 *
 * Ta tablica jest jedynym zrodlem prawdy o powierzchni IPC. Most w preloadzie
 * jest z niej generowany, a rejestr w procesie glownym odmawia rejestracji
 * kanalu, ktorego tu nie ma. Dopisanie kanalu w jednym miejscu bez drugiego
 * jest niemozliwe - testy jednostkowe sprawdzaja oba kierunki.
 */
export const IPC_CHANNELS = [
  'library:list',
  'library:get',
  'library:save',
  'library:delete-plan',
  'library:delete-apply',
  'library:repair',
  'import:detect',
  'import:scan',
  'import:apply',
  'export:plan',
  'export:apply',
  'sync:plan',
  'sync:apply',
  'sync:status',
  'diff:compute',
  'history:list',
  'history:rollback',
  'profiles:list',
  'profiles:save',
  'profiles:export-plan',
  'settings:get',
  'settings:set',
  'diagnostics:report',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** Zdarzenia main do renderera. Tylko postep i log operacji, nigdy tresc pliku. */
export const IPC_EVENTS = ['progress', 'operation-log'] as const;

export type IpcEvent = (typeof IPC_EVENTS)[number];

/**
 * Kanaly z handlerem w tym etapie. Pozostale sa w liscie, ale nie maja
 * implementacji - wywolanie takiego kanalu odrzuca sie bledem Electrona
 * "No handler registered", zamiast udawac dzialajaca funkcje.
 */
export const IMPLEMENTED_CHANNELS = [
  'library:list',
  'library:get',
  'library:save',
  'library:delete-plan',
  'library:delete-apply',
  'library:repair',
  'import:detect',
  'import:scan',
  'import:apply',
  'export:plan',
  'export:apply',
  'sync:status',
  'sync:plan',
  'sync:apply',
  'history:list',
  'history:rollback',
  'diagnostics:report',
] as const;

const CHANNEL_SET: ReadonlySet<string> = new Set(IPC_CHANNELS);
const EVENT_SET: ReadonlySet<string> = new Set(IPC_EVENTS);

export function isIpcChannel(value: string): value is IpcChannel {
  return CHANNEL_SET.has(value);
}

export function isIpcEvent(value: string): value is IpcEvent {
  return EVENT_SET.has(value);
}
