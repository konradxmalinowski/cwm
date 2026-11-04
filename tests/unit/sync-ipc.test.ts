import { describe, expect, it } from 'vitest';

import { registerSyncHandlers } from '../../src/main/ipc/handlers/sync';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { Result } from '../../src/shared/ipc/library-contract';
import { IMPLEMENTED_CHANNELS, IPC_CHANNELS } from '../../src/shared/ipc/channels';

function wire() {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const registry = new IpcRegistry({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });
  registerSyncHandlers(registry, { sync: () => null, history: () => null });
  return async (channel: string, payload?: unknown): Promise<Result<unknown>> =>
    (await handlers.get(channel)?.({}, payload)) as Result<unknown>;
}

describe('kanaly sync:* i history:*', () => {
  it('lista kanalow: sync:status zastapil sync:verify i jest zaimplementowany', () => {
    expect(IPC_CHANNELS).toContain('sync:status');
    expect(IPC_CHANNELS).not.toContain('sync:verify' as never);
    for (const c of [
      'sync:status',
      'sync:plan',
      'sync:apply',
      'history:list',
      'history:rollback',
    ]) {
      expect(IMPLEMENTED_CHANNELS).toContain(c as never);
    }
  });

  it('odrzuca zle ladunki zanim dotknie serwisu', async () => {
    const call = wire();
    for (const [channel, payload] of [
      ['sync:status', { tools: ['nieznane'] }],
      ['sync:plan', { tools: ['codex'], itemIds: [] }],
      [
        'sync:plan',
        {
          tools: ['codex'],
          itemIds: ['a'],
          resolutions: [{ itemId: 'a', tool: 'codex', resolution: 'x' }],
        },
      ],
      ['sync:apply', { syncId: 'a', approved: false }],
      ['sync:apply', { syncId: 'a' }],
      ['history:list', { limit: 0 }],
      ['history:rollback', {}],
      ['history:rollback', { operationId: '/etc/passwd'.repeat(30) }],
    ] as const) {
      const result = await call(channel, payload);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('invalid-request');
    }
  });

  it('poprawny ladunek bez serwisu daje blad niedostepnosci, nie wyjatek', async () => {
    const call = wire();
    const result = await call('sync:apply', { syncId: 'abc', approved: true });
    expect(result.ok === false && result.error.code).toBe('sync-unavailable');
    expect((await call('history:list')).ok).toBe(false);
  });
});
