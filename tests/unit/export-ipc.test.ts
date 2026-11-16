import { deflateRawSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { registerExportHandlers, type ZipPort } from '../../src/main/ipc/handlers/export';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { ExportService } from '../../src/core/services/export/export-service';
import { IMPLEMENTED_CHANNELS, IPC_CHANNELS } from '../../src/shared/ipc/channels';
import { ZipExportService } from '../../src/core/services/export/zip-export-service';
import {
  parseZipPlanRequest,
  parseZipSaveRequest,
} from '../../src/main/ipc/handlers/export-validation';
import type {
  ExportApplyDto,
  ExportPlanDto,
  ExportZipPlanDto,
} from '../../src/shared/ipc/export-contract';
import type { Result } from '../../src/shared/ipc/library-contract';
import { root } from './import-fakes';
import { bytes } from './library-fakes';
import { emptyPlan, entry, exportHarness } from './export-fakes';

function wire(service: ExportService | null, zip: ZipPort | null = null) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const registry = new IpcRegistry({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });
  const logged: unknown[] = [];
  registerExportHandlers(registry, {
    service: () => service,
    zip: () => zip,
    logUnexpected: (e) => logged.push(e),
  });
  const call = async <T = unknown>(channel: string, payload?: unknown): Promise<Result<T>> =>
    (await handlers.get(channel)?.({}, payload)) as Result<T>;
  return { call, registry, logged };
}

const SECRET_BODY = 'TRESC-NIE-DLA-LOGU';

