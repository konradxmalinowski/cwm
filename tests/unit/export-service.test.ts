import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  ExportError,
  PLAN_TTL_MS,
  materializationFor,
  redactPaths,
} from '../../src/core/services/export/export-service';
import {
  ZIP_MANIFEST_NAME,
  ZIP_MAX_FILES,
  ZipError,
  buildZip,
  checkArchivePath,
  crc32,
} from '../../src/core/services/export/zip-archive';
import {
  ZipExportService,
  type ZipExportDeps,
} from '../../src/core/services/export/zip-export-service';
import { root } from './import-fakes';
import { bytes, dec, draft } from './library-fakes';
import { SECRETS } from './security-secrets';
import { emptyPlan, entry, exportHarness } from './export-fakes';

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ExportError) return error.code;
    throw error;
  }
  return 'brak-bledu';
}

describe('ExportService.plan', () => {
  it('woła eksportera z rootami narzedzia i materializacja z wykrytej zdolnosci', async () => {
    const h = await exportHarness({
      roots: [root('r-claude', 'claude-code'), root('r-codex', 'codex')],
    });
    const report = await h.service.plan('claude-code', [h.itemId]);

    expect(report.toolMissing).toBe(false);
    expect(h.exporter.contexts[0]?.roots.map((r) => r.rootId)).toEqual(['r-claude']);
    expect(h.exporter.contexts[0]?.materialization).toEqual({
      directory: 'junction',
      file: 'symlink',
    });
    expect(h.exporter.seen[0]?.[0]?.item.id).toBe(h.itemId);
    expect(h.gate.probes).toBe(1);
    expect(report.plan.entries).toHaveLength(1);
    expect(report.entryIds).toEqual(['e1']);
    expect(report.plan.planId).toBe('plan-1');
  });

  it('brak katalogu narzedzia: plan toolMissing bez wpisow, bez wołania eksportera i bramki', async () => {
    const h = await exportHarness({ roots: [root('r-claude', 'claude-code', { exists: false })] });
    h.catalog.homes = new Set();
    const report = await h.service.plan('claude-code', [h.itemId]);

    expect(report.toolMissing).toBe(true);
    expect(report.plan.entries).toEqual([]);
    expect(report.plan.applicable).toBe(false);
    expect(h.exporter.contexts).toHaveLength(0);
    expect(h.gate.probes).toBe(0);
    expect(await code(h.service.apply(report.planId, true))).toBe('unknown-plan');
  });

  it('tylko ~/.agents bez katalogu glownego Codeksa: toolMissing, zero wpisow', async () => {
    const agents = root('r-agents', 'codex', { label: '~/.agents/skills' });
    const h = await exportHarness({ roots: [agents], tool: 'codex' });
    h.catalog.homes = new Set(); // ~/.codex nie istnieje
    const report = await h.service.plan('codex', [h.itemId]);

    expect(report.toolMissing).toBe(true);
    expect(report.plan.entries).toEqual([]);
    expect(h.exporter.contexts).toHaveLength(0);
  });

  it('katalog glowny jest: eksport do drugiego roota dziala', async () => {
    const agents = root('r-agents', 'codex', { label: '~/.agents/skills' });
    const h = await exportHarness({ roots: [agents], tool: 'codex' });
    h.catalog.homes = new Set(['codex']);
    const report = await h.service.plan('codex', [h.itemId]);

    expect(report.toolMissing).toBe(false);
    expect(h.exporter.contexts[0]?.roots.map((r) => r.rootId)).toEqual(['r-agents']);
  });

  it('narzedzie bez eksportera i pusty wybor sa odmowione', async () => {
    const h = await exportHarness();
    expect(await code(h.service.plan('codex', [h.itemId]))).toBe('unsupported-tool');
    expect(await code(h.service.plan('claude-code', []))).toBe('no-items');
  });

  it('nieznany element biblioteki konczy sie bledem biblioteki', async () => {
    const h = await exportHarness();
    await expect(h.service.plan('claude-code', ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'])).rejects.toThrow();
  });

  it('dubli w itemIds nie przekazuje dalej', async () => {
    const h = await exportHarness();
    await h.service.plan('claude-code', [h.itemId, h.itemId]);
    expect(h.exporter.seen[0]).toHaveLength(1);
  });
});

describe('ExportService.apply', () => {
  it('bez zatwierdzenia odmawia i nie zuzywa planu', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);

    expect(await code(h.service.apply(planId, false))).toBe('not-approved');
    expect(h.gate.applies).toHaveLength(0);
    const ok = await h.service.apply(planId, true);
    expect(ok.verified).toBe(true);
  });

  it('zatwierdzony plan trafia do bramki z planId i mapuje wpisy na entryId', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const applied = await h.service.apply(planId, true);

    expect(h.gate.applies).toHaveLength(1);
    expect(h.gate.applies[0]?.planId).toBe(planId);
    expect(applied).toMatchObject({
      planId,
      backupId: 'backup-1',
      entries: [{ entryId: 'e1', outcome: 'written', message: null }],
      verified: true,
      rolledBack: false,
    });
  });

  it('plan jest jednorazowy', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    await h.service.apply(planId, true);

    expect(await code(h.service.apply(planId, true))).toBe('unknown-plan');
    expect(h.gate.applies).toHaveLength(1);
  });

  it('plan wygasly jest odmowiony i zuzyty', async () => {
    const h = await exportHarness();
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    h.clock.advance(PLAN_TTL_MS + 1);

    expect(await code(h.service.apply(planId, true))).toBe('plan-expired');
    expect(await code(h.service.apply(planId, true))).toBe('unknown-plan');
    expect(h.gate.applies).toHaveLength(0);
  });

  it('plan nieaplikowalny jest odmowiony bez wolania bramki', async () => {
    const h = await exportHarness({
      build: () => emptyPlan({ entries: [entry()], applicable: false }),
    });
    const { planId } = await h.service.plan('claude-code', [h.itemId]);

    expect(await code(h.service.apply(planId, true))).toBe('plan-not-applicable');
    expect(h.gate.applies).toHaveLength(0);
  });

  it('nieznany planId i plan podany przez renderer nie istnieja', async () => {
    const h = await exportHarness();
    expect(await code(h.service.apply('wymyslony', true))).toBe('unknown-plan');
  });

  it('wyjatek bramki daje raport "failed" z ogolnym komunikatem, bez tresci bledu', async () => {
    const logged: unknown[] = [];
    const h = await exportHarness({ overrides: { onUnexpected: (e) => logged.push(e) } });
    h.gate.apply = () => Promise.reject(new Error('/Users/ktos/.claude/sekret'));
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const applied = await h.service.apply(planId, true);

    expect(applied.entries[0]).toMatchObject({ entryId: 'e1', outcome: 'failed' });
    expect(JSON.stringify(applied)).not.toContain('/Users');
    expect(logged).toHaveLength(1);
  });

  it('komunikat bramki ze sciezka bezwzgledna jest oczyszczony', async () => {
    const h = await exportHarness();
    h.gate.apply = (plan) =>
      Promise.resolve({
        planId: plan.planId,
        backupId: 'b',
        entries: plan.entries.map((e) => ({
          rootId: e.rootId,
          relPath: e.relPath,
          outcome: 'failed' as const,
          message: 'EACCES: /Users/ktos/.claude/skills/x nie do zapisu',
        })),
        verified: false,
        rolledBack: true,
      });
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const applied = await h.service.apply(planId, true);
    expect(applied.entries[0]?.message).not.toContain('/Users');
  });

  it('odmowa bramki przed zapisem wraca jako blad z jej powodem, nie jako nieudany zapis', async () => {
    const h = await exportHarness();
    h.gate.apply = () => {
      const refusal = Object.assign(
        new Error('Plik zmienił się od przygotowania planu: /Users/ktos/.claude/CLAUDE.md'),
        { name: 'WriteGateRefusal', code: 'plan-changed' },
      );
      return Promise.reject(refusal);
    };
    const { planId } = await h.service.plan('claude-code', [h.itemId]);
    const failure = await h.service.apply(planId, true).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'gate-plan-changed' });
    expect((failure as Error).message).toContain('Plik zmienił się od przygotowania planu');
    expect((failure as Error).message).not.toContain('/Users');
  });
});

