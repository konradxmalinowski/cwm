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
  'import:scan-git',
  'import:scan-project',
  'import:apply',
  'export:plan',
  'export:apply',
  'export:zip-plan',
  'export:zip-save',
  'sync:plan',
  'sync:apply',
  'sync:status',
  'history:list',
  'history:rollback',
  'diagnostics:report',
  'diagnostics:rebuild-index-plan',
  'diagnostics:rebuild-index-apply',
  'diagnostics:report-preview',
  'diagnostics:report-save',
  'retention:get',
  'retention:set',
  'retention:preview',
  'retention:apply',
  'versioning:get',
  'versioning:set',
  'projects:list',
  'projects:add',
  'projects:rename',
  'projects:remove',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/**
 * Kazdy kanal z `IPC_CHANNELS` ma handler; rejestr przy starcie sprawdza to
 * (`assertImplementedRegistered`). Kanaly bez implementacji (diff, profile,
 * ustawienia) i zdarzenia main do renderera (postep, log operacji) zostaly
 * usuniete z listy, zamiast udawac funkcje (Etap 10, kryterium 5). Wracaja
 * razem z implementacja i testem, w tym samym commicie.
 */
export const IMPLEMENTED_CHANNELS: readonly IpcChannel[] = IPC_CHANNELS;

const CHANNEL_SET: ReadonlySet<string> = new Set(IPC_CHANNELS);

export function isIpcChannel(value: string): value is IpcChannel {
  return CHANNEL_SET.has(value);
}
