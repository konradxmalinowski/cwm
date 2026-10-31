import type { Result } from '../../../../shared/ipc/library-contract';
import type { BridgeSurface } from '../../../../shared/ipc/surface';

import './uasm-bridge';

export function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function isResult(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['ok'] === true) return 'value' in record;
  if (record['ok'] === false) {
    const error = record['error'];
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as Record<string, unknown>)['message'] === 'string'
    );
  }
  return false;
}

/**
 * Jedyne miejsce, w ktorym renderer rzutuje odpowiedz IPC na typ kontraktu. Odrzucenie
 * obietnicy (np. kanal bez handlera) nie trafia do uzytkownika w surowej postaci:
 * dostaje komunikat po polsku, a szczegol idzie do konsoli.
 */
export async function callBridge<T>(
  invoke: (bridge: BridgeSurface) => Promise<unknown>,
): Promise<Result<T>> {
  const bridge = window.uasm;
  if (bridge === undefined) {
    return failure(
      'bridge-missing',
      'Połączenie z procesem głównym aplikacji nie jest dostępne. Uruchom aplikację ponownie.',
    );
  }
  try {
    const raw = await invoke(bridge);
    if (isResult(raw)) return raw as Result<T>;
    return failure(
      'bad-response',
      'Proces główny odpowiedział w nieoczekiwanym formacie. Uruchom aplikację ponownie.',
    );
  } catch (error: unknown) {
    console.error('Wywolanie IPC odrzucone', error);
    return failure(
      'ipc-failed',
      'Nie udało się połączyć z procesem głównym aplikacji. Spróbuj ponownie, a jeśli to się powtarza, uruchom aplikację od nowa.',
    );
  }
}
