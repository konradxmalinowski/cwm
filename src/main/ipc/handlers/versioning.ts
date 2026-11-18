import type { LibraryGitRunner } from '../../services/library-git-runner';
import type { IpcRegistry } from '../registry';

export interface VersioningHandlerDeps {
  readonly runner: () => LibraryGitRunner | null;
}

const UNAVAILABLE = {
  ok: false,
  error: { code: 'internal', message: 'Wersjonowanie biblioteki jest niedostępne.' },
} as const;

/**
 * Kanaly `versioning:*` (ADR 0060). Zapis przyjmuje dwa pola logiczne; walidacje robi runner tym
 * samym kodem co odczyt pliku ustawien, a repozytorium i tematy commitow zna wylacznie main.
 */
export function registerVersioningHandlers(
  registry: IpcRegistry,
  deps: VersioningHandlerDeps,
): void {
  registry.register('versioning:get', () => deps.runner()?.getState() ?? UNAVAILABLE);
  registry.register(
    'versioning:set',
    (payload) => deps.runner()?.setSettings(payload) ?? UNAVAILABLE,
  );
}
