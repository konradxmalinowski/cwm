import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_CHANNELS, IPC_CHANNELS } from '../../src/shared/ipc/channels';
import { registerImportHandlers } from '../../src/main/ipc/handlers/import';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { ImportService } from '../../src/core/services/import/import-service';
import type { ImportApplyDto, ImportScanDto } from '../../src/shared/ipc/import-contract';
import type { Result } from '../../src/shared/ipc/library-contract';
import { FakeAdapter, candidate, importHarness, root } from './import-fakes';

const claude = root('r-claude', 'claude-code');

function wire(service: ImportService | null) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const registry = new IpcRegistry({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });
  const logged: unknown[] = [];
  registerImportHandlers(registry, {
    service: () => service,
    logUnexpected: (e) => logged.push(e),
  });
  const call = async <T = unknown>(channel: string, payload?: unknown): Promise<Result<T>> =>
    (await handlers.get(channel)?.({}, payload)) as Result<T>;
  return { call, registry, logged };
}

function harness() {
  const adapter = new FakeAdapter('claude-code', ['skills'], {
    'r-claude': [
      candidate({ slug: 'acme-review', root: claude, body: 'TRESC-NIE-DLA-RENDERERA\n' }),
    ],
  });
  return importHarness([claude], [adapter]);
}

describe('kanaly import:*', () => {
  it('import:plan zniknal z listy, a trzy pozostale sa zaimplementowane', () => {
    expect(IPC_CHANNELS).not.toContain('import:plan' as never);
    for (const channel of ['import:detect', 'import:scan', 'import:apply'] as const) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IMPLEMENTED_CHANNELS).toContain(channel);
    }
  });

  it('rejestruje dokladnie trzy kanaly', () => {
    expect(wire(null).registry.list()).toEqual(['import:apply', 'import:detect', 'import:scan']);
  });

  it('detect zwraca rooty bez sciezki, scan i apply przechodza caly przeplyw', async () => {
    const { call } = wire(harness().service);
    const detect = await call('import:detect');
    expect(detect).toEqual({
      ok: true,
      value: {
        roots: [
          {
            rootId: 'r-claude',
            tool: 'claude-code',
            kind: 'skills',
            label: '~/.claude/skills',
            exists: true,
            active: true,
          },
        ],
      },
    });

    const scan = await call<ImportScanDto>('import:scan', {
      rootIds: ['r-claude'],
      rozszerzenie: 'ignorowane',
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) throw new Error('skan nie powiodl sie');
    const dto = scan.value;
    expect(dto.candidates[0]).toMatchObject({
      candidateId: 'cand-1',
      status: 'new',
      slug: 'acme-review',
      relPath: 'acme-review/SKILL.md',
      selectedByDefault: true,
    });
    // Renderer nie dostaje tresci ani draftu ani rootId kandydata.
    const json = JSON.stringify(dto);
    expect(json).not.toContain('TRESC-NIE-DLA-RENDERERA');
    expect(dto.candidates[0]).not.toHaveProperty('draft');
    expect(dto.candidates[0]).not.toHaveProperty('rootId');

    const apply = await call<ImportApplyDto>('import:apply', {
      scanToken: dto.scanToken,
      candidateIds: ['cand-1'],
    });
    if (!apply.ok) throw new Error('apply nie powiodl sie');
    expect(apply.value.imported).toHaveLength(1);
    expect(Object.keys(apply.value.imported[0] ?? {}).sort()).toEqual([
      'action',
      'candidateId',
      'itemId',
    ]);
  });

  it('odrzuca zle ladunki kodem invalid-request, bez rzutu', async () => {
    const { call } = wire(harness().service);
    for (const payload of [
      undefined,
      null,
      'x',
      [],
      {},
      { rootIds: [] },
      { rootIds: [1] },
      { rootIds: ['/etc'.repeat(50)] },
    ]) {
      expect((await call('import:scan', payload)).ok, JSON.stringify(payload)).toBe(false);
    }
    const bad = await call('import:scan', { rootIds: 'r-claude' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

    for (const payload of [
      {},
      { scanToken: '', candidateIds: [] },
      { scanToken: 't', candidateIds: 'cand-1' },
      { scanToken: 't', candidateIds: [], confirmedSecrets: [5] },
      { scanToken: 't', candidateIds: [], replaceChanged: 'x' },
    ]) {
      expect(await call('import:apply', payload)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      });
    }
  });

  it('nieznany root i nieznany token to Result z kodem, nie wyjatek', async () => {
    const { call } = wire(harness().service);
    expect(await call('import:scan', { rootIds: ['/home/ktos/.claude'] })).toMatchObject({
      ok: false,
      error: { code: 'unknown-root' },
    });
    expect(await call('import:apply', { scanToken: 'x', candidateIds: [] })).toMatchObject({
      ok: false,
      error: { code: 'unknown-scan' },
    });
  });

  it('bez biblioteki kanaly odpowiadaja import-unavailable', async () => {
    const { call } = wire(null);
    for (const [channel, payload] of [
      ['import:detect', undefined],
      ['import:scan', { rootIds: ['r'] }],
      ['import:apply', { scanToken: 't', candidateIds: [] }],
    ] as const) {
      expect(await call(channel, payload)).toMatchObject({
        ok: false,
        error: { code: 'import-unavailable' },
      });
    }
  });

  it('nieoczekiwany wyjatek daje ogolny komunikat bez sciezki i trafia do logu', async () => {
    const h = harness();
    h.catalog.detect = () => Promise.reject(new Error('EACCES /Users/ktos/.claude'));
    const { call, logged } = wire(h.service);
    const result = await call('import:detect');
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('/Users');
    expect(logged).toHaveLength(1);
  });
});
