import { describe, expect, it } from 'vitest';

import { ImportError, ImportService } from '../../src/core/services/import/import-service';
import { LibraryService } from '../../src/core/services/library/library-service';
import { FakeAdapter, candidate, importHarness, root } from './import-fakes';

const claude = root('r-claude', 'claude-code');
const codexMain = root('r-codex', 'codex');
const codexAgents = root('r-agents', 'codex', { label: '~/.agents/skills' });

function setup(byRoot: Record<string, ReturnType<typeof candidate>[]>, roots = [claude]) {
  const adapters = [
    new FakeAdapter('claude-code', ['skills'], byRoot),
    new FakeAdapter('codex', ['skills'], byRoot),
  ];
  return { adapters, ...importHarness(roots, adapters) };
}

function byId(report: Awaited<ReturnType<ReturnType<typeof setup>['service']['scan']>>) {
  return new Map(report.candidates.map((c) => [c.candidate.draft.identity.slug, c]));
}

describe('ImportService.scan: statusy i domyslny wybor', () => {
  it('nowy kandydat jest zaznaczony, a relPath i etykieta pochodza z roota', async () => {
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-review', root: claude })] });
    const report = await h.service.scan(['r-claude']);
    const [only] = report.candidates;
    expect(only?.status).toBe('new');
    expect(only?.selectedByDefault).toBe(true);
    expect(only?.rootLabel).toBe('~/.claude/skills');
    expect(only?.candidateId).toBe('cand-1');
    expect(report.scanToken).toBe('token-1');
  });

  it('rozpoznaje unchanged, changed i conflict wzgledem biblioteki', async () => {
    const h = setup({
      'r-claude': [
        candidate({ slug: 'acme-same', root: claude }),
        candidate({ slug: 'acme-diff', root: claude, body: 'inna tresc\n' }),
        candidate({ slug: 'Acme-Case', root: claude }),
        candidate({ slug: 'acme-fresh', root: claude }),
      ],
    });
    await h.library.create(candidate({ slug: 'acme-same', root: claude }).draft);
    await h.library.create(candidate({ slug: 'acme-diff', root: claude }).draft);
    const caseItem = await h.library.create(candidate({ slug: 'acme-case', root: claude }).draft);

    const report = await h.service.scan(['r-claude']);
    const map = byId(report);
    expect(map.get('acme-same')?.status).toBe('unchanged');
    expect(map.get('acme-diff')?.status).toBe('changed');
    expect(map.get('Acme-Case')?.status).toBe('conflict');
    expect(map.get('Acme-Case')?.existingItemId).toBe(caseItem.item.id);
    expect(map.get('acme-fresh')?.status).toBe('new');

    expect(map.get('acme-same')?.selectedByDefault).toBe(false);
    expect(map.get('Acme-Case')?.selectedByDefault).toBe(false);
    expect(map.get('acme-diff')?.selectedByDefault).toBe(true);
    expect(map.get('acme-fresh')?.selectedByDefault).toBe(true);
  });

  it('unchanged ignoruje konce linii, a changed widzi zmiane metadanych', async () => {
    const h = setup({
      'r-claude': [
        candidate({ slug: 'acme-crlf', root: claude, body: 'a\r\nb\r\n' }),
        candidate({ slug: 'acme-title', root: claude, title: 'Nowy tytul' }),
      ],
    });
    await h.library.create(candidate({ slug: 'acme-crlf', root: claude, body: 'a\nb\n' }).draft);
    await h.library.create(candidate({ slug: 'acme-title', root: claude }).draft);
    const map = byId(await h.service.scan(['r-claude']));
    expect(map.get('acme-crlf')?.status).toBe('unchanged');
    expect(map.get('acme-title')?.status).toBe('changed');
  });

  it('alias tego samego pliku jest duplikatem, a zrodlem pierwszy kandydat', async () => {
    const h = setup({
      'r-claude': [
        candidate({ slug: 'acme-a', root: claude, aliasKey: '1:42' }),
        candidate({
          slug: 'acme-b',
          root: claude,
          aliasKey: '1:42',
          body: '# acme-a\n\nTresc skilla acme-a.\n',
        }),
      ],
    });
    const report = await h.service.scan(['r-claude']);
    const [first, second] = report.candidates;
    expect(first?.status).toBe('new');
    expect(second?.status).toBe('duplicate');
    expect(second?.duplicateOf).toBe(first?.candidateId);
    expect(second?.selectedByDefault).toBe(false);
  });

  it('ten sam slug w dwoch rootach Codeksa: duplikat wskazuje aktywny root (ADR 0024)', async () => {
    const h = setup(
      {
        'r-codex': [candidate({ slug: 'acme-dup', root: codexMain })],
        'r-agents': [candidate({ slug: 'acme-dup', root: codexAgents })],
      },
      [codexMain, codexAgents],
    );
    // Kolejnosc rootIds z renderera nie wplywa na pierwszenstwo: liczy sie kolejnosc wykrywania.
    const report = await h.service.scan(['r-agents', 'r-codex']);
    const map = report.candidates;
    const primary = map.find((c) => c.rootLabel === '~/.codex/skills');
    const dup = map.find((c) => c.rootLabel === '~/.agents/skills');
    expect(primary?.status).toBe('new');
    expect(dup?.status).toBe('duplicate');
    expect(dup?.duplicateOf).toBe(primary?.candidateId);
  });

  describe('kolizja w obrebie skanu miedzy narzedziami', () => {
    const both = [claude, codexMain];

    it('ta sama tresc: glowny new, drugi duplicate bez zaznaczenia', async () => {
      const h = setup(
        {
          'r-claude': [candidate({ slug: 'acme-shared', root: claude })],
          'r-codex': [candidate({ slug: 'acme-shared', root: codexMain })],
        },
        both,
      );
      const report = await h.service.scan(['r-codex', 'r-claude']);
      expect(report.candidates.map((c) => c.status)).toEqual(['new', 'duplicate']);
      expect(report.candidates[1]?.duplicateOf).toBe(report.candidates[0]?.candidateId);
      expect(report.candidates[1]?.selectedByDefault).toBe(false);
    });

    it('apply glownego scala snapshoty obu narzedzi w jeden element', async () => {
      const h = setup(
        {
          'r-claude': [candidate({ slug: 'acme-shared', root: claude })],
          'r-codex': [candidate({ slug: 'acme-shared', root: codexMain })],
        },
        both,
      );
      const scan = await h.service.scan(['r-claude', 'r-codex']);
      const report = await h.service.apply({
        scanToken: scan.scanToken,
        candidateIds: ['cand-1', 'cand-2'],
      });
      expect(report.imported).toHaveLength(1);
      expect(report.skipped).toEqual([{ candidateId: 'cand-2', reason: 'duplicate' }]);
      const { items } = await h.library.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.source.snapshots.map((x) => x.tool).sort()).toEqual([
        'claude-code',
        'codex',
      ]);
    });

    it('duplikat z sekretem nie dolacza snapshotu', async () => {
      const h = setup(
        {
          'r-claude': [candidate({ slug: 'acme-shared', root: claude })],
          'r-codex': [
            candidate({
              slug: 'acme-shared',
              root: codexMain,
              sourceFiles: [{ relPath: 'auth.json', text: '{}' }],
            }),
          ],
        },
        both,
      );
      const scan = await h.service.scan(['r-claude', 'r-codex']);
      await h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] });
      const [item] = (await h.library.list()).items;
      expect(item?.source.snapshots.map((x) => x.tool)).toEqual(['claude-code']);
    });

    it('inna tresc: glowny new i importowalny, drugi conflict z duplicateOf', async () => {
      const h = setup(
        {
          'r-claude': [candidate({ slug: 'acme-shared', root: claude })],
          'r-codex': [candidate({ slug: 'acme-shared', root: codexMain, body: 'inna\n' })],
        },
        both,
      );
      const scan = await h.service.scan(['r-claude', 'r-codex']);
      const [main, other] = scan.candidates;
      expect(main?.status).toBe('new');
      expect(main?.selectedByDefault).toBe(true);
      expect(other).toMatchObject({
        status: 'conflict',
        existingItemId: null,
        duplicateOf: main?.candidateId,
        selectedByDefault: false,
      });
      const report = await h.service.apply({
        scanToken: scan.scanToken,
        candidateIds: ['cand-1', 'cand-2'],
      });
      expect(report.imported).toHaveLength(1);
      expect(report.skipped).toEqual([{ candidateId: 'cand-2', reason: 'conflict' }]);
    });

    it('inna wielkosc liter sluga to conflict nawet przy tej samej tresci', async () => {
      const body = 'wspolna\n';
      const h = setup(
        {
          'r-claude': [candidate({ slug: 'acme-shared', root: claude, body })],
          'r-codex': [candidate({ slug: 'Acme-Shared', root: codexMain, body })],
        },
        both,
      );
      const scan = await h.service.scan(['r-claude', 'r-codex']);
      expect(scan.candidates.map((c) => c.status)).toEqual(['new', 'conflict']);
    });

    it('drugi skan po imporcie: unchanged i duplicate/conflict, bez nowych elementow', async () => {
      const h = setup(
        {
          'r-claude': [
            candidate({ slug: 'acme-same', root: claude }),
            candidate({ slug: 'acme-diff', root: claude }),
          ],
          'r-codex': [
            candidate({ slug: 'acme-same', root: codexMain }),
            candidate({ slug: 'acme-diff', root: codexMain, body: 'inna\n' }),
          ],
        },
        both,
      );
      const first = await h.service.scan(['r-claude', 'r-codex']);
      await h.service.apply({
        scanToken: first.scanToken,
        candidateIds: first.candidates.filter((c) => c.selectedByDefault).map((c) => c.candidateId),
      });
      const count = (await h.library.list()).items.length;
      expect(count).toBe(2);

      const second = await h.service.scan(['r-claude', 'r-codex']);
      expect(second.candidates.map((c) => c.status)).toEqual([
        'unchanged',
        'unchanged',
        'duplicate',
        'conflict',
      ]);
      expect(second.candidates.some((c) => c.selectedByDefault)).toBe(false);
      expect((await h.library.list()).items).toHaveLength(count);
    });
  });

  it('nieistniejacy root, brak adaptera i awaria adaptera trafiaja do skipped', async () => {
    const missing = root('r-missing', 'claude-code', { exists: false, active: false });
    const hooks = root('r-hooks', 'claude-code', {
      kind: 'hooks',
      label: '~/.claude/settings.json',
    });
    const broken = root('r-broken', 'codex');
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-ok', root: claude })] }, [
      claude,
      missing,
      hooks,
      broken,
    ]);
    h.adapters[1]?.failOn.add('r-broken');
    const report = await h.service.scan(['r-claude', 'r-missing', 'r-hooks', 'r-broken']);
    expect(report.candidates).toHaveLength(1);
    expect(report.skipped.map((s) => s.reason).sort()).toEqual([
      'unreadable',
      'unreadable',
      'unsupported',
    ]);
    // Komunikat nie niesie tekstu bledu adaptera (moglaby byc w nim sciezka).
    expect(JSON.stringify(report.skipped)).not.toContain('/abs/sciezka');
  });

  it('odrzuca nieznany rootId', async () => {
    const h = setup({});
    await expect(h.service.scan(['r-nieznany'])).rejects.toBeInstanceOf(ImportError);
  });

  it('przekazuje skipped adaptera z etykieta roota', async () => {
    const adapter = new FakeAdapter(
      'claude-code',
      ['skills'],
      {},
      {
        'r-claude': [
          {
            tool: 'claude-code',
            rootId: 'r-claude',
            relPath: 'acme-link',
            reason: 'symlink-outside',
            message: 'Dowiazanie wychodzi poza lokalizacje.',
          },
        ],
      },
    );
    const h = importHarness([claude], [adapter]);
    const report = await h.service.scan(['r-claude']);
    expect(report.skipped[0]).toMatchObject({
      rootLabel: '~/.claude/skills',
      relPath: 'acme-link',
    });
  });
});