describe('pomocnicze', () => {
  it('materializationFor wybiera najlepszy tryb albo kopie', () => {
    expect(
      materializationFor({ fileSymlink: true, directorySymlink: true, junction: false }),
    ).toEqual({ directory: 'symlink', file: 'symlink' });
    expect(
      materializationFor({ fileSymlink: false, directorySymlink: false, junction: false }),
    ).toEqual({ directory: 'copy', file: 'copy' });
  });

  it('redactPaths nie rusza sciezek wzglednych', () => {
    expect(redactPaths('plik skills/acme/SKILL.md')).toBe('plik skills/acme/SKILL.md');
    expect(redactPaths('C:\\Users\\x\\a.md blad')).toBe('<sciezka> blad');
  });
});

/** Czytnik ZIP na potrzeby testu: czyta katalog centralny, a nie naglowki lokalne. */
interface ZipRow {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly attrs: number;
  readonly data: Uint8Array;
}

function readZip(zip: Uint8Array): ZipRow[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const rows: ZipRow[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const csize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    const raw = zip.subarray(start, start + csize);
    rows.push({
      name,
      method,
      flags: view.getUint16(at + 8, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      attrs: view.getUint32(at + 38, true),
      data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw,
    });
    at += 46 + nameLen;
  }
  return rows;
}

const ZIP_OPTIONS = {
  appVersion: '1.2.3',
  layout: 'claude-code' as const,
  deflate: (b: Uint8Array) => new Uint8Array(deflateRawSync(b, { level: 9 })),
};

describe('buildZip', () => {
  const files = [
    { path: 'claude-code/.claude/skills/acme-b/SKILL.md', bytes: bytes('# B\n'.repeat(50)) },
    { path: 'claude-code/.claude/skills/acme-a/SKILL.md', bytes: bytes('# A\n') },
    { path: 'claude-code/.claude/skills/zażółć/SKILL.md', bytes: bytes('') },
  ];

  it('jest deterministyczne: ta sama zawartosc w innej kolejnosci daje te same bajty', () => {
    const a = buildZip(files, ZIP_OPTIONS);
    const b = buildZip([...files].reverse(), ZIP_OPTIONS);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.fileCount).toBe(4);
  });

  it('stala kolejnosc wpisow, stala data DOS, nazwy UTF-8, tryby 0644 i 0755, brak dowiazan', () => {
    const rows = readZip(buildZip(files, ZIP_OPTIONS).bytes);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      [...names].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))),
    );
    expect(names).toContain('claude-code/.claude/skills/zażółć/SKILL.md');
    expect(names).toContain('claude-code/.claude/skills/acme-a/');
    for (const row of rows) {
      expect(row.flags & 0x0800).toBe(0x0800);
      expect(row.time).toBe(0);
      expect(row.date).toBe(0x0021);
      const mode = row.attrs >>> 16;
      if (row.name.endsWith('/')) expect(mode).toBe(0o040755);
      else expect(mode).toBe(0o100644);
      expect(mode & 0o170000).not.toBe(0o120000);
      expect(row.crc).toBe(crc32(row.data));
    }
    const big = rows.find((r) => r.name.endsWith('acme-b/SKILL.md'));
    expect(big?.method).toBe(8);
    expect(dec(big?.data ?? new Uint8Array())).toBe('# B\n'.repeat(50));
    expect(rows.find((r) => r.name.endsWith('acme-a/SKILL.md'))?.method).toBe(0);
  });

  it('manifest ma wersje aplikacji, uklad i skroty SHA-256 plikow, bez daty i sciezek bezwzglednych', () => {
    const built = buildZip(files, ZIP_OPTIONS);
    const manifest = JSON.parse(
      dec(readZip(built.bytes).find((r) => r.name === ZIP_MANIFEST_NAME)?.data ?? new Uint8Array()),
    ) as {
      format: string;
      app: { version: string };
      layout: string;
      files: { path: string; size: number; sha256: string }[];
    };
    expect(manifest.format).toBe('cwm-export');
    expect(manifest.app.version).toBe('1.2.3');
    expect(manifest.layout).toBe('claude-code');
    expect(manifest.files.map((f) => f.path)).toEqual(built.files.map((f) => f.path));
    const a = manifest.files.find((f) => f.path.endsWith('acme-a/SKILL.md'));
    expect(a?.size).toBe(4);
    expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('odrzuca sciezki bezwzgledne, z .., z odwroconym ukosnikiem, literami dysku i znakami sterujacymi', () => {
    for (const path of [
      '',
      '/etc/passwd',
      'a/../b',
      '../b',
      'a/./b',
      'a//b',
      'a\\b',
      'C:\\x',
      'C:x',
      'a/',
      'a/b\u0000c',
      'a/b\nc',
      `${'x'.repeat(260)}`,
    ]) {
      expect(checkArchivePath(path), path).not.toBeNull();
      expect(() => buildZip([{ path, bytes: bytes('x') }], ZIP_OPTIONS)).toThrow(ZipError);
    }
    expect(checkArchivePath('claude-code/.claude/CLAUDE.md')).toBeNull();
  });

  it('odrzuca duplikaty, takze roznice samej wielkosci liter, plik pod nazwa katalogu i nazwe manifestu', () => {
    const dup = (a: string, b: string): ZipError | null => {
      try {
        buildZip(
          [
            { path: a, bytes: bytes('1') },
            { path: b, bytes: bytes('2') },
          ],
          ZIP_OPTIONS,
        );
      } catch (error: unknown) {
        return error as ZipError;
      }
      return null;
    };
    expect(dup('a/SKILL.md', 'a/SKILL.md')?.code).toBe('duplicate-path');
    expect(dup('a/SKILL.md', 'A/skill.md')?.code).toBe('duplicate-path');
    expect(dup('a', 'a/b.md')?.code).toBe('duplicate-path');
    expect(dup('ok.md', 'CWM-EXPORT.JSON')?.code).toBe('duplicate-path');
  });

  it('limit liczby plikow: manifest tez sie liczy', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `d/${i}.md`, bytes: bytes('x') }));
    // Bez kompresji: test sprawdza licznik, a deflate tysiecy plikow spowalnia wolne maszyny CI.
    const raw = { ...ZIP_OPTIONS, deflate: (b: Uint8Array) => b };
    expect(() => buildZip(many(ZIP_MAX_FILES - 1), raw)).not.toThrow();
    expect(() => buildZip(many(ZIP_MAX_FILES), raw)).toThrow(ZipError);
  }, 30_000);
});

