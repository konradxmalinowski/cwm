import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_CHANNELS, IPC_CHANNELS } from '../../src/shared/ipc/channels';
import { registerImportHandlers } from '../../src/main/ipc/handlers/import';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { ImportService } from '../../src/core/services/import/import-service';
import type { ImportApplyDto, ImportScanDto } from '../../src/shared/ipc/import-contract';
import type { Result } from '../../src/shared/ipc/library-contract';
import {
  FakeAdapter,
  FakeGitProvider,
  GIT_COMMIT,
  candidate,
  importHarness,
  root,
} from './import-fakes';

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
  it('import:plan zniknal z listy, a cztery pozostale sa zaimplementowane', () => {
    expect(IPC_CHANNELS).not.toContain('import:plan' as never);
    for (const channel of [
      'import:detect',
      'import:scan',
      'import:scan-git',
      'import:apply',
    ] as const) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IMPLEMENTED_CHANNELS).toContain(channel);
    }
  });

  it('rejestruje dokladnie cztery kanaly', () => {
    expect(wire(null).registry.list()).toEqual([
      'import:apply',
      'import:detect',
      'import:scan',
      'import:scan-git',
    ]);
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
      { scanToken: 't', candidateIds: ['cand-1'], renames: 'acme-b' },
      { scanToken: 't', candidateIds: ['cand-1'], renames: ['acme-b'] },
      { scanToken: 't', candidateIds: ['cand-1'], renames: { 'cand-1': 5 } },
      { scanToken: 't', candidateIds: ['cand-1'], renames: { 'cand-2': 'acme-b' } },
    ]) {
      expect(await call('import:apply', payload)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      });
    }
  });

  it('apply z renames: konflikt wchodzi pod nowym slugiem, zla nazwa wraca jako failed', async () => {
    const adapter = new FakeAdapter('claude-code', ['skills'], {
      'r-claude': [candidate({ slug: 'Acme-Review', root: claude })],
    });
    const h = importHarness([claude], [adapter]);
    await h.library.create(candidate({ slug: 'acme-review', root: claude }).draft);
    const { call } = wire(h.service);

    const scan = await call<ImportScanDto>('import:scan', { rootIds: ['r-claude'] });
    if (!scan.ok) throw new Error('skan nie powiodl sie');
    expect(scan.value.candidates[0]?.status).toBe('conflict');
    expect(scan.value.librarySlugs).toEqual([{ kind: 'skill', slug: 'acme-review' }]);

    const bad = await call<ImportApplyDto>('import:apply', {
      scanToken: scan.value.scanToken,
      candidateIds: ['cand-1'],
      renames: { 'cand-1': 'ACME-REVIEW' },
    });
    if (!bad.ok) throw new Error('apply nie powiodl sie');
    expect(bad.value.imported).toEqual([]);
    expect(bad.value.failed).toMatchObject([{ candidateId: 'cand-1', code: 'slug-collision' }]);

    const good = await call<ImportApplyDto>('import:apply', {
      scanToken: scan.value.scanToken,
      candidateIds: ['cand-1'],
      renames: { 'cand-1': 'acme-review-2' },
    });
    if (!good.ok) throw new Error('apply nie powiodl sie');
    expect(good.value.imported).toHaveLength(1);
    const slugs = (await h.library.list()).items.map((i) => i.identity.slug).sort();
    expect(slugs).toEqual(['acme-review', 'acme-review-2']);
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
      ['import:scan-git', { url: 'https://example.com/acme/skills.git' }],
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

describe('kanal import:scan-git (ADR 0058)', () => {
  const URL = 'https://example.com/acme/skills.git';
  const gitRoot = root('git-root-1', 'claude-code', { label: 'skills' });

  function gitHarness() {
    const git = new FakeGitProvider([gitRoot]);
    const adapter = new FakeAdapter('claude-code', ['skills'], {
      'git-root-1': [candidate({ slug: 'acme-review', root: gitRoot, body: 'TRESC\n' })],
    });
    return { git, ...importHarness([], [adapter], { git }) };
  }

  it('zwraca skan z polem git i bez sciezek, tokenem do apply', async () => {
    const h = gitHarness();
    const { call } = wire(h.service);
    const scan = await call<ImportScanDto>('import:scan-git', { url: URL, ref: ' main ' });
    if (!scan.ok) throw new Error('skan nie powiodl sie');
    expect(scan.value.git).toEqual({ url: URL, ref: 'main', commit: GIT_COMMIT, submodules: 0 });
    expect(scan.value.candidates[0]).toMatchObject({ slug: 'acme-review', rootLabel: 'skills' });
    expect(JSON.stringify(scan.value)).not.toContain('git-root');
    expect(h.git.requests).toEqual([{ url: URL, ref: 'main' }]);
    expect(h.git.released).toBe(1);

    const apply = await call<ImportApplyDto>('import:apply', {
      scanToken: scan.value.scanToken,
      candidateIds: ['cand-1'],
    });
    expect(apply.ok && apply.value.imported.length).toBe(1);
  });

  it('puste pole ref to HEAD, a skan lokalizacji nie ma pola git', async () => {
    const h = gitHarness();
    const { call } = wire(h.service);
    await call('import:scan-git', { url: URL, ref: '  ' });
    expect(h.git.requests).toEqual([{ url: URL, ref: null }]);
  });

  it('odrzuca adresy i refy, ktorych aplikacja nie pobiera, bez dotykania portu i bez echa adresu', async () => {
    const h = gitHarness();
    const { call } = wire(h.service);
    const secret = 'haslo-nie-do-echa';
    const urls = [
      'ssh://git@example.com/acme/skills.git',
      'git@example.com:acme/skills.git',
      'git://example.com/acme/skills.git',
      'file:///srv/acme/skills.git',
      'ext::sh -c id',
      '/srv/acme/skills.git',
      'http://example.com/acme/skills.git',
      'http://127.0.0.1:8080/acme/skills.git',
      `https://acme:${secret}@example.com/acme/skills.git`,
      'https://acme@example.com/acme/skills.git',
      'https://example.com/acme/skills.git?token=x',
      'https://example.com/acme/skills.git#main',
      'https://example.com/',
      'https://example.com',
      'https://EXAMPLE.com/acme/skills.git',
      'https://example.com/acme/skills .git',
      '',
      `https://example.com/${'a'.repeat(2048)}`,
    ];
    for (const url of urls) {
      const result = await call('import:scan-git', { url });
      expect(result, url).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
      expect(JSON.stringify(result), url).not.toContain(secret);
    }
    for (const ref of [
      '-x',
      '--upload-pack=sh',
      'a..b',
      'abc1234',
      'main lock',
      'a'.repeat(129),
      5,
    ]) {
      expect(await call('import:scan-git', { url: URL, ref }), String(ref)).toMatchObject({
        ok: false,
        error: { code: 'invalid-request' },
      });
    }
    for (const payload of [undefined, null, 'x', [], {}, { url: 5 }]) {
      expect((await call('import:scan-git', payload)).ok, JSON.stringify(payload)).toBe(false);
    }
    expect(h.git.requests).toEqual([]);
  });

  it('pelny SHA jako ref przechodzi', async () => {
    const h = gitHarness();
    const { call } = wire(h.service);
    const sha = 'b'.repeat(40);
    expect((await call('import:scan-git', { url: URL, ref: sha })).ok).toBe(true);
    expect(h.git.requests[0]?.ref).toBe(sha);
  });

  it('odmowa portu wraca jako Result z kodem i komunikatem, bez wyjatku', async () => {
    const h = gitHarness();
    h.git.failure = { ok: false, code: 'git-unavailable', message: 'Brak git w PATH.' };
    const { call, logged } = wire(h.service);
    expect(await call('import:scan-git', { url: URL })).toEqual({
      ok: false,
      error: { code: 'git-unavailable', message: 'Brak git w PATH.' },
    });
    expect(logged).toEqual([]);
  });

  it('nieoczekiwany wyjatek skanu daje ogolny komunikat bez sciezki', async () => {
    const h = gitHarness();
    h.git.open = () => Promise.reject(new Error('EACCES /srv/acme/git-import'));
    const { call, logged } = wire(h.service);
    const result = await call('import:scan-git', { url: URL });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('/srv/acme');
    expect(logged).toHaveLength(1);
  });
});