describe('ImportService.scan: sekrety', () => {
  const secretFile = [{ relPath: 'auth.json', text: '{}\n' }];

  it('kandydat z sekretem ma trafienia i jest odznaczony', async () => {
    const h = setup({
      'r-claude': [
        candidate({
          slug: 'acme-secret',
          root: claude,
          assets: secretFile,
        }),
      ],
    });
    const [c] = (await h.service.scan(['r-claude'])).candidates;
    expect(c?.secrets.map((s) => s.rule)).toEqual(['file-name']);
    expect(c?.status).toBe('new');
    expect(c?.selectedByDefault).toBe(false);
  });

  it('skill mowiacy o tokenach nie jest oznaczony', async () => {
    const body = '# Tokeny\n\nUzyj access token i nie wpisuj hasla do repozytorium.\n';
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-tokens', root: claude, body })] });
    const [c] = (await h.service.scan(['r-claude'])).candidates;
    expect(c?.secrets).toEqual([]);
    expect(c?.selectedByDefault).toBe(true);
  });
});

describe('ImportService.apply', () => {
  it('tworzy nowe elementy z pochodzeniem bez sciezki bezwzglednej', async () => {
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-new', root: claude })] });
    const scan = await h.service.scan(['r-claude']);
    const report = await h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] });
    expect(report.imported).toHaveLength(1);
    expect(report.imported[0]?.action).toBe('created');

    const { items } = await h.library.list();
    const origin = items[0]?.source.importedFrom;
    expect(origin).toMatchObject({
      tool: 'claude-code',
      rootId: 'r-claude',
      path: 'acme-new/SKILL.md',
    });
    expect(origin?.at).toBe(h.clock.now().toISOString());
    expect(items[0]?.classification.scope).toBe('private');
  });

  it('powtorny import tego samego drzewa nie tworzy duplikatow', async () => {
    const h = setup({
      'r-claude': [
        candidate({ slug: 'acme-one', root: claude }),
        candidate({
          slug: 'acme-two',
          root: claude,
          assets: [{ relPath: 'ref/a.txt', text: 'x' }],
        }),
      ],
    });
    const first = await h.service.scan(['r-claude']);
    await h.service.apply({ scanToken: first.scanToken, candidateIds: ['cand-1', 'cand-2'] });

    const second = await h.service.scan(['r-claude']);
    expect(second.candidates.map((c) => c.status)).toEqual(['unchanged', 'unchanged']);
    expect(second.candidates.every((c) => !c.selectedByDefault)).toBe(true);

    const again = await h.service.apply({
      scanToken: second.scanToken,
      candidateIds: ['cand-1', 'cand-2'],
    });
    expect(again.imported).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['unchanged', 'unchanged']);
    expect((await h.library.list()).items).toHaveLength(2);
  });

  it('changed wymaga replaceChanged; wtedy robi update z nowa rewizja', async () => {
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-diff', root: claude, body: 'v2\n' })] });
    const existing = await h.library.create(
      candidate({ slug: 'acme-diff', root: claude, body: 'v1\n' }).draft,
    );
    const scan = await h.service.scan(['r-claude']);

    const skipped = await h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] });
    expect(skipped.skipped).toEqual([{ candidateId: 'cand-1', reason: 'changed-not-replaced' }]);
    expect((await h.library.get(existing.item.id)).item.version.revision).toBe(1);

    const replaced = await h.service.apply({
      scanToken: scan.scanToken,
      candidateIds: ['cand-1'],
      replaceChanged: ['cand-1'],
    });
    expect(replaced.imported).toEqual([
      { candidateId: 'cand-1', itemId: existing.item.id, action: 'updated' },
    ]);
    const after = (await h.library.get(existing.item.id)).item;
    expect(after.version.revision).toBe(2);
    expect(after.content.body).toBe('v2\n');
  });

  it('element z sekretem wymaga confirmedSecrets i zapisuje tylko miejsce trafienia', async () => {
    const secretText = `api_key: ${'Zq8'.repeat(8)}1\n`;
    const h = setup({
      'r-claude': [
        candidate({
          slug: 'acme-secret',
          root: claude,
          assets: [{ relPath: 'conf.txt', text: secretText }],
        }),
      ],
    });
    const scan = await h.service.scan(['r-claude']);
    expect(scan.candidates[0]?.secrets.length).toBeGreaterThan(0);

    const blocked = await h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] });
    expect(blocked.skipped).toEqual([{ candidateId: 'cand-1', reason: 'secrets-not-confirmed' }]);
    expect((await h.library.list()).items).toHaveLength(0);

    const confirmed = await h.service.apply({
      scanToken: scan.scanToken,
      candidateIds: ['cand-1'],
      confirmedSecrets: ['cand-1'],
    });
    expect(confirmed.imported).toHaveLength(1);
    const [item] = (await h.library.list()).items;
    expect(item?.classification.secretFindings).toEqual([
      { rule: 'key-name', relPath: 'conf.txt', line: 1 },
    ]);
  });

  it('duplikat i konflikt sa pomijane nawet po jawnym wyborze', async () => {
    const h = setup({
      'r-claude': [
        candidate({ slug: 'acme-a', root: claude, aliasKey: 'k' }),
        candidate({ slug: 'acme-b', root: claude, aliasKey: 'k' }),
        candidate({ slug: 'ACME-A', root: claude }),
      ],
    });
    const scan = await h.service.scan(['r-claude']);
    const report = await h.service.apply({
      scanToken: scan.scanToken,
      candidateIds: ['cand-2', 'cand-3', 'cand-nie-ma'],
    });
    expect(report.skipped.map((s) => s.reason)).toEqual([
      'duplicate',
      'conflict',
      'unknown-candidate',
    ]);
    expect(report.imported).toEqual([]);
  });

  it('blad jednego elementu nie przerywa reszty', async () => {
    const h = setup({
      'r-claude': [
        candidate({ slug: 'acme-first', root: claude }),
        candidate({ slug: 'Zly Slug!', root: claude }),
        candidate({ slug: 'acme-last', root: claude }),
      ],
    });
    const scan = await h.service.scan(['r-claude']);
    const report = await h.service.apply({
      scanToken: scan.scanToken,
      candidateIds: ['cand-1', 'cand-2', 'cand-3'],
    });
    expect(report.imported.map((i) => i.candidateId)).toEqual(['cand-1', 'cand-3']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.candidateId).toBe('cand-2');
    expect(report.failed[0]?.code).toBe('slug-invalid');
  });

  it('nieoczekiwany wyjatek daje ogolny komunikat bez tresci bledu i idzie do logu', async () => {
    const logged: unknown[] = [];
    const adapter = new FakeAdapter('claude-code', ['skills'], {
      'r-claude': [
        candidate({ slug: 'acme-boom', root: claude }),
        candidate({ slug: 'acme-fine', root: claude }),
      ],
    });
    const base = importHarness([claude], [adapter]);
    let calls = 0;
    const library = {
      list: () => base.library.list(),
      update: (...args: Parameters<LibraryService['update']>) => base.library.update(...args),
      create: (...args: Parameters<LibraryService['create']>) => {
        calls++;
        if (calls === 1) return Promise.reject(new TypeError('/Users/ktos/sekret nie otwiera sie'));
        return base.library.create(...args);
      },
    };
    const service = new ImportService({
      catalog: base.catalog,
      adapters: [adapter],
      reader: base.reader,
      library,
      clock: base.clock,
      onUnexpected: (e: unknown) => logged.push(e),
    });
    const scan = await service.scan(['r-claude']);
    const report = await service.apply({
      scanToken: scan.scanToken,
      candidateIds: ['cand-1', 'cand-2'],
    });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.code).toBe('internal');
    expect(JSON.stringify(report.failed)).not.toContain('/Users');
    expect(logged).toHaveLength(1);
    expect(report.imported).toHaveLength(1);
  });

  it('odrzuca nieznany i wygasly token skanu', async () => {
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-new', root: claude })] });
    await expect(h.service.apply({ scanToken: 'nie-ma', candidateIds: [] })).rejects.toMatchObject({
      code: 'unknown-scan',
    });
    const scan = await h.service.scan(['r-claude']);
    h.clock.advance(31 * 60 * 1000);
    await expect(
      h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] }),
    ).rejects.toMatchObject({ code: 'unknown-scan' });
  });

  it('zuzyty kandydat nie wchodzi drugi raz w tym samym skanie', async () => {
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-once', root: claude })] });
    const scan = await h.service.scan(['r-claude']);
    await h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] });
    const again = await h.service.apply({ scanToken: scan.scanToken, candidateIds: ['cand-1'] });
    expect(again.skipped).toEqual([{ candidateId: 'cand-1', reason: 'unknown-candidate' }]);
    expect((await h.library.list()).items).toHaveLength(1);
  });

  it('trzyma ograniczona liczbe skanow naraz', async () => {
    const h = setup({ 'r-claude': [candidate({ slug: 'acme-new', root: claude })] });
    const first = await h.service.scan(['r-claude']);
    for (let i = 0; i < 8; i++) await h.service.scan(['r-claude']);
    await expect(
      h.service.apply({ scanToken: first.scanToken, candidateIds: [] }),
    ).rejects.toBeInstanceOf(ImportError);
  });
});