describe('kanaly export:*', () => {
  it('kanaly sa na liscie i zaimplementowane, rejestr ma dokladnie cztery', () => {
    for (const channel of [
      'export:plan',
      'export:apply',
      'export:zip-plan',
      'export:zip-save',
    ] as const) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IMPLEMENTED_CHANNELS).toContain(channel);
    }
    expect(wire(null).registry.list()).toEqual([
      'export:apply',
      'export:plan',
      'export:zip-plan',
      'export:zip-save',
    ]);
  });

  it('bez serwisu odpowiadaja bledem, nie wyjatkiem', async () => {
    const { call } = wire(null);
    const r = await call('export:plan', { tool: 'claude-code', itemIds: ['x'] });
    expect(r).toMatchObject({ ok: false, error: { code: 'export-unavailable' } });
  });

  it('odrzuca zle ladunki', async () => {
    const h = await exportHarness();
    const { call } = wire(h.service);
    for (const payload of [
      undefined,
      null,
      {},
      { tool: 'vim', itemIds: ['x'] },
      { tool: 'codex', itemIds: [] },
      { tool: 'codex', itemIds: [1] },
      { tool: 'codex', itemIds: 'x' },
    ]) {
      expect(await call('export:plan', payload)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      });
    }
    for (const payload of [
      undefined,
      {},
      { planId: 'p' },
      { planId: 'p', approved: false },
      { planId: 'p', approved: 'true' },
      { planId: '', approved: true },
    ]) {
      expect(await call('export:apply', payload)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      });
    }
  });

  it('plan w DTO nie niesie sciezek bezwzglednych ani rootId, a etykiety tak', async () => {
    const big = new Uint8Array(300 * 1024).fill(65);
    const h = await exportHarness({
      roots: [root('r-claude', 'claude-code')],
      build: (items) =>
        emptyPlan({
          entries: [
            entry({
              itemIds: [items[0]!.item.id],
              content: bytes(`${SECRET_BODY}\n`),
              previous: bytes('stare\n'),
            }),
            entry({ relPath: 'bin/ikona.png', content: Uint8Array.of(137, 80, 0, 71) }),
            entry({ relPath: 'duzy.md', content: big }),
            entry({
              relPath: 'acme-dir',
              action: 'link',
              content: null,
              materialization: 'symlink',
              files: [{ relPath: 'SKILL.md', bytes: bytes('x') }],
            }),
          ],
          orphans: [{ rootId: 'r-claude', relPath: 'stary/SKILL.md', reason: 'poza biblioteka' }],
        }),
    });
    const { call } = wire(h.service);
    const r = await call<ExportPlanDto>('export:plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
      extra: 'ignorowane',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('plan nie powiodl sie');

    const json = JSON.stringify(r);
    expect(json).not.toContain('r-claude');
    expect(json).not.toMatch(/"\/|[A-Za-z]:\\\\|\/Users\/|\/home\//);
    const dto = r.value;
    expect(dto.entries.map((e) => e.entryId)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(dto.entries[0]).toMatchObject({
      rootLabel: '~/.claude/skills',
      before: 'stare\n',
      after: `${SECRET_BODY}\n`,
      recoverability: 'recoverable',
      blockedReason: null,
    });
    expect(dto.entries[1]).toMatchObject({ before: null, after: null });
    expect(dto.entries[2]?.after).toBeNull();
    expect(dto.entries[3]).toMatchObject({
      after: null,
      files: ['SKILL.md'],
      materialization: 'symlink',
    });
    expect(dto.orphans).toEqual([
      { rootLabel: '~/.claude/skills', relPath: 'stary/SKILL.md', reason: 'poza biblioteka' },
    ]);
    expect(dto.verdicts).toBeDefined();
    expect(dto.applicable).toBe(true);
  });

  it('plan z samymi wpisami unchanged nie jest do zapisu', async () => {
    const h = await exportHarness({
      roots: [root('r-claude', 'claude-code')],
      build: () => emptyPlan({ entries: [entry({ action: 'unchanged' })] }),
    });
    const { call } = wire(h.service);
    const r = await call<ExportPlanDto>('export:plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
    });
    expect(r.ok && r.value.applicable).toBe(false);
  });

  it('resolutions: walidacja, przekazanie do eksportera i opcje konfliktu w DTO', async () => {
    const h = await exportHarness({
      roots: [root('r-claude', 'claude-code')],
      build: (items) =>
        emptyPlan({
          conflicts: [
            {
              itemIds: [items[0]!.item.id],
              relPath: 'CLAUDE.md',
              reason: 'konflikt',
              options: [
                { id: 'replace-fragment', label: 'Zamień ten fragment na blok aplikacji' },
                { id: 'append-block', label: 'Dopisz blok na końcu' },
              ],
            },
          ],
          applicable: false,
        }),
    });
    const { call } = wire(h.service);
    for (const resolutions of [
      'x',
      [1],
      [{ itemId: h.itemId, relPath: 'CLAUDE.md', resolution: 'zrob-cos' }],
      [{ itemId: '', relPath: 'CLAUDE.md', resolution: 'append-block' }],
      [{ itemId: h.itemId, resolution: 'append-block' }],
    ]) {
      expect(
        await call('export:plan', { tool: 'claude-code', itemIds: [h.itemId], resolutions }),
      ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }

    const r = await call<ExportPlanDto>('export:plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
      resolutions: [{ itemId: h.itemId, relPath: 'CLAUDE.md', resolution: 'append-block' }],
    });
    expect(h.exporter.contexts.at(-1)?.decisions).toEqual([
      { itemId: h.itemId, relPath: 'CLAUDE.md', resolution: 'append-block' },
    ]);
    if (!r.ok) throw new Error('plan nie powiodl sie');
    expect(r.value.applicable).toBe(false);
    expect(r.value.conflicts[0]?.options?.map((o) => o.id)).toEqual([
      'replace-fragment',
      'append-block',
    ]);

    await call('export:plan', { tool: 'claude-code', itemIds: [h.itemId] });
    expect(h.exporter.contexts.at(-1)?.decisions).toBeUndefined();
  });

  it('toolMissing wraca w DTO jako nieaplikowalny plan bez wpisow', async () => {
    const h = await exportHarness({ roots: [root('r-claude', 'claude-code', { exists: false })] });
    h.catalog.homes = new Set();
    const { call } = wire(h.service);
    const r = await call<ExportPlanDto>('export:plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
    });
    expect(r).toMatchObject({
      ok: true,
      value: { toolMissing: true, entries: [], applicable: false },
    });
  });

  it('apply: przeplyw plan, zatwierdzenie, powtorka odrzucona', async () => {
    const h = await exportHarness();
    const { call } = wire(h.service);
    const plan = await call<ExportPlanDto>('export:plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
    });
    if (!plan.ok) throw new Error('plan nie powiodl sie');

    const applied = await call<ExportApplyDto>('export:apply', {
      planId: plan.value.planId,
      approved: true,
    });
    expect(applied).toEqual({
      ok: true,
      value: {
        planId: plan.value.planId,
        backupId: 'backup-1',
        entries: [{ entryId: 'e1', outcome: 'written', message: null }],
        verified: true,
        rolledBack: false,
      },
    });
    expect(await call('export:apply', { planId: plan.value.planId, approved: true })).toMatchObject(
      {
        ok: false,
        error: { code: 'unknown-plan' },
      },
    );
  });

  it('blad nieoczekiwany jest logowany, a klient dostaje ogolny komunikat', async () => {
    const h = await exportHarness();
    h.exporter.plan = () => Promise.reject(new Error('/Users/ktos/.claude/tajne'));
    const { call, logged } = wire(h.service);
    const r = await call('export:plan', { tool: 'claude-code', itemIds: [h.itemId] });
    expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(r)).not.toContain('/Users');
    expect(logged).toHaveLength(1);
  });
});

