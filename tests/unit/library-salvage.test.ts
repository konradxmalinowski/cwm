import { describe, expect, it } from 'vitest';

import type { ItemId } from '../../src/core/model/item';
import { LibraryError } from '../../src/core/model/library-errors';
import type { UnreadableEntry } from '../../src/core/ports/library-store';
import { sha256Bytes, sha256Text } from '../../src/core/services/normalization/hash';
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
    draft({
      body: 'tresc elementu\n',
      assets: [
        { relPath: 'refs/a.md', bytes: bytes('asset A') },
        { relPath: 'refs/b.md', bytes: bytes('asset B') },
      ],
    }),
  );
  return { h, id: item.id };
}

/** `read` rzuca, a `readSalvage` zwraca to, co sie da, i liste nieczytelnych. */
function breakItem(h: Harness, id: string, unreadable: UnreadableEntry[]): void {
  h.store.unreadable.set(id, new Error('nieczytelny'));
  h.store.salvageUnreadable.set(id, unreadable);
}

const scenarios: {
  name: string;
  unreadable: UnreadableEntry[];
  recoverable: string[];
  kind: 'skill' | null;
}[] = [
  {
    name: 'nieczytelny asset',
    unreadable: [{ relPath: 'assets/refs/a.md', failure: 'permission-denied' }],
    recoverable: ['tresc elementu\n', 'asset B'],
    kind: 'skill',
  },
  {
    name: 'dowiazanie zamiast assets/',
    unreadable: [{ relPath: 'assets', failure: 'symlink' }],
    recoverable: ['tresc elementu\n'],
    kind: 'skill',
  },
  {
    name: 'nieczytelny item.json',
    unreadable: [{ relPath: 'item.json', failure: 'permission-denied' }],
    recoverable: ['tresc elementu\n', 'asset A', 'asset B'],
    kind: null,
  },
];

describe.each(scenarios)('usuniecie elementu: $name', ({ unreadable, recoverable, kind }) => {
  it('plan jest partial z lista tego, czego nie odzyska, a kind i slug zgodnie z item.json', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);

    const plan = await h.service.planDelete(id);

    expect(plan.recoverability.status).toBe('partial');
    expect(plan.applicable).toBe(true);
    expect(plan.unrecoverable).toEqual(unreadable);
    expect(plan.kind).toBe(kind);
    expect(plan.slug).toBe(kind === null ? null : 'acme-review');
    for (const u of unreadable) expect(plan.recoverability.reason).toContain(u.relPath);
    expect(plan.recoverability.reason).not.toMatch(/\/Users|\\/);
    expect(h.store.removeCalls).toBe(0);
  });

  it('bez potwierdzenia utraty apply odmawia i niczego nie usuwa', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);
    const plan = await h.service.planDelete(id);

    expect(await reasonOf(h.service.applyDelete(plan))).toBe('unrecoverable-unacknowledged');
    expect(await reasonOf(h.service.applyDelete(plan, { acknowledgeUnrecoverable: false }))).toBe(
      'unrecoverable-unacknowledged',
    );
    expect(h.store.removeCalls).toBe(0);
    expect(h.store.items.has(id)).toBe(true);
  });

  it('z potwierdzeniem usuwa, a czytelne bajty sa w objects/ razem z manifestem w logu', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);
    const plan = await h.service.planDelete(id);
    h.objects.objects.clear();

    await h.service.applyDelete(plan, { acknowledgeUnrecoverable: true });

    expect(h.store.items.has(id)).toBe(false);
    for (const text of recoverable) expect(await h.objects.has(sha256Text(text))).toBe(true);
    const record = h.log.records.at(-1)!;
    expect(record).toMatchObject({ operation: 'delete', after: null, itemKind: kind });
    const manifest = JSON.parse(
      new TextDecoder().decode((await h.objects.get(record.before!.versionHash))!),
    ) as { unreadable: UnreadableEntry[]; salvaged: { relPath: string }[] };
    expect(manifest.unreadable).toEqual(unreadable);
    expect(manifest.salvaged.map((e) => e.relPath)).not.toContain(unreadable[0]!.relPath);
  });

  it('plan przeterminowuje zmiana czytelnego pliku na dysku', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);
    const plan = await h.service.planDelete(id);
    const f = h.store.items.get(id)!;
    h.store.items.set(id, { ...f, body: bytes('ktos to zmienil\n') });

    expect(await reasonOf(h.service.applyDelete(plan, { acknowledgeUnrecoverable: true }))).toBe(
      'stale-plan',
    );
    expect(h.store.removeCalls).toBe(0);
  });

  it('plan przeterminowuje zmiana listy nieczytelnych', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);
    const plan = await h.service.planDelete(id);
    h.store.salvageUnreadable.set(id, [...unreadable, { relPath: 'body.md', failure: 'busy' }]);

    expect(await reasonOf(h.service.applyDelete(plan, { acknowledgeUnrecoverable: true }))).toBe(
      'stale-plan',
    );
    expect(h.store.removeCalls).toBe(0);
  });

  it('awaria ObjectStore przy planie daje blocked, a apply odmawia', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);
    h.objects.failPut = Object.assign(new Error('EACCES'), { failureCode: 'permission-denied' });

    const plan = await h.service.planDelete(id);

    expect(plan.recoverability.status).toBe('blocked');
    expect(plan.applicable).toBe(false);
    expect(plan.unrecoverable).toEqual(unreadable);
    expect(await reasonOf(h.service.applyDelete(plan, { acknowledgeUnrecoverable: true }))).toBe(
      'plan-blocked',
    );
    expect(h.store.removeCalls).toBe(0);
  });

  it('awaria ObjectStore miedzy planem a apply nie usuwa niczego', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, unreadable);
    const plan = await h.service.planDelete(id);
    h.objects.failPut = new Error('EACCES');

    expect(await reasonOf(h.service.applyDelete(plan, { acknowledgeUnrecoverable: true }))).toBe(
      'backup-failed',
    );
    expect(h.store.items.has(id)).toBe(true);
  });
});

