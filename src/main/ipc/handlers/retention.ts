import type { IpcRegistry } from '../registry';
import type { RetentionRunner } from '../../services/retention-runner';
import { parseRetentionApplyRequest } from './retention-validation';

export interface RetentionHandlerDeps {
  readonly runner: () => RetentionRunner | null;
}

const UNAVAILABLE = {
  ok: false,
  error: { code: 'internal', message: 'Czyszczenie historii jest niedostępne.' },
} as const;

/**
 * Kanaly `retention:*` (ADR 0056). Podglad i odczyt ustawien ignoruja ladunek; zapis ustawien
 * jest walidowany po stronie runnera, a wykonanie przyjmuje tylko potwierdzenie.
 */
export function registerRetentionHandlers(registry: IpcRegistry, deps: RetentionHandlerDeps): void {
  registry.register('retention:get', () => deps.runner()?.getSettings() ?? UNAVAILABLE);
  registry.register(
    'retention:set',
    (payload) => deps.runner()?.setSettings(payload) ?? UNAVAILABLE,
  );
  registry.register('retention:preview', () => deps.runner()?.preview() ?? UNAVAILABLE);
  registry.register('retention:apply', (payload) => {
    const parsed = parseRetentionApplyRequest(payload);
    if (!parsed.ok) {
      return { ok: false, error: { code: 'invalid-request', message: parsed.message } };
    }
    return deps.runner()?.apply(parsed.value.confirmed) ?? UNAVAILABLE;
  });
}
