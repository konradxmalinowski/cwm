import { expect, test } from '@playwright/test';

import { IPC_CHANNELS } from '../../src/shared/ipc/channels';
import { removeTempTrees } from '../harness/isolation';
import { launchApp } from './launch';

test.afterAll(() => {
  removeTempTrees();
});

test('renderer nie ma dostepu do Node', async () => {
  const { app, page } = await launchApp();

  try {
    const probe = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>)['require'],
      process: typeof (globalThis as Record<string, unknown>)['process'],
      module: typeof (globalThis as Record<string, unknown>)['module'],
      exports: typeof (globalThis as Record<string, unknown>)['exports'],
      Buffer: typeof (globalThis as Record<string, unknown>)['Buffer'],
      global: typeof (globalThis as Record<string, unknown>)['global'],
    }));

    expect(probe).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      exports: 'undefined',
      Buffer: 'undefined',
      global: 'undefined',
    });
  } finally {
    await app.close();
  }
});

test('zadanie sieciowe z renderera jest zablokowane', async () => {
  const { app, page } = await launchApp();

  try {
    const fetchResult = await page.evaluate(async () => {
      try {
        const response = await fetch('https://example.com/probe');
        return { blocked: false, status: response.status };
      } catch (error: unknown) {
        return { blocked: true, status: error instanceof Error ? error.name : 'unknown' };
      }
    });
    expect(fetchResult.blocked).toBe(true);

    const xhrResult = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = new XMLHttpRequest();
          request.onload = () => resolve('loaded');
          request.onerror = () => resolve('error');
          request.ontimeout = () => resolve('timeout');
          try {
            request.open('GET', 'https://example.com/probe');
            request.send();
          } catch {
            resolve('throw');
          }
          setTimeout(() => resolve('timeout'), 8000);
        }),
    );
    expect(xhrResult).not.toBe('loaded');
  } finally {
    await app.close();
  }
});

test('most IPC wystawia dokladnie zamknieta liste, bez kanalu ogolnego', async () => {
  const { app, page } = await launchApp();

  try {
    const surface = await page.evaluate(() => {
      const bridge = (globalThis as Record<string, unknown>)['cwm'];
      if (typeof bridge !== 'object' || bridge === null) return null;
      const out: Record<string, string[]> = {};
      for (const key of Object.keys(bridge)) {
        const value = (bridge as Record<string, unknown>)[key];
        out[key] = typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
      }
      return out;
    });

    expect(surface).not.toBeNull();

    const expected: Record<string, string[]> = {};
    for (const channel of IPC_CHANNELS) {
      const separator = channel.indexOf(':');
      const namespace = channel.slice(0, separator);
      const member = channel
        .slice(separator + 1)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      expected[namespace] = [...(expected[namespace] ?? []), member].sort();
    }

    expect(surface).toEqual(expected);
  } finally {
    await app.close();
  }
});

test('most nie ma metody spoza listy: brak diff, profili, ustawien i zdarzen', async () => {
  const { app, page } = await launchApp();

  try {
    const result = await page.evaluate(() => {
      const bridge = (globalThis as Record<string, unknown>)['cwm'] as Record<string, unknown>;
      return {
        namespaces: Object.keys(bridge).sort(),
        absent: ['diff', 'profiles', 'settings', 'events'].map((key) => typeof bridge[key]),
        frozen: Object.isFrozen(bridge),
      };
    });

    expect(result.absent).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
    expect(result.frozen).toBe(true);
    const expectedNamespaces = [
      ...new Set(IPC_CHANNELS.map((channel) => channel.slice(0, channel.indexOf(':')))),
    ].sort();
    expect(result.namespaces).toEqual(expectedNamespaces);
  } finally {
    await app.close();
  }
});
