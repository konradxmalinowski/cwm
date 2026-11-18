import { describe, expect, it, vi } from 'vitest';

import type { IndexStartupInfo } from '../../src/core/model/index-health';
import {
  NO_RETENTION_LIMITS,
  type RetentionReport,
  type RetentionSettings,
} from '../../src/core/model/retention';
import {
  DEFAULT_LIBRARY_GIT_SETTINGS,
  libraryGitEligibility,
  libraryGitSubject,
  parseLibraryGitSettings,
  type LibraryGitSettings,
} from '../../src/core/model/library-git';
import type { LibraryGit, LibraryGitSyncResult } from '../../src/core/ports/library-git';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type { IndexStore } from '../../src/core/ports/index-store';
import { LibraryService } from '../../src/core/services/library/library-service';
import type { RetentionService } from '../../src/core/services/retention/retention-service';
import type { IndexOpenFailure } from '../../src/main/bootstrap/index-startup';
import { parseRebuildApplyRequest } from '../../src/main/ipc/handlers/diagnostics-validation';
import { parseRetentionApplyRequest } from '../../src/main/ipc/handlers/retention-validation';
import { BUSY_RESULT, IpcRegistry } from '../../src/main/ipc/registry';
import {
  IndexRebuildService,
  REBUILD_PLAN_TTL_MS,
  type IndexSnapshot,
  type QuarantineProbeResult,
} from '../../src/main/services/index-rebuild';
import {
  CONSENT_NONCE_TTL_MS,
  LibraryGitRunner,
  VERSIONED_CHANNELS,
} from '../../src/main/services/library-git-runner';
import { PREVIEW_TOKEN_TTL_MS, RetentionRunner } from '../../src/main/services/retention-runner';
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

