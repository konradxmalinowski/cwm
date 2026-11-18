import { describe, expect, it, vi } from 'vitest';

import { IpcRegistry, type IpcHandleTarget } from '../../src/main/ipc/registry';
import { OperationLock } from '../../src/main/services/write-lock';
import { IMPLEMENTED_CHANNELS, IPC_CHANNELS, type IpcChannel } from '../../src/shared/ipc/channels';

function fakeTarget(): IpcHandleTarget & { channels: string[] } {
  const channels: string[] = [];
  return {
    channels,
    handle(channel) {
      channels.push(channel);
    },
  };
}

describe('rejestr IPC wymusza zamknieta liste', () => {
  it('rejestruje kanal z listy', () => {
    const target = fakeTarget();
    new IpcRegistry(target).register('diagnostics:report', () => null);
    expect(target.channels).toEqual(['diagnostics:report']);
  });

  it('odmawia rejestracji kanalu poza lista', () => {
    const target = fakeTarget();
    const registry = new IpcRegistry(target);
    expect(() => registry.register('fs:read' as IpcChannel, () => null)).toThrow(
      /nie jest na zamknietej liscie/,
    );
    expect(target.channels).toEqual([]);
  });

  it('odmawia podwojnej rejestracji tego samego kanalu', () => {
    const registry = new IpcRegistry(fakeTarget());
    registry.register('diagnostics:report', () => null);
    expect(() => registry.register('diagnostics:report', () => null)).toThrow(/juz zarejestrowany/);
  });

  it('wykrywa kanal zadeklarowany jako gotowy bez handlera', () => {
    const registry = new IpcRegistry(fakeTarget());
    expect(() => registry.assertImplementedRegistered()).toThrow(/bez handlera/);
    for (const channel of IMPLEMENTED_CHANNELS) registry.register(channel, () => null);
    expect(() => registry.assertImplementedRegistered()).not.toThrow();
  });

  it('przekazuje handlerowi sam ladunek, bez obiektu zdarzenia', () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const registry = new IpcRegistry({
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    });
    const handler = vi.fn(() => 'ok');
    registry.register('diagnostics:report', handler);

    handlers.get('diagnostics:report')?.({ senderId: 7 }, { scope: 'full' });
    expect(handler).toHaveBeenCalledWith({ scope: 'full' });
  });
});

describe('kanaly recznej odbudowy indeksu (ADR 0030)', () => {
  const REBUILD = ['diagnostics:rebuild-index-plan', 'diagnostics:rebuild-index-apply'] as const;

  it('sa na zamknietej liscie i oznaczone jako zaimplementowane', () => {
    for (const channel of REBUILD) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IMPLEMENTED_CHANNELS).toContain(channel);
    }
  });

  it('kazdy zaimplementowany kanal jest na liscie, bez duplikatow', () => {
    for (const channel of IMPLEMENTED_CHANNELS) expect(IPC_CHANNELS).toContain(channel);
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
    expect(new Set(IMPLEMENTED_CHANNELS).size).toBe(IMPLEMENTED_CHANNELS.length);
  });

  it('rejestr przyjmuje oba kanaly i odmawia pominiecia ktoregokolwiek', () => {
    const registry = new IpcRegistry(fakeTarget());
    for (const channel of IMPLEMENTED_CHANNELS) {
      if (channel !== REBUILD[1]) registry.register(channel, () => null);
    }
    expect(() => registry.assertImplementedRegistered()).toThrow(/diagnostics:rebuild-index-apply/);
    registry.register(REBUILD[1], () => null);
    expect(() => registry.assertImplementedRegistered()).not.toThrow();
  });
});

describe('afterWrite po kanale zapisujacym (ADR 0060)', () => {
  function build(afterWrite: (channel: IpcChannel, result: unknown) => void) {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const lock = new OperationLock();
    const registry = new IpcRegistry(
      {
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      { lock, afterWrite },
    );
    return { registry, handlers, lock };
  }

  it('wola hak z wynikiem handlera, dopiero po zwolnieniu blokady', async () => {
    let writersDuringHook: boolean | null = null;
    const ctx = build(() => {
      // Odbudowa jest mozliwa tylko wtedy, gdy zaden zapis nie trwa.
      const release = ctx.lock.tryEnterExclusive();
      writersDuringHook = release !== null;
      release?.();
    });
    ctx.registry.register('library:save', () => ({ ok: true }));
    const result = await ctx.handlers.get('library:save')?.({}, {});
    expect(result).toEqual({ ok: true });
    expect(writersDuringHook).toBe(true);
  });

  it('nie wola haka dla kanalu odczytu ani gdy blokada jest zajeta', async () => {
    const hook = vi.fn();
    const ctx = build(hook);
    ctx.registry.register('library:list', () => ({ ok: true }));
    ctx.registry.register('library:save', () => ({ ok: true }));
    await ctx.handlers.get('library:list')?.({}, {});
    const release = ctx.lock.tryEnterExclusive();
    const busy = await ctx.handlers.get('library:save')?.({}, {});
    release?.();
    expect(busy).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(hook).not.toHaveBeenCalled();
  });

  it('wyjatek z haka nie zmienia wyniku operacji', async () => {
    const ctx = build(() => {
      throw new Error('git padl');
    });
    ctx.registry.register('import:apply', () => ({ ok: true, value: 7 }));
    await expect(ctx.handlers.get('import:apply')?.({}, {})).resolves.toEqual({
      ok: true,
      value: 7,
    });
  });

  it('kanaly versioning nie sa kanalami zapisu: biora blokade same i nie wolaja haka', async () => {
    const hook = vi.fn();
    const ctx = build(hook);
    ctx.registry.register('versioning:set', () => ({ ok: true }));
    await ctx.handlers.get('versioning:set')?.({}, {});
    expect(hook).not.toHaveBeenCalled();
    expect(IPC_CHANNELS).toContain('versioning:get');
    expect(IPC_CHANNELS).toContain('versioning:set');
  });
});