describe('usuniecie z czesciowa kopia: granice', () => {
  it('manifest zwykly (bez nieczytelnych) nie wymaga potwierdzenia', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    expect(plan.recoverability.status).toBe('recoverable');
    expect(plan.unrecoverable).toEqual([]);
    await expect(h.service.applyDelete(plan)).resolves.toBeDefined();
  });

  it('potwierdzenie przy planie recoverable jest ignorowane, nie zmienia zachowania', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    await h.service.applyDelete(plan, { acknowledgeUnrecoverable: true });
    expect(h.store.items.has(id)).toBe(false);
  });

  it('mutacje czytaja drzewo przez readSalvage: gdy nic nie jest nieczytelne, plan jest zwykly', async () => {
    const { h, id } = await seeded();
    h.store.unreadable.set(id, new Error('chwilowy'));
    const plan = await h.service.planDelete(id);
    expect(plan.recoverability.status).toBe('recoverable');
  });

  it('brak katalogu w salvage to not-found', async () => {
    const { h, id } = await seeded();
    h.store.unreadable.set(id, new Error('x'));
    h.store.items.delete(id);
    // read(id) rzuca z atrapy zanim zajrzy do mapy, salvage zwraca null
    expect(await reasonOf(h.service.planDelete(id))).toBe('not-found');
  });

  it('pliki systemowe nie przeterminowuja planu partial, ale sa archiwizowane', async () => {
    const { h, id } = await seeded();
    breakItem(h, id, [{ relPath: 'assets/refs/a.md', failure: 'permission-denied' }]);
    const plan = await h.service.planDelete(id);
    const f = h.store.items.get(id)!;
    h.store.items.set(id, {
      ...f,
      assets: [...f.assets, { relPath: '.DS_Store', bytes: bytes('finder') }],
    });
    h.objects.objects.clear();

    await h.service.applyDelete(plan, { acknowledgeUnrecoverable: true });
    expect(await h.objects.has(sha256Text('finder'))).toBe(true);
    expect(await h.objects.has(sha256Bytes(bytes('asset B')))).toBe(true);
  });
});