describe('czyszczenie historii: blokada, potwierdzenie i ustawienia (ADR 0056)', () => {
  const report: RetentionReport = {
    applied: true,
    blocked: null,
    entriesBefore: 3,
    entriesRemoved: 1,
    objectsBefore: 5,
    objectsRemoved: 2,
    bytesBefore: 100,
    bytesFreed: 40,
    sizeLimitUnmet: false,
    objectsFailed: 0,
    objectsSkipped: 0,
    ageRuleSkipped: false,
  };

  function retention(
    options: { service?: 'missing' | 'throws'; settings?: RetentionSettings } = {},
  ) {
    let stored: RetentionSettings = options.settings ?? NO_RETENTION_LIMITS;
    let clock = 1_000_000;
    const run = vi.fn(() =>
      options.service === 'throws'
        ? Promise.reject(new Error('sekret z /home/acme/objects'))
        : Promise.resolve(report),
    );
    const lock = new OperationLock();
    const runner = new RetentionRunner({
      settings: {
        load: () => Promise.resolve(stored),
        save: (next) => {
          stored = next;
          return Promise.resolve();
        },
      },
      service: () =>
        options.service === 'missing' ? null : ({ run } as unknown as RetentionService),
      lock,
      now: () => clock,
    });
    return {
      runner,
      run,
      lock,
      stored: () => stored,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  async function tokenOf(h: ReturnType<typeof retention>): Promise<string> {
    const preview = await h.runner.preview();
    if (!preview.ok || preview.value.previewToken === null) throw new Error('brak tokenu');
    return preview.value.previewToken;
  }

  it('wykonanie wymaga potwierdzenia i tokenu z podgladu, a token jest jednorazowy', async () => {
    const h = retention();
    expect(await h.runner.apply(false, 'x')).toMatchObject({
      ok: false,
      error: { code: 'confirmation-required' },
    });
    expect(await h.runner.apply(true, 'nie-ma-takiego')).toMatchObject({
      ok: false,
      error: { code: 'plan-expired' },
    });
    expect(h.run).not.toHaveBeenCalled();

    const token = await tokenOf(h);
    expect(h.run).toHaveBeenLastCalledWith({ apply: false });
    expect(await h.runner.apply(true, token)).toMatchObject({ ok: true });
    expect(h.run).toHaveBeenLastCalledWith({
      apply: true,
      ceiling: { entries: 1, objects: 2 },
    });
    expect(await h.runner.apply(true, token)).toMatchObject({
      ok: false,
      error: { code: 'plan-expired' },
    });
  });

  it('token wygasa po kilku minutach, a zmiana ustawien uniewaznia podglad', async () => {
    const h = retention();
    const token = await tokenOf(h);
    h.advance(PREVIEW_TOKEN_TTL_MS + 1);
    expect(await h.runner.apply(true, token)).toMatchObject({ error: { code: 'plan-expired' } });

    const second = await tokenOf(h);
    await h.runner.setSettings({ maxAgeDays: 30, confirmed: true });
    expect(await h.runner.apply(true, second)).toMatchObject({ error: { code: 'stale-plan' } });
  });

  it('plan, ktory urosl od podgladu, daje plan-changed i nic nie jest wykonane', async () => {
    const h = retention();
    const token = await tokenOf(h);
    h.run.mockResolvedValueOnce({ ...report, applied: false, blocked: 'plan-changed' });

    const result = await h.runner.apply(true, token);

    expect(result).toMatchObject({ ok: false, error: { code: 'plan-changed' } });
  });

  it('podglad z limitami z formularza przekazuje je dalej, a zle limity odrzuca', async () => {
    const h = retention();
    await h.runner.preview({ settings: { maxEntries: 50, maxAgeDays: null, maxStoreMiB: null } });
    expect(h.run).toHaveBeenLastCalledWith({
      apply: false,
      settings: { maxEntries: 50, maxAgeDays: null, maxStoreMiB: null },
    });
    expect(await h.runner.preview({ settings: { maxEntries: 3 } })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    });
  });

  it('trwajacy zapis blokuje czyszczenie, a czyszczenie blokuje zapisy i zwalnia blokade po koncu', async () => {
    const h = retention();
    const writer = h.lock.tryEnterWrite();
    expect(await h.runner.preview()).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(h.run).not.toHaveBeenCalled();
    writer?.();

    let duringRun: (() => void) | null = null;
    h.run.mockImplementationOnce(() => {
      duringRun = h.lock.tryEnterWrite();
      return Promise.resolve(report);
    });
    await h.runner.preview();
    expect(duringRun).toBeNull();
    expect(h.lock.tryEnterWrite()).not.toBeNull();
  });

  it('brak serwisu to unavailable, a blad serwisu nie wycieka tresci i zwalnia blokade', async () => {
    expect(await retention({ service: 'missing' }).runner.preview()).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });

    const h = retention({ service: 'throws' });
    const result = await h.runner.preview();
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('sekret');
    expect(h.lock.tryEnterWrite()).not.toBeNull();
  });

  it('ustawienia: zakres sprawdza main, a wlaczenie i zaostrzenie limitu wymaga potwierdzenia', async () => {
    const h = retention();
    expect(await h.runner.setSettings({ maxEntries: 9 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    });
    expect(await h.runner.setSettings({ maxAgeDays: 1.5 })).toMatchObject({ ok: false });
    expect(await h.runner.setSettings({ maxStoreMiB: '100' })).toMatchObject({ ok: false });
    expect(await h.runner.setSettings({ maxEntries: 1_000_001 })).toMatchObject({ ok: false });

    // Wlaczenie limitu bez potwierdzenia nie zapisuje niczego.
    expect(await h.runner.setSettings({ maxEntries: 50 })).toMatchObject({
      ok: false,
      error: { code: 'confirmation-required' },
    });
    expect(h.stored()).toEqual(NO_RETENTION_LIMITS);

    const saved = await h.runner.setSettings({
      maxEntries: 50,
      maxAgeDays: null,
      maxStoreMiB: 1_048_576,
      confirmed: true,
      path: '/etc',
    });
    expect(saved).toEqual({
      ok: true,
      value: { maxEntries: 50, maxAgeDays: null, maxStoreMiB: 1_048_576, startupNotice: null },
    });
    expect(h.stored()).toEqual({ maxEntries: 50, maxAgeDays: null, maxStoreMiB: 1_048_576 });

    // Zaostrzenie wymaga potwierdzenia, poluzowanie i wylaczenie nie.
    expect(await h.runner.setSettings({ maxEntries: 20, maxStoreMiB: 100 })).toMatchObject({
      ok: false,
      error: { code: 'confirmation-required' },
    });
    expect(await h.runner.setSettings({ maxEntries: 100 })).toMatchObject({
      ok: true,
    });
    expect(await h.runner.setSettings({})).toMatchObject({ ok: true });
    expect(h.stored()).toEqual(NO_RETENTION_LIMITS);
  });

  it('przebieg przy starcie rusza tylko przy wlaczonym limicie, bez nadzoru, i pomija niewiarygodny indeks', async () => {
    const off = retention();
    await off.runner.runAtStartup();
    expect(off.run).not.toHaveBeenCalled();

    const on = retention({ settings: { ...NO_RETENTION_LIMITS, maxAgeDays: 90 } });
    await on.runner.runAtStartup();
    expect(on.run).toHaveBeenCalledWith({ apply: true, unattended: true });

    const fresh = retention({ settings: { ...NO_RETENTION_LIMITS, maxAgeDays: 90 } });
    await fresh.runner.runAtStartup('index-new');
    expect(fresh.run).not.toHaveBeenCalled();
    expect(await fresh.runner.getSettings()).toMatchObject({
      ok: true,
      value: { startupNotice: 'index-new' },
    });

    const blocked = retention({ settings: { ...NO_RETENTION_LIMITS, maxAgeDays: 90 } });
    blocked.run.mockResolvedValueOnce({ ...report, applied: false, blocked: 'mass-prune' });
    await blocked.runner.runAtStartup();
    expect(await blocked.runner.getSettings()).toMatchObject({
      value: { startupNotice: 'mass-prune' },
    });
  });

  it('parser wykonania gubi wszystko poza potwierdzeniem i tokenem', () => {
    expect(
      parseRetentionApplyRequest({ confirmed: true, token: 'abc', hashes: ['x'], path: '/' }),
    ).toEqual({ ok: true, value: { confirmed: true, token: 'abc' } });
    expect(parseRetentionApplyRequest({ token: 'abc' })).toEqual({
      ok: true,
      value: { confirmed: false, token: 'abc' },
    });
    expect(parseRetentionApplyRequest({ confirmed: true }).ok).toBe(false);
    expect(parseRetentionApplyRequest({ confirmed: true, token: 'a'.repeat(129) }).ok).toBe(false);
    expect(parseRetentionApplyRequest(null).ok).toBe(false);
    expect(parseRetentionApplyRequest([]).ok).toBe(false);
  });
});

