import { describe, expect, it } from 'vitest';

import { registerExportHandlers } from '../../src/main/ipc/handlers/export';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { ExportService } from '../../src/core/services/export/export-service';
import { IMPLEMENTED_CHANNELS, IPC_CHANNELS } from '../../src/shared/ipc/channels';
import type { ExportApplyDto, ExportPlanDto } from '../../src/shared/ipc/export-contract';
import type { Result } from '../../src/shared/ipc/library-contract';
import { root } from './import-fakes';
import { bytes } from './library-fakes';
import { emptyPlan, entry, exportHarness } from './export-fakes';

function wire(service: ExportService | null) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const registry = new IpcRegistry({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });
  const logged: unknown[] = [];
  registerExportHandlers(registry, {
    service: () => service,
    logUnexpected: (e) => logged.push(e),
  });
  const call = async <T = unknown>(channel: string, payload?: unknown): Promise<Result<T>> =>
    (await handlers.get(channel)?.({}, payload)) as Result<T>;
  return { call, registry, logged };
}

const SECRET_BODY = 'TRESC-NIE-DLA-LOGU';

describe('kanaly export:*', () => {
  it('oba kanaly sa na liscie i zaimplementowane, rejestr ma dokladnie dwa', () => {
    for (const channel of ['export:plan', 'export:apply'] as const) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IMPLEMENTED_CHANNELS).toContain(channel);
    }
    expect(wire(null).registry.list()).toEqual(['export:apply', 'export:plan']);
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
