import { describe, expect, it, vi } from 'vitest';

import type { IndexStartupInfo } from '../../src/core/model/index-health';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type { IndexStore } from '../../src/core/ports/index-store';
import { LibraryService } from '../../src/core/services/library/library-service';
import type { IndexOpenFailure } from '../../src/main/bootstrap/index-startup';
import { parseRebuildApplyRequest } from '../../src/main/ipc/handlers/diagnostics-validation';
import { BUSY_RESULT, IpcRegistry } from '../../src/main/ipc/registry';
import {
  IndexRebuildService,
  REBUILD_PLAN_TTL_MS,
  type IndexSnapshot,
  type QuarantineProbeResult,
} from '../../src/main/services/index-rebuild';
import { OperationLock } from '../../src/main/services/write-lock';
import {
  FakeClock,
  MemoryLibraryStore,
  MemoryObjectStore,
  MemoryOperationLog,
  deterministicRandom,
  draft,
} from './library-fakes';
import { FakeIndex } from './library-index-fakes';

class FakeStore implements IndexStore {
  closed = false;
  probe() {
    return { status: 'unavailable' as const, reason: 'atrapa' };
  }
  close(): void {
    this.closed = true;
  }
}

interface Options {
  info?: IndexStartupInfo;
  store?: FakeStore | null;
  probe?: QuarantineProbeResult;
  quarantine?: (stamp: string) => void;
  openStore?: () => IndexStore;
  items?: number;
}

const READY: IndexStartupInfo = { outcome: 'ready' };
const PRESENT: QuarantineProbeResult = {
  indexFilePresent: true,
  status: 'recoverable',
  reason: null,
};