describe('wersjonowanie biblioteki w Git: ustawienia, zgoda i blokada (ADR 0060)', () => {
  it('ustawienia: dwa pola logiczne, reszta przepada, niebooleowska wartosc to blad', () => {
    expect(parseLibraryGitSettings({ enabled: true, includePrivate: false, path: '/x' })).toEqual({
      ok: true,
      value: { enabled: true, includePrivate: false },
    });
    for (const bad of [null, [], 'tak', { enabled: true }, { enabled: 1, includePrivate: false }]) {
      expect(parseLibraryGitSettings(bad).ok).toBe(false);
    }
  });

  it('temat commita to typ operacji i liczba elementow, bez nazw', () => {
    expect(libraryGitSubject('import', 3)).toBe('import: 3 items');
    expect(libraryGitSubject('delete', 1)).toBe('delete: 1 item');
  });

  it('zasada wejscia do historii: public tak, prywatne za zgoda, sekret nigdy, nieczytelne nigdy', () => {
    const item = (scope: unknown, secretFindings: unknown): unknown => ({
      classification: { scope, secretFindings },
    });
    expect(libraryGitEligibility(item('public', []), false)).toBe('included');
    expect(libraryGitEligibility(item('private', []), false)).toBe('excluded-private');
    expect(libraryGitEligibility(item('project', []), false)).toBe('excluded-private');
    expect(libraryGitEligibility(item('private', []), true)).toBe('included');
    expect(libraryGitEligibility(item('project', []), true)).toBe('included');
    const found = [{ rule: 'r', relPath: 'body.md', line: 1 }];
    expect(libraryGitEligibility(item('public', found), true)).toBe('excluded-secrets');
    for (const broken of [
      null,
      [],
      {},
      { classification: null },
      item('inny', []),
      item('public', 'brak'),
      item(undefined, []),
    ]) {
      expect(libraryGitEligibility(broken, true)).toBe('excluded-unreadable');
    }
  });

  it('tylko kanaly zapisujace biblioteke dostaja commit', () => {
    expect(Object.keys(VERSIONED_CHANNELS).sort()).toEqual([
      'import:apply',
      'library:delete-apply',
      'library:repair',
      'library:save',
      'projects:remove',
    ]);
  });

  function versioning(
    options: {
      settings?: LibraryGitSettings;
      available?: boolean;
      sync?: () => Promise<LibraryGitSyncResult>;
    } = {},
  ) {
    let clock = 1_000_000;
    let nonceCounter = 0;
    /** Czy w oknie commita (po zwolnieniu blokady przez git) odbudowa moglaby wejsc. */
    const exclusiveDuringCommit: boolean[] = [];
    let stored = options.settings ?? DEFAULT_LIBRARY_GIT_SETTINGS;
    const lock = new OperationLock();
    const calls: { operation: string; includePrivate: boolean }[] = [];
    const git: LibraryGit = {
      probe: () =>
        Promise.resolve(
          options.available === false
            ? { available: false, message: 'brak gita' }
            : { available: true },
        ),
      status: () =>
        Promise.resolve({
          repository: false,
          commits: 0,
          last: null,
          items: {
            included: 0,
            excludedPrivate: 2,
            excludedSecrets: 1,
            excludedGitEntry: 0,
            excludedUnreadable: 0,
          },
        }),
      sync: (input) => {
        // Jak prawdziwy adapter: blokada tylko na skan i staging, zajeta blokada to `skipped`.
        const release = input.guard?.() ?? null;
        if (input.guard !== undefined && release === null) {
          return Promise.resolve({ ok: true, committed: false, items: 0, skipped: true });
        }
        release?.();
        const gap = lock.tryEnterExclusive();
        exclusiveDuringCommit.push(gap !== null);
        gap?.();
        calls.push({ operation: input.operation, includePrivate: input.includePrivate });
        return options.sync?.() ?? Promise.resolve({ ok: true, committed: true, items: 1 });
      },
    };
    const logUnexpected = vi.fn();
    const runner = new LibraryGitRunner({
      settings: {
        load: () => Promise.resolve(stored),
        save: (next) => {
          stored = next;
          return Promise.resolve();
        },
      },
      git,
      lock,
      logUnexpected,
      now: () => clock,
      newNonce: () => `nonce-${(nonceCounter += 1)}`,
    });
    return {
      runner,
      calls,
      lock,
      stored: () => stored,
      logUnexpected,
      exclusiveDuringCommit,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('wylaczone wersjonowanie: operacja biblioteki nie uruchamia gita', async () => {
    const h = versioning();
    h.runner.afterWrite('library:save');
    await h.runner.idle();
    expect(h.calls).toEqual([]);
  });

  it('wlaczone: commit z typem operacji i zgoda z ustawien; kanal spoza listy go nie wywoluje', async () => {
    const h = versioning({ settings: { enabled: true, includePrivate: true } });
    h.runner.afterWrite('import:apply');
    h.runner.afterWrite('export:apply');
    h.runner.afterWrite('history:rollback');
    await h.runner.idle();
    expect(h.calls).toEqual([{ operation: 'import', includePrivate: true }]);
  });

  it('awaria gita to ostrzezenie w stanie, nie blad, a nastepny commit je czysci', async () => {
    let fail = true;
    const h = versioning({
      settings: { enabled: true, includePrivate: false },
      sync: () =>
        Promise.resolve(
          fail
            ? { ok: false, message: 'Polecenie git nie powiodło się (add).' }
            : { ok: true, committed: true, items: 2 },
        ),
    });
    h.runner.afterWrite('library:save');
    await h.runner.idle();
    const failed = await h.runner.getState();
    expect(failed.ok && failed.value.warning).toBe('Polecenie git nie powiodło się (add).');
    expect(failed.ok && failed.value.itemsExcludedSecrets).toBe(1);

    fail = false;
    h.runner.afterWrite('library:delete-apply');
    await h.runner.idle();
    const healed = await h.runner.getState();
    expect(healed.ok && healed.value.warning).toBeNull();
  });

  it('wyjatek z gita jest polkniety i zalogowany, kolejka dziala dalej', async () => {
    let boom = true;
    const h = versioning({
      settings: { enabled: true, includePrivate: false },
      sync: () => {
        if (boom) return Promise.reject(new Error('sekret z /home/acme/library-git'));
        return Promise.resolve({ ok: true, committed: false, items: 0 });
      },
    });
    h.runner.afterWrite('library:save');
    await expect(h.runner.idle()).resolves.toBeUndefined();
    expect(h.logUnexpected).toHaveBeenCalledOnce();
    const state = await h.runner.getState();
    expect(JSON.stringify(state)).not.toContain('/home/acme');
    boom = false;
    h.runner.afterWrite('library:save');
    await h.runner.idle();
    expect(h.calls).toHaveLength(2);
  });

  it('trwajaca odbudowa: commit jest pominiety bez ostrzezenia, git nie dziala pod blokada commita', async () => {
    const h = versioning({ settings: { enabled: true, includePrivate: false } });
    const release = h.lock.tryEnterExclusive();
    expect(release).not.toBeNull();
    h.runner.afterWrite('library:save');
    await h.runner.idle();
    release?.();
    expect(h.calls).toEqual([]);
    const state = await h.runner.getState();
    expect(state.ok && state.value.warning).toBeNull();

    h.runner.afterWrite('library:save');
    await h.runner.idle();
    expect(h.calls).toHaveLength(1);
    // Blokada zapisu jest zwolniona, zanim git zacznie commit (ADR 0060, punkt 4).
    expect(h.exclusiveDuringCommit).toEqual([true]);
  });

  it('wlaczenie bez gita: blad z powodem i ustawienia bez zmian', async () => {
    const h = versioning({ available: false });
    const result = await h.runner.setSettings({ enabled: true, includePrivate: false });
    expect(result).toEqual({
      ok: false,
      error: { code: 'git-unavailable', message: 'brak gita' },
    });
    expect(h.stored()).toEqual(DEFAULT_LIBRARY_GIT_SETTINGS);
    expect(h.calls).toEqual([]);
  });

  it('wlaczenie robi pierwsza synchronizacje przed zapisem; jej awaria nie zmienia ustawien', async () => {
    const failing = versioning({
      sync: () => Promise.resolve({ ok: false, message: 'Polecenie git nie powiodło się (init).' }),
    });
    const refused = await failing.runner.setSettings({ enabled: true, includePrivate: false });
    expect(refused.ok).toBe(false);
    expect(failing.stored().enabled).toBe(false);

    const h = versioning();
    const done = await h.runner.setSettings({ enabled: true, includePrivate: false });
    expect(done.ok && done.value.enabled).toBe(true);
    expect(h.calls).toEqual([{ operation: 'enable', includePrivate: false }]);
    expect(h.stored()).toEqual({ enabled: true, includePrivate: false });
  });

  async function nonceOf(h: ReturnType<typeof versioning>): Promise<string> {
    const state = await h.runner.getState();
    if (!state.ok) throw new Error('brak stanu');
    return state.value.consentNonce;
  }

  it('zmiana zgody przy wlaczonej funkcji to pelna synchronizacja, wylaczenie nie dotyka repozytorium', async () => {
    const h = versioning({ settings: { enabled: true, includePrivate: false } });
    const done = await h.runner.setSettings({
      enabled: true,
      includePrivate: true,
      acknowledged: true,
      nonce: await nonceOf(h),
    });
    expect(done.ok).toBe(true);
    expect(h.calls).toEqual([{ operation: 'resync', includePrivate: true }]);
    await h.runner.setSettings({ enabled: false, includePrivate: true });
    expect(h.calls).toHaveLength(1);
    expect(h.stored()).toEqual({ enabled: false, includePrivate: true });
  });

  it('zgoda na prywatne elementy: main wymaga potwierdzenia i jednorazowego znacznika', async () => {
    const h = versioning();
    const request = { enabled: true, includePrivate: true };
    // Bez potwierdzenia.
    const none = await h.runner.setSettings(request);
    expect(none.ok === false && none.error.code).toBe('consent-required');
    // Potwierdzenie bez znacznika albo z cudzym.
    for (const nonce of [undefined, '', 'nonce-zmyslony']) {
      const forged = await h.runner.setSettings({
        ...request,
        acknowledged: true,
        ...(nonce === undefined ? {} : { nonce }),
      });
      expect(forged.ok === false && forged.error.code).toBe('consent-expired');
    }
    expect(h.stored()).toEqual(DEFAULT_LIBRARY_GIT_SETTINGS);
    expect(h.calls).toEqual([]);

    // Znacznik z odczytu stanu dziala raz.
    const nonce = await nonceOf(h);
    const granted = await h.runner.setSettings({ ...request, acknowledged: true, nonce });
    expect(granted.ok).toBe(true);
    expect(h.stored()).toEqual({ enabled: true, includePrivate: true });
    const replay = await h.runner.setSettings({
      enabled: true,
      includePrivate: true,
      acknowledged: true,
      nonce,
    });
    // Zgoda juz obowiazuje, wiec powtorka nie wymaga nowego znacznika, ale nowa zgoda po wylaczeniu tak.
    expect(replay.ok).toBe(true);
    await h.runner.setSettings({ enabled: false, includePrivate: true });
    const again = await h.runner.setSettings({
      enabled: true,
      includePrivate: true,
      acknowledged: true,
      nonce,
    });
    expect(again.ok === false && again.error.code).toBe('consent-expired');
  });

  it('znacznik zgody wygasa po kilku minutach', async () => {
    const h = versioning();
    const nonce = await nonceOf(h);
    h.advance(CONSENT_NONCE_TTL_MS + 1);
    const late = await h.runner.setSettings({
      enabled: true,
      includePrivate: true,
      acknowledged: true,
      nonce,
    });
    expect(late.ok === false && late.error.code).toBe('consent-expired');
  });

  it('zgoda nie jest potrzebna do wlaczenia samych elementow publicznych ani do wylaczenia', async () => {
    const h = versioning();
    expect((await h.runner.setSettings({ enabled: true, includePrivate: false })).ok).toBe(true);
    expect((await h.runner.setSettings({ enabled: false, includePrivate: true })).ok).toBe(true);
  });

  it('zapis ustawien odpowiada busy w trakcie odbudowy i odrzuca niepoprawny ladunek', async () => {
    const h = versioning();
    const release = h.lock.tryEnterExclusive();
    const busy = await h.runner.setSettings({ enabled: true, includePrivate: false });
    expect(busy.ok === false && busy.error.code).toBe('busy');
    release?.();
    const invalid = await h.runner.setSettings({ enabled: 'tak' });
    expect(invalid.ok === false && invalid.error.code).toBe('invalid-request');
  });
});
