import { describe, expect, it, vi } from 'vitest';

import { IpcRegistry, type IpcHandleTarget } from '../../src/main/ipc/registry';
import { IMPLEMENTED_CHANNELS, type IpcChannel } from '../../src/shared/ipc/channels';

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