async function harness(options: Options = {}) {
  let snapshot: IndexSnapshot = {
    store: options.store === undefined ? new FakeStore() : options.store,
    info: options.info ?? READY,
  };
  const timeline: string[] = [];
  const clock = new FakeClock();
  const index = new FakeIndex();
  const log = new MemoryOperationLog();
  const library = new LibraryService({
    store: new MemoryLibraryStore(),
    objects: new MemoryObjectStore(),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
    index: () => (snapshot.store === null ? null : index),
  });
  for (let i = 0; i < (options.items ?? 2); i += 1) {
    await library.create(draft({ slug: `acme-item-${i}` }));
  }

  let now = 1_000_000;
  const lock = new OperationLock();
  const quarantine = vi.fn((stamp: string) => {
    timeline.push(`quarantine:${stamp}`);
    options.quarantine?.(stamp);
  });
  const openStore = vi.fn(() => {
    timeline.push('open');
    return options.openStore !== undefined ? options.openStore() : new FakeStore();
  });
  const failures: unknown[] = [];
  let counter = 0;
  const service = new IndexRebuildService({
    runtime: {
      current: () => snapshot,
      replace: (next) => {
        snapshot = next;
      },
    },
    library: () => library,
    lock,
    clock,
    probe: () => options.probe ?? PRESENT,
    quarantine,
    openStore,
    describeFailure: (error): IndexOpenFailure | null =>
      error instanceof Error && 'reason' in error
        ? {
            reason: (error as { reason: IndexOpenFailure['reason'] }).reason,
            message: error.message,
          }
        : null,
    operationLogOf: () => log,
    logUnexpected: (error) => failures.push(error),
    now: () => now,
    newPlanId: () => `plan-${(counter += 1)}`,
  });
  return {
    service,
    library,
    lock,
    index,
    log,
    quarantine,
    openStore,
    failures,
    timeline,
    snapshot: () => snapshot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function planOf(h: Awaited<ReturnType<typeof harness>>) {
  const result = await h.service.plan();
  if (!result.ok) throw new Error(`plan nie przeszedl: ${result.error.message}`);
  return result.value;
}

describe('plan odbudowy (ADR 0030)', () => {
  it('pokazuje, czego odbudowa nie odzyska, oraz co wroci z plikow', async () => {
    const h = await harness();
    const plan = await planOf(h);

    expect(plan.itemsToRestore).toBe(2);
    expect(plan.notRecoverable.join(' ')).toMatch(/log operacji/);
    expect(plan.notRecoverable.join(' ')).toMatch(/stan synchronizacji/);
    expect(plan.quarantineName).toMatch(/^index-.+\.sqlite$/);
    expect(plan.recoverability).toBe('recoverable');
    expect(plan.blockedReason).toBeNull();
    expect(plan.currentOutcome).toBe('ready');
    expect(h.quarantine).not.toHaveBeenCalled();
  });

  it('kwarantanna niemozliwa: plan jest zablokowany z powodem', async () => {
    const h = await harness({
      probe: { indexFilePresent: true, status: 'blocked', reason: 'brak uprawnien' },
    });
    const plan = await planOf(h);
    expect(plan.recoverability).toBe('blocked');
    expect(plan.blockedReason).toBe('brak uprawnien');
  });

  for (const reason of ['native-module', 'not-writable'] as const) {
    it(`odmowa przez ${reason}: odbudowa nic nie naprawi, plan jest zablokowany`, async () => {
      const h = await harness({
        store: null,
        info: { outcome: 'refused', reason, message: 'nie dziala' },
      });
      const plan = await planOf(h);
      expect(plan.recoverability).toBe('blocked');
      expect(plan.blockedReason).not.toBeNull();
    });
  }

  it('bez pliku indeksu nie ma czego odkladac: nazwa kwarantanny jest pusta', async () => {
    const h = await harness({
      probe: { indexFilePresent: false, status: 'recoverable', reason: null },
    });
    expect((await planOf(h)).quarantineName).toBe('');
  });

  it('nie ujawnia sciezek w powodzie biezacego stanu', async () => {
    const h = await harness({
      store: null,
      info: {
        outcome: 'refused',
        reason: 'schema-from-future',
        message: 'indeks /Users/ktos/dane/index.db jest z przyszlosci',
      },
    });
    const plan = await planOf(h);
    expect(plan.currentReason).not.toContain('/Users');
  });

  it('nie startuje, gdy trwa odbudowa', async () => {
    const h = await harness();
    const release = h.lock.tryEnterRebuild();
    const result = await h.service.plan();
    release?.();
    expect(result).toMatchObject({ ok: false, error: { code: 'busy' } });
  });
});

describe('zastosowanie odbudowy', () => {
  it('odmawia bez potwierdzenia', async () => {
    const h = await harness();
    const plan = await planOf(h);

    const result = await h.service.apply(plan.planId, false);

    expect(result).toMatchObject({ ok: false, error: { code: 'confirmation-required' } });
    expect(h.quarantine).not.toHaveBeenCalled();
    // Plan nie jest zuzyty: potwierdzenie mozna doslac.
    expect((await h.service.apply(plan.planId, true)).ok).toBe(true);
  });

  it('odmawia przy planie zablokowanym i niczego nie rusza', async () => {
    const h = await harness({
      probe: { indexFilePresent: true, status: 'blocked', reason: 'brak uprawnien' },
    });
    const store = h.snapshot().store as FakeStore;
    const plan = await planOf(h);

    const result = await h.service.apply(plan.planId, true);

    expect(result).toMatchObject({ ok: false, error: { code: 'plan-blocked' } });
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.openStore).not.toHaveBeenCalled();
    expect(store.closed).toBe(false);
    expect(h.snapshot().store).toBe(store);
  });

  it('odmawia przy planie przeterminowanym (uplyw czasu)', async () => {
    const h = await harness();
    const plan = await planOf(h);
    h.advance(REBUILD_PLAN_TTL_MS + 1);

    const result = await h.service.apply(plan.planId, true);

    expect(result).toMatchObject({ ok: false, error: { code: 'plan-expired' } });
    expect(h.quarantine).not.toHaveBeenCalled();
  });

  it('odmawia przy planie przeterminowanym (stan dysku sie zmienil)', async () => {
    const h = await harness();
    const plan = await planOf(h);
    await h.library.create(draft({ slug: 'acme-nowy' }));

    const result = await h.service.apply(plan.planId, true);

    expect(result).toMatchObject({ ok: false, error: { code: 'stale-plan' } });
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.openStore).not.toHaveBeenCalled();
  });

  it('odmawia nieznanego planu i zuzywa plan po uzyciu', async () => {
    const h = await harness();
    expect(await h.service.apply('nie-ma-takiego', true)).toMatchObject({
      ok: false,
      error: { code: 'plan-expired' },
    });
    const plan = await planOf(h);
    expect((await h.service.apply(plan.planId, true)).ok).toBe(true);
    expect(await h.service.apply(plan.planId, true)).toMatchObject({
      ok: false,
      error: { code: 'plan-expired' },
    });
  });

  it('kolejnosc: zamkniecie starego, kwarantanna, nowy indeks, wypelnienie z plikow, wpis w logu', async () => {
    const h = await harness({ items: 3 });
    const old = h.snapshot().store as FakeStore;
    const plan = await planOf(h);

    const result = await h.service.apply(plan.planId, true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.timeline).toEqual([expect.stringMatching(/^quarantine:/), 'open']);
    expect(old.closed).toBe(true);
    expect(h.snapshot().store).not.toBe(old);
    expect(h.index.entries.size).toBe(3);
    expect(result.value).toMatchObject({
      quarantineName: plan.quarantineName,
      restoredItems: 3,
      failedItems: [],
    });
    expect(result.value.notRecoverable.join(' ')).toMatch(/log operacji/);

    const info = h.snapshot().info;
    expect(info.outcome).toBe('rebuilt');
    expect(info.restoredItems).toBe(3);
    expect(info.quarantinedAs).toBe(plan.quarantineName);
    expect(info.notRestored?.join(' ')).toMatch(/stan synchronizacji/);

    expect(h.log.records).toHaveLength(1);
    expect(h.log.records[0]).toMatchObject({ operation: 'rebuild-index', itemKind: null });
    expect(h.log.records[0]?.note).toMatch(/3 elementow/);
    expect(h.log.records[0]?.note).toContain(plan.quarantineName);
  });

  it('blad wypelnienia nie wyglada na sukces: kod bledu i brak wczytanych elementow w stanie', async () => {
    const h = await harness();
    h.index.replaceAll = () => {
      throw new Error('dysk pelny');
    };
    const plan = await planOf(h);

    const result = await h.service.apply(plan.planId, true);

    expect(result).toMatchObject({ ok: false, error: { code: 'rebuild-failed' } });
    expect(h.snapshot().info.restoredItems).toBe(0);
    expect(h.snapshot().info.notRestored?.join(' ')).toMatch(/nie udalo sie wypelnic/);
  });

  it('nieudana kwarantanna: indeks wraca na miejsce, nowy nie powstaje', async () => {
    const h = await harness({
      quarantine: () => {
        throw new Error('brak miejsca');
      },
    });
    const old = h.snapshot().store as FakeStore;
    const plan = await planOf(h);

    const result = await h.service.apply(plan.planId, true);

    expect(result).toMatchObject({ ok: false, error: { code: 'quarantine-failed' } });
    expect(old.closed).toBe(true);
    // Jedyne otwarcie to powrot do starego pliku; nie ma wariantu "usun i sprobuj".
    expect(h.openStore).toHaveBeenCalledOnce();
    expect(h.snapshot().store).not.toBeNull();
    expect(h.snapshot().info).toEqual(READY);
    expect(h.log.records).toEqual([]);
  });

  it('nowy indeks sie nie otwiera po kwarantannie: stan to odmowa z nazwa pliku w kwarantannie', async () => {
    const h = await harness({
      openStore: () => {
        throw Object.assign(new Error('katalog niezapisywalny'), { reason: 'not-writable' });
      },
    });
    const plan = await planOf(h);

    const result = await h.service.apply(plan.planId, true);

    expect(result).toMatchObject({ ok: false, error: { code: 'rebuild-failed' } });
    expect(h.snapshot().store).toBeNull();
    expect(h.snapshot().info).toMatchObject({
      outcome: 'refused',
      reason: 'not-writable',
      quarantinedAs: plan.quarantineName,
    });
  });

  it('schemat z przyszlosci: jedyne wyjscie, tylko z potwierdzeniem utraty logu', async () => {
    const h = await harness({
      store: null,
      info: {
        outcome: 'refused',
        reason: 'schema-from-future',
        message: 'indeks jest w wersji schematu 99',
      },
    });
    const plan = await planOf(h);
    expect(plan.currentOutcome).toBe('refused');
    expect(plan.recoverability).toBe('recoverable');
    expect(plan.notRecoverable.join(' ')).toMatch(/log operacji/);

    expect(await h.service.apply(plan.planId, false)).toMatchObject({
      ok: false,
      error: { code: 'confirmation-required' },
    });
    expect(h.quarantine).not.toHaveBeenCalled();

    const result = await h.service.apply(plan.planId, true);
    expect(result.ok).toBe(true);
    expect(h.quarantine).toHaveBeenCalledOnce();
    expect(h.snapshot().info.outcome).toBe('rebuilt');
    expect(h.snapshot().store).not.toBeNull();
    expect(h.index.entries.size).toBe(2);
  });

  it('bez pliku indeksu pomija kwarantanne', async () => {
    const h = await harness({
      probe: { indexFilePresent: false, status: 'recoverable', reason: null },
    });
    const plan = await planOf(h);
    const result = await h.service.apply(plan.planId, true);
    expect(result.ok).toBe(true);
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(h.snapshot().info.quarantinedAs).toBeUndefined();
  });
});

