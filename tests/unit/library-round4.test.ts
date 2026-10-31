import { describe, expect, it } from 'vitest';

import type { ItemId } from '../../src/core/model/item';
import { LibraryError } from '../../src/core/model/library-errors';
import { bytes, createHarness, draft } from './library-fakes';

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof LibraryError) return error.reason;
    throw error;
  }
  return 'ok';
}

type Harness = ReturnType<typeof createHarness>;

async function seeded(): Promise<{ h: Harness; id: ItemId }> {
  const h = createHarness();
  const { item } = await h.service.create(
    draft({ assets: [{ relPath: 'refs/a.md', bytes: bytes('asset A') }] }),
  );
  return { h, id: item.id };
}

describe('applyDelete nie ufa planowi od wywolujacego', () => {
  const unreadable = [{ relPath: 'assets/refs/a.md', failure: 'permission-denied' as const }];

  async function partial() {
    const { h, id } = await seeded();
    h.store.unreadable.set(id, new Error('nieczytelny'));
    h.store.salvageUnreadable.set(id, unreadable);
    return { h, id, plan: await h.service.planDelete(id) };
  }

  it('plan partial przerobiony na recoverable jest odrzucony bez potwierdzenia', async () => {
    const { h, id, plan } = await partial();
    expect(plan.recoverability.status).toBe('partial');
    const forged = {
      ...plan,
      recoverability: { ...plan.recoverability, status: 'recoverable' as const, reason: null },
      unrecoverable: [],
    };

    expect(await reasonOf(h.service.applyDelete(forged))).toBe('unrecoverable-unacknowledged');
    expect(h.store.removeCalls).toBe(0);
    expect(h.store.items.has(id)).toBe(true);
  });

  it('komunikat odmowy bierze liste z dysku, nie z planu', async () => {
    const { h, plan } = await partial();
    const forged = {
      ...plan,
      unrecoverable: [{ relPath: 'wymyslone.md', failure: 'busy' as const }],
    };
    const attempt = h.service.applyDelete(forged);
    await expect(attempt).rejects.toMatchObject({
      reason: 'unrecoverable-unacknowledged',
      message: expect.stringContaining('assets/refs/a.md') as string,
    });
    await expect(attempt).rejects.toMatchObject({
      message: expect.not.stringContaining('wymyslone') as string,
    });
  });

  it('ten sam przerobiony plan z potwierdzeniem usuwa (potwierdzenie liczy sie niezaleznie od planu)', async () => {
    const { h, id, plan } = await partial();
    const forged = {
      ...plan,
      recoverability: { ...plan.recoverability, status: 'recoverable' as const },
    };
    await h.service.applyDelete(forged, { acknowledgeUnrecoverable: true });
    expect(h.store.items.has(id)).toBe(false);
  });

  it('plan zwyklego elementu, gdy na dysku pojawil sie nieczytelny wpis, jest przeterminowany', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    h.store.salvageUnreadable.set(id, unreadable);
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
    expect(h.store.removeCalls).toBe(0);
  });

  it('itemId niebedacy ULID daje not-found i nie dociera do magazynu', async () => {
    const { h, plan } = await partial();
    for (const itemId of ['../..', '', 'acme-review', 'a/b']) {
      const forged = { ...plan, itemId: itemId as ItemId };
      expect(
        await reasonOf(h.service.applyDelete(forged, { acknowledgeUnrecoverable: true })),
      ).toBe('not-found');
    }
    expect(h.store.removeCalls).toBe(0);
  });

  it('plan zablokowany przerobiony na applicable nadal nie usuwa bez kopii', async () => {
    const { h, id } = await seeded();
    h.objects.failPut = new Error('EACCES');
    const blocked = await h.service.planDelete(id);
    expect(blocked.applicable).toBe(false);

    const forged = { ...blocked, applicable: true };
    expect(await reasonOf(h.service.applyDelete(forged))).toBe('backup-failed');
    expect(h.store.removeCalls).toBe(0);
    expect(h.store.items.has(id)).toBe(true);
  });

  it('plan zablokowany bo element byl nieczytelny, po przerobieniu na applicable jest przeterminowany', async () => {
    const { h, id } = await seeded();
    h.store.salvageFailure = new Error('x');
    const blocked = await h.service.planDelete(id);
    h.store.salvageFailure = null;

    expect(await reasonOf(h.service.applyDelete({ ...blocked, applicable: true }))).toBe(
      'stale-plan',
    );
    expect(h.store.removeCalls).toBe(0);
  });

  it('komunikat blokady nie powtarza tekstu z planu', async () => {
    const { h, id } = await seeded();
    h.objects.failPut = new Error('EACCES');
    const blocked = await h.service.planDelete(id);
    const forged = {
      ...blocked,
      recoverability: { ...blocked.recoverability, reason: '<script>/Users/x</script>' },
      applicable: false,
    };
    await expect(h.service.applyDelete(forged)).rejects.toMatchObject({
      reason: 'plan-blocked',
      message: expect.not.stringContaining('/Users') as string,
    });
  });
});
