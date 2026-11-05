import { describe, expect, it, vi } from 'vitest';

import type { IndexFailureReason } from '../../src/core/model/index-health';
import type { IndexStore } from '../../src/core/ports/index-store';
import { startIndex, type IndexStartupDeps } from '../../src/main/bootstrap/index-startup';

function fakeStore(): IndexStore {
  return {
    probe: () => ({ status: 'unavailable', reason: 'atrapa' }),
    close: () => undefined,
  };
}

function failing(reason: IndexFailureReason): Error & { reason: IndexFailureReason } {
  const error = new Error(`awaria: ${reason}`) as Error & { reason: IndexFailureReason };
  error.reason = reason;
  return error;
}

function deps(overrides: Partial<IndexStartupDeps> = {}): IndexStartupDeps {
  return {
    openStore: () => fakeStore(),
    quarantine: () => '~/dane/quarantine',
    describeFailure: (error: unknown) =>
      error instanceof Error && 'reason' in error
        ? { reason: (error as { reason: IndexFailureReason }).reason, message: error.message }
        : null,
    ...overrides,
  };
}

describe('triaz awarii indeksu (ADR 0029)', () => {
  it('otwarty indeks jest po prostu gotowy', () => {
    const result = startIndex(deps());
    expect(result.info.outcome).toBe('ready');
    expect(result.store).not.toBeNull();
  });

  for (const reason of ['corrupted', 'unknown-schema'] as const) {
    it(`${reason} prowadzi do odbudowy po kwarantannie`, () => {
      let attempt = 0;
      const quarantine = vi.fn(() => '~/dane/quarantine');
      const result = startIndex(
        deps({
          openStore: () => {
            attempt += 1;
            if (attempt === 1) throw failing(reason);
            return fakeStore();
          },
          quarantine,
        }),
      );

      expect(result.info.outcome).toBe('rebuilt');
      expect(result.store).not.toBeNull();
      expect(quarantine).toHaveBeenCalledOnce();
      expect(result.info.quarantinedAs).toBe('~/dane/quarantine');
      // Zero wczytanych elementow nie moze wygladac na sukces.
      expect(result.info.restoredItems).toBe(0);
      expect(result.info.notRestored?.join(' ')).toMatch(/log operacji/);
      expect(result.info.notRestored?.join(' ')).toMatch(/stan synchronizacji/);
      expect(result.info.notRestored?.join(' ')).not.toMatch(/Etapie 2/);
    });
  }

  for (const reason of ['schema-from-future', 'not-writable', 'native-module'] as const) {
    it(`${reason} prowadzi do odmowy i nie dotyka pliku uzytkownika`, () => {
      const quarantine = vi.fn(() => '~/dane/quarantine');
      const result = startIndex(
        deps({
          openStore: () => {
            throw failing(reason);
          },
          quarantine,
        }),
      );

      expect(result.info.outcome).toBe('refused');
      expect(result.info.reason).toBe(reason);
      expect(result.store).toBeNull();
      expect(quarantine).not.toHaveBeenCalled();
    });
  }

  it('nieudana kwarantanna wstrzymuje odbudowe, bez wariantu "usun i sprobuj"', () => {
    const openStore = vi.fn(() => {
      throw failing('corrupted');
    });
    const result = startIndex(
      deps({
        openStore,
        quarantine: () => {
          throw new Error('brak miejsca na dysku');
        },
      }),
    );

    expect(result.info.outcome).toBe('refused');
    expect(result.info.message).toMatch(/odbudowa nie zostala uruchomiona/);
    expect(result.info.message).toMatch(/brak miejsca na dysku/);
    // Ani jednej dodatkowej proby otwarcia: odbudowa nie wystartowala.
    expect(openStore).toHaveBeenCalledOnce();
  });

  it('nieudana odbudowa po udanej kwarantannie konczy sie odmowa ze sciezka kwarantanny', () => {
    const result = startIndex(
      deps({
        openStore: () => {
          throw failing('corrupted');
        },
      }),
    );

    expect(result.info.outcome).toBe('refused');
    expect(result.info.quarantinedAs).toBe('~/dane/quarantine');
    expect(result.info.message).toMatch(/odbudowa indeksu nie przeszla/);
  });

  it('nierozpoznany blad nie jest zgadywany na przyczyne', () => {
    const result = startIndex(
      deps({
        openStore: () => {
          throw new Error('cos zupelnie innego');
        },
      }),
    );

    expect(result.info.outcome).toBe('refused');
    expect(result.info.reason).toBeUndefined();
    expect(result.info.message).toBe('cos zupelnie innego');
  });
});