describe('jednobieznosc odbudowy (ADR 0030)', () => {
  it('dwa rownolegle wywolania: jedno wykonuje sie, drugie dostaje busy', async () => {
    const h = await harness();
    const first = await planOf(h);
    const second = await planOf(h);

    const [a, b] = await Promise.all([
      h.service.apply(first.planId, true),
      h.service.apply(second.planId, true),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: { code: 'busy' } });
    expect(h.quarantine).toHaveBeenCalledOnce();
    expect(h.lock.isRebuilding()).toBe(false);
  });

  it('nie startuje, gdy trwa zapis, i zwalnia blokade po bledzie', async () => {
    const h = await harness();
    const plan = await planOf(h);
    const release = h.lock.tryEnterWrite();

    const refused = await h.service.apply(plan.planId, true);
    expect(refused).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(h.quarantine).not.toHaveBeenCalled();
    release?.();

    const again = await planOf(h);
    expect((await h.service.apply(again.planId, true)).ok).toBe(true);
    expect(h.lock.isRebuilding()).toBe(false);
  });

  it('zapisy sa odrzucane w trakcie odbudowy, a po niej znow przechodza', async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const lock = new OperationLock();
    const registry = new IpcRegistry(
      {
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
      { lock },
    );
    const inner = vi.fn(() => ({ ok: true, value: 1 }));
    registry.register('library:save', inner);
    registry.register('library:list', inner);

    const release = lock.tryEnterRebuild();
    expect(await handlers.get('library:save')?.({}, {})).toBe(BUSY_RESULT);
    // Odczyty nie wchodza pod blokade.
    expect(await handlers.get('library:list')?.({}, {})).toEqual({ ok: true, value: 1 });
    expect(inner).toHaveBeenCalledTimes(1);
    release?.();

    expect(await handlers.get('library:save')?.({}, {})).toEqual({ ok: true, value: 1 });
    // Wejscie zapisu blokuje odbudowe, a koniec zapisu ja odblokowuje.
    let during: (() => void) | null = null;
    registry.register('sync:apply', () => {
      during = lock.tryEnterRebuild();
      return { ok: true, value: 2 };
    });
    await handlers.get('sync:apply')?.({}, {});
    expect(during).toBeNull();
    expect(lock.tryEnterRebuild()).not.toBeNull();
  });
});