describe('kanaly export:zip-* (ADR 0054)', () => {
  async function zipWire() {
    const h = await exportHarness();
    const zip = new ZipExportService({
      catalog: h.catalog,
      exporters: [h.exporter],
      library: h.library,
      clock: h.clock,
      appVersion: '1.2.3',
      deflate: (b) => new Uint8Array(deflateRawSync(b)),
      newPlanId: () => 'zip-plan-1',
    });
    const save = vi.fn<ZipPort['save']>(() =>
      Promise.resolve({ ok: true, value: { status: 'cancelled' } }),
    );
    const port: ZipPort = { plan: (t, ids, confirmed) => zip.plan(t, ids, confirmed), save };
    return { h, save, ...wire(null, port) };
  }

  it('bez portu oba kanaly odpowiadaja bledem, nie wyjatkiem', async () => {
    const { call } = wire(null);
    expect(await call('export:zip-plan', { tool: 'codex', itemIds: ['x'] })).toMatchObject({
      ok: false,
      error: { code: 'export-unavailable' },
    });
    expect(await call('export:zip-save', { planId: 'p', approved: true })).toMatchObject({
      ok: false,
      error: { code: 'export-unavailable' },
    });
  });

  it('walidacja planu: uklad, elementy i zgody; reszta ladunku przepada', () => {
    const ok = parseZipPlanRequest({
      tool: 'codex',
      itemIds: ['a'],
      confirmedItemIds: ['a'],
      path: '/etc/passwd',
      fileName: 'x.zip',
    });
    expect(ok).toEqual({
      ok: true,
      value: { tool: 'codex', itemIds: ['a'], confirmedItemIds: ['a'] },
    });
    expect(parseZipPlanRequest({ tool: 'codex', itemIds: ['a'] })).toEqual({
      ok: true,
      value: { tool: 'codex', itemIds: ['a'] },
    });
    for (const payload of [
      undefined,
      null,
      {},
      { tool: 'zip', itemIds: ['a'] },
      { tool: 'codex', itemIds: [] },
      { tool: 'codex', itemIds: ['a'], confirmedItemIds: 'a' },
      { tool: 'codex', itemIds: ['a'], confirmedItemIds: [1] },
      { tool: 'codex', itemIds: ['a'], confirmedItemIds: ['a'.repeat(129)] },
      { tool: 'codex', itemIds: ['a'], confirmedItemIds: Array.from({ length: 501 }, () => 'a') },
    ]) {
      expect(parseZipPlanRequest(payload).ok).toBe(false);
    }
  });

  it('walidacja zapisu: tylko planId i jawne zatwierdzenie, bez sciezki', () => {
    expect(parseZipSaveRequest({ planId: 'p', approved: true, path: '/tmp/x.zip' })).toEqual({
      ok: true,
      value: { planId: 'p', approved: true },
    });
    for (const payload of [
      undefined,
      {},
      { planId: 'p' },
      { planId: 'p', approved: false },
      { planId: '', approved: true },
      { planId: 'a'.repeat(129), approved: true },
    ]) {
      expect(parseZipSaveRequest(payload).ok).toBe(false);
    }
  });

  it('plan: element prywatny czeka na zgode, ze zgoda archiwum jest do zapisu, a DTO nie niesie sciezek', async () => {
    const { h, call } = await zipWire();
    const first = await call<ExportZipPlanDto>('export:zip-plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
    });
    if (!first.ok) throw new Error('brak planu');
    expect(first.value.applicable).toBe(false);
    expect(first.value.toolMissing).toBe(false);
    expect(first.value.zip.held).toMatchObject([
      { itemId: h.itemId, slug: 'acme-review', reason: 'private', confirmed: false },
    ]);

    const second = await call<ExportZipPlanDto>('export:zip-plan', {
      tool: 'claude-code',
      itemIds: [h.itemId],
      confirmedItemIds: [h.itemId],
    });
    if (!second.ok) throw new Error('brak planu');
    expect(second.value.applicable).toBe(true);
    expect(second.value.zip).toMatchObject({ fileCount: 2, held: [{ confirmed: true }] });
    expect(second.value.zip.fileName).toMatch(/^cwm-export-claude-code-\d{8}-\d{6}\.zip$/);
    expect(second.value.entries[0]).toMatchObject({
      rootLabel: '~/.claude/skills',
      relPath: 'acme-review/SKILL.md',
      action: 'create',
      recoverability: 'recoverable',
    });
    const json = JSON.stringify(second.value);
    expect(json).not.toContain('rootId');
    expect(json).not.toContain('r-claude');
  });

  it('zapis przekazuje portowi sam planId, a odpowiedz idzie bez zmian', async () => {
    const { call, save } = await zipWire();
    const result = await call('export:zip-save', {
      planId: 'zip-plan-1',
      approved: true,
      path: '/tmp/x.zip',
      bytes: [1, 2, 3],
    });
    expect(result).toEqual({ ok: true, value: { status: 'cancelled' } });
    expect(save).toHaveBeenCalledWith('zip-plan-1');
    expect(save.mock.calls[0]).toHaveLength(1);
  });

  it('blad nieoczekiwany w planie jest logowany, a klient dostaje ogolny komunikat', async () => {
    const logged: unknown[] = [];
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const registry = new IpcRegistry({
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    });
    registerExportHandlers(registry, {
      service: () => null,
      zip: () => ({
        plan: () => Promise.reject(new Error('/home/acme/.claude zepsute')),
        save: () => Promise.reject(new Error('x')),
      }),
      logUnexpected: (e) => logged.push(e),
    });
    const result = (await handlers.get('export:zip-plan')?.(
      {},
      { tool: 'codex', itemIds: ['x'] },
    )) as Result;
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('/home');
    expect(logged).toHaveLength(1);
  });
});
