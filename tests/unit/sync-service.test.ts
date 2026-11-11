import { describe, expect, it } from 'vitest';

import type { Sha256, ToolId } from '../../src/core/model/item';
import type { SyncRecord, SyncStateStore } from '../../src/core/ports/sync-state';
import { SourceReadError, type SourceReader } from '../../src/core/ports/source-reader';
import type { ToolExporter } from '../../src/core/ports/tool-adapter';
import { sha256Bytes } from '../../src/core/services/normalization/hash';
import { SyncError, SyncService } from '../../src/core/services/sync/sync-service';
import { FakeCatalog, root } from './import-fakes';
import { bytes } from './library-fakes';
import { exportHarness } from './export-fakes';

class MemState implements SyncStateStore {
  readonly rows = new Map<string, SyncRecord>();
  get(itemId: string, tool: ToolId) {
    return Promise.resolve(this.rows.get(`${itemId}|${tool}`) ?? null);
  }
  list(tool?: ToolId) {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => tool === undefined || r.tool === tool),
    );
  }
  put(r: SyncRecord) {
    this.rows.set(`${r.itemId}|${r.tool}`, r);
    return Promise.resolve();
  }
  remove(itemId: string, tool: ToolId) {
    this.rows.delete(`${itemId}|${tool}`);
    return Promise.resolve();
  }
}

class MemReader implements SourceReader {
  files = new Map<string, Uint8Array>();
  read(_root: string, relPath: string) {
    const f = this.files.get(relPath);
    return f === undefined
      ? Promise.reject(new SourceReadError('not-found', relPath, 'brak'))
      : Promise.resolve(f);
  }
  list() {
    return Promise.resolve([]);
  }
  resolveSymlink() {
    return Promise.reject(new Error('nieuzywane'));
  }
  mode() {
    return Promise.resolve(null);
  }
}

async function setup(level: 'full' | 'unsupported' = 'full') {
  const h = await exportHarness();
  const state = new MemState();
  const reader = new MemReader();
  const exporter: ToolExporter = {
    id: 'claude-code',
    capabilities: () => ({ level, reasons: [], lostAttributes: [], addedAttributes: [] }),
    plan: (items, ctx) => h.exporter.plan(items, ctx),
  };
  const catalog = new FakeCatalog([root('r-claude', 'claude-code')]);
  const sync = new SyncService({
    catalog,
    adapters: [],
    exporters: [exporter],
    reader,
    library: h.library,
    exports: h.service,
    state,
    log: h.log,
    clock: h.clock,
    newSyncId: (() => {
      let n = 0;
      return () => `sync-${++n}`;
    })(),
  });
  return { ...h, state, reader, sync, catalog };
}

const record = (itemId: string, over: Partial<SyncRecord> = {}): SyncRecord => ({
  itemId: itemId as never,
  tool: 'claude-code',
  itemRevision: 1,
  itemContentHash: '' as Sha256,
  files: [{ rootId: 'r-claude', relPath: 'f.md', writtenHash: sha256Bytes(bytes('a')) }],
  syncedAt: 'T',
  backupId: 'b',
  ...over,
});

describe('SyncService: stany', () => {
  it('never i unsupported bez rekordu', async () => {
    const s = await setup();
    expect((await s.sync.status(['claude-code'])).items[0]?.status).toBe('never');
    const u = await setup('unsupported');
    expect((await u.sync.status(['claude-code'])).items[0]?.status).toBe('unsupported');
  });

  it('in-sync, library-changed, tool-changed, conflict i missing-in-tool', async () => {
    const s = await setup();
    const loaded = await s.library.get(s.itemId);
    const hashOk = loaded.item.version.contentHash;
    const status = async () => (await s.sync.status(['claude-code'])).items[0]?.status;

    s.reader.files.set('f.md', bytes('a'));
    await s.state.put(record(s.itemId, { itemContentHash: hashOk }));
    expect(await status()).toBe('in-sync');

    await s.state.put(record(s.itemId, { itemContentHash: '1'.repeat(64) as Sha256 }));
    expect(await status()).toBe('library-changed');

    await s.state.put(record(s.itemId, { itemContentHash: hashOk }));
    s.reader.files.set('f.md', bytes('zmieniony'));
    expect(await status()).toBe('tool-changed');

    await s.state.put(record(s.itemId, { itemContentHash: '1'.repeat(64) as Sha256 }));
    expect(await status()).toBe('conflict');

    s.reader.files.delete('f.md');
    expect(await status()).toBe('missing-in-tool');
  });

  it('narzedzie bez katalogu glownego trafia do missingTools', async () => {
    const s = await setup();
    s.catalog.homes = new Set();
    const report = await s.sync.status(['claude-code']);
    expect(report.missingTools).toEqual(['claude-code']);
    expect(report.items).toEqual([]);
  });

  it('konflikt bez decyzji jest pominiety, library-wins eksportuje', async () => {
    const s = await setup();
    s.reader.files.set('f.md', bytes('zmieniony'));
    await s.state.put(record(s.itemId, { itemContentHash: '1'.repeat(64) as Sha256 }));

    const skipped = await s.sync.plan(['claude-code'], [s.itemId]);
    expect(skipped.plans).toEqual([]);
    expect(skipped.skipped[0]?.reason).toContain('obu stronach');
    expect(skipped.applicable).toBe(false);

    const wins = await s.sync.plan(
      ['claude-code'],
      [s.itemId],
      [{ itemId: s.itemId, tool: 'claude-code', resolution: 'library-wins' }],
    );
    expect(wins.plans).toHaveLength(1);
    expect(wins.applicable).toBe(true);
  });

  it('exportDecisions trafiaja do planu eksportu jako decyzje', async () => {
    const s = await setup();
    const decision = {
      itemId: s.itemId,
      relPath: 'CLAUDE.md',
      resolution: 'replace-fragment' as const,
    };
    await s.sync.plan(['claude-code'], [s.itemId], [], [decision]);
    expect(s.exporter.contexts.at(-1)?.decisions).toEqual([decision]);
    await s.sync.plan(['claude-code'], [s.itemId]);
    expect(s.exporter.contexts.at(-1)?.decisions).toBeUndefined();
  });

  it('apply: wymaga zatwierdzenia, plan jest jednorazowy i wygasa', async () => {
    const s = await setup();
    const plan = await s.sync.plan(['claude-code'], [s.itemId]);
    await expect(s.sync.apply(plan.syncId, false)).rejects.toMatchObject({ code: 'not-approved' });
    const done = await s.sync.apply(plan.syncId, true);
    expect(done.results).toHaveLength(1);
    await expect(s.sync.apply(plan.syncId, true)).rejects.toBeInstanceOf(SyncError);

    const second = await s.sync.plan(['claude-code'], [s.itemId]);
    s.clock.advance(16 * 60 * 1000);
    await expect(s.sync.apply(second.syncId, true)).rejects.toMatchObject({ code: 'sync-expired' });
  });

  it('plan bez elementow jest odrzucony', async () => {
    const s = await setup();
    await expect(s.sync.plan(['claude-code'], [])).rejects.toMatchObject({ code: 'no-items' });
  });
});