describe('kanaly nie przyjmuja sciezki (ADR 0030)', () => {
  it('parser apply buduje wynik z dwoch pol i gubi cala reszte', () => {
    const parsed = parseRebuildApplyRequest({
      planId: 'plan-1',
      confirmed: true,
      path: '/etc',
      dbPath: '/tmp/index.db',
      quarantineRoot: '/tmp/q',
    });
    expect(parsed).toEqual({ ok: true, value: { planId: 'plan-1', confirmed: true } });
  });

  it('parser odrzuca ladunki, ktore nie sa obiektem z planId', () => {
    for (const payload of [undefined, null, 'x', 7, [], {}, { planId: '' }, { planId: 5 }]) {
      expect(parseRebuildApplyRequest(payload).ok).toBe(false);
    }
    expect(parseRebuildApplyRequest({ planId: 'x'.repeat(500), confirmed: true }).ok).toBe(false);
  });

  it('confirmed inne niz true nie jest potwierdzeniem', () => {
    for (const confirmed of [false, 'true', 1, undefined]) {
      expect(parseRebuildApplyRequest({ planId: 'p', confirmed })).toEqual({
        ok: true,
        value: { planId: 'p', confirmed: false },
      });
    }
  });

  it('handlery ignoruja sciezke z ladunku: kwarantanna dostaje tylko znacznik czasu', async () => {
    const { registerDiagnosticsHandler } = await import('../../src/main/ipc/handlers/diagnostics');
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const registry = new IpcRegistry({
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    });
    const h = await harness();
    registerDiagnosticsHandler(registry, () => ({ store: null, info: READY }), {
      rebuild: h.service,
    });

    const plan = (await handlers.get('diagnostics:rebuild-index-plan')?.(
      {},
      { path: '/etc/passwd', dbPath: '/x' },
    )) as { ok: true; value: { planId: string; quarantineName: string } };
    expect(plan.ok).toBe(true);
    expect(plan.value.quarantineName).not.toContain('/');

    await handlers.get('diagnostics:rebuild-index-apply')?.(
      {},
      { planId: plan.value.planId, confirmed: true, path: '/etc', quarantineRoot: '/tmp/q' },
    );

    expect(h.quarantine).toHaveBeenCalledOnce();
    const args = h.quarantine.mock.calls[0] ?? [];
    expect(args).toHaveLength(1);
    expect(String(args[0])).not.toMatch(/[\\/]/);
  });

  it('apply z blednym ladunkiem konczy sie bledem zadania, nie wyjatkiem', async () => {
    const { registerDiagnosticsHandler } = await import('../../src/main/ipc/handlers/diagnostics');
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const registry = new IpcRegistry({
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    });
    const h = await harness();
    registerDiagnosticsHandler(registry, () => ({ store: null, info: READY }), {
      rebuild: h.service,
    });

    expect(
      await handlers.get('diagnostics:rebuild-index-apply')?.({}, '/etc/passwd'),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    });
    expect(h.quarantine).not.toHaveBeenCalled();
  });
});