describe('ZipExportService', () => {
  async function zipHarness(overrides: Partial<ZipExportDeps> = {}) {
    const h = await exportHarness();
    let counter = 0;
    const zip = new ZipExportService({
      catalog: h.catalog,
      exporters: [h.exporter],
      library: h.library,
      clock: h.clock,
      appVersion: '1.2.3',
      deflate: ZIP_OPTIONS.deflate,
      newPlanId: () => `zip-${++counter}`,
      ...overrides,
    });
    return { ...h, zip };
  }

  async function publicItem(h: Awaited<ReturnType<typeof zipHarness>>, slug: string) {
    const created = await h.library.create(
      draft({ slug, classification: { scope: 'public', secretFindings: [] } }),
    );
    return created.item.id;
  }

  it('element publiczny bez sekretow wchodzi do archiwum w ukladzie narzedzia, bez katalogu narzedzia na dysku', async () => {
    const h = await zipHarness();
    h.catalog.homes = new Set();
    const id = await publicItem(h, 'acme-public');
    const plan = await h.zip.plan('claude-code', [id]);

    expect(plan.held).toEqual([]);
    expect(plan.report.toolMissing).toBe(false);
    expect(plan.report.plan.applicable).toBe(true);
    expect(plan.report.plan.entries[0]?.recoverability?.status).toBe('recoverable');
    expect(plan.archive.fileName).toBe('cwm-export-claude-code-20261030-120000.zip');
    // Pusty cel: eksporter widzi korzen jako istniejacy i nie scala z niczym.
    expect(h.exporter.contexts[0]?.roots.every((r) => r.exists && r.active)).toBe(true);
    expect(h.exporter.contexts[0]?.materialization).toEqual({ directory: 'copy', file: 'copy' });

    const payload = h.zip.peek(plan.report.planId);
    const rows = readZip(payload.bytes).map((r) => r.name);
    expect(rows).toContain('claude-code/.claude/skills/acme-review/SKILL.md');
    expect(rows).toContain(ZIP_MANIFEST_NAME);
    expect(payload.fileCount).toBe(plan.archive.fileCount);
    expect(payload.fileCount).toBe(2);
  });

  it('element prywatny: bez zgody poza archiwum, ze zgoda w archiwum; plan nie jest wtedy do zapisu', async () => {
    const h = await zipHarness();
    const without = await h.zip.plan('claude-code', [h.itemId]);
    expect(without.held).toMatchObject([{ itemId: h.itemId, reason: 'private', confirmed: false }]);
    expect(without.report.plan.applicable).toBe(false);
    expect(without.report.plan.entries).toEqual([]);
    expect(h.exporter.seen).toHaveLength(0);
    expect(() => h.zip.peek(without.report.planId)).toThrow(/Nieznany plan/);

    const confirmed = await h.zip.plan('claude-code', [h.itemId], [h.itemId]);
    expect(confirmed.held).toMatchObject([{ reason: 'private', confirmed: true }]);
    expect(confirmed.report.plan.applicable).toBe(true);
    expect(h.zip.peek(confirmed.report.planId).itemCount).toBe(1);
  });

  it('element zalezny od projektu nigdy nie trafia do archiwum, nawet ze zgoda', async () => {
    const h = await zipHarness();
    const created = await h.library.create(
      draft({ slug: 'acme-proj', classification: { scope: 'project', secretFindings: [] } }),
    );
    const plan = await h.zip.plan('claude-code', [created.item.id], [created.item.id]);
    expect(plan.held).toMatchObject([{ reason: 'project', confirmed: false }]);
    expect(plan.report.plan.entries).toEqual([]);
    expect(plan.report.plan.applicable).toBe(false);
  });

  it('trafienie klasyfikatora sekretow: zapisane w elemencie albo znalezione w tresci teraz', async () => {
    const h = await zipHarness();
    const flagged = await h.library.create(
      draft({
        slug: 'acme-flagged',
        classification: {
          scope: 'public',
          secretFindings: [{ rule: 'known-key', relPath: 'SKILL.md', line: 3 }],
        },
      }),
    );
    const edited = await h.library.create(
      draft({
        slug: 'acme-edited',
        body: `Uzyj klucza ${SECRETS.github} przy wywolaniu.\n`,
        classification: { scope: 'public', secretFindings: [] },
      }),
    );
    const plan = await h.zip.plan('claude-code', [flagged.item.id, edited.item.id]);
    expect(plan.held.map((x) => [x.slug, x.reason, x.confirmed])).toEqual([
      ['acme-flagged', 'secret', false],
      ['acme-edited', 'secret', false],
    ]);
    expect(plan.report.plan.applicable).toBe(false);

    const ok = await h.zip.plan('claude-code', [flagged.item.id], [flagged.item.id]);
    expect(ok.report.plan.applicable).toBe(true);
  });

  it('peek zostawia plan do ponownego zapisu, consume go zuzywa, a po TTL plan wygasa', async () => {
    const h = await zipHarness();
    const id = await publicItem(h, 'acme-ttl');
    const { report } = await h.zip.plan('claude-code', [id]);
    h.zip.peek(report.planId);
    h.zip.peek(report.planId);
    h.zip.consume(report.planId);
    expect(() => h.zip.peek(report.planId)).toThrow(/Nieznany plan/);

    const again = await h.zip.plan('claude-code', [id]);
    h.clock.advance(15 * 60 * 1000 + 1);
    expect(() => h.zip.peek(again.report.planId)).toThrow(/wygasł/);
  });

  it('etykieta ze zmienna srodowiska dostaje stala nazwe katalogu, plik bez podwojonej nazwy', async () => {
    const roots = [
      root('r-skills', 'claude-code', { label: '$CLAUDE_CONFIG_DIR/skills' }),
      root('r-md', 'claude-code', { kind: 'global-instructions', label: '~/.claude/CLAUDE.md' }),
    ];
    const h = await zipHarness();
    h.catalog.roots = roots;
    h.exporter.build = (items) =>
      emptyPlan({
        entries: [
          entry({ rootId: 'r-skills', itemIds: items.map((i) => i.item.id) }),
          entry({
            rootId: 'r-md',
            relPath: 'CLAUDE.md',
            scope: 'marker-block',
            itemIds: items.map((i) => i.item.id),
          }),
          entry({
            rootId: 'r-skills',
            relPath: 'acme-dir',
            content: null,
            files: [
              { relPath: 'SKILL.md', bytes: bytes('a') },
              { relPath: 'lib/x.txt', bytes: bytes('b') },
            ],
            itemIds: items.map((i) => i.item.id),
          }),
        ],
      });
    const id = await publicItem(h, 'acme-paths');
    const { report } = await h.zip.plan('claude-code', [id]);
    const names = readZip(h.zip.peek(report.planId).bytes).map((r) => r.name);
    expect(names).toContain('claude-code/.claude/skills/acme-review/SKILL.md');
    expect(names).toContain('claude-code/.claude/CLAUDE.md');
    expect(names).toContain('claude-code/.claude/skills/acme-dir/lib/x.txt');
    expect(names.some((n) => n.includes('CLAUDE.md/'))).toBe(false);
  });

  it('sciezka spoza ukladu albo niebezpieczna to odmowa z kodem, nie zapis', async () => {
    const h = await zipHarness();
    h.catalog.roots = [root('r-claude', 'claude-code', { label: '/abs/skills' })];
    const id = await publicItem(h, 'acme-bad');
    const failure = await h.zip.plan('claude-code', [id]).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'zip-invalid-path' });

    const h2 = await zipHarness();
    h2.exporter.build = (items) =>
      emptyPlan({
        entries: [entry({ relPath: '../../etc/x', itemIds: items.map((i) => i.item.id) })],
      });
    const id2 = await publicItem(h2, 'acme-up');
    expect(await h2.zip.plan('claude-code', [id2]).catch((e: unknown) => e)).toMatchObject({
      code: 'zip-invalid-path',
    });
  });

  it('nieobslugiwane narzedzie i pusty wybor to bledy eksportu', async () => {
    const h = await zipHarness();
    expect(await code(h.zip.plan('codex', [h.itemId]))).toBe('unsupported-tool');
    expect(await code(h.zip.plan('claude-code', []))).toBe('no-items');
  });
});
