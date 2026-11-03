import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { removeTempTrees } from '../harness/isolation';

import {
  ALL_LINKS,
  NO_LINKS,
  entry,
  makeFixture,
  makePlan,
  text,
  type Fixture,
} from './write-gate-fixture';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');
const read = (path: string) => readFileSync(path, 'utf8');
const materialized = (f: Fixture, rel: string) =>
  join(f.userData, 'materialized', 'claude-code', ...rel.split('/'));

async function run(f: Fixture, plan: ReturnType<typeof makePlan>) {
  const probed = await f.gate.probe(plan);
  expect(probed.applicable).toBe(true);
  return { probed, report: await f.gate.apply(probed, { planId: probed.planId }) };
}

const linkFile = (over = {}) =>
  entry({ action: 'link', relPath: 'acme.md', content: text('tresc\n'), ...over });

describe('materializacja: link do pliku (ADR 0015)', () => {
  posixOnly('tworzy symlink do kopii w userData/materialized i zapisuje tam tresc', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    const { report, probed } = await run(f, makePlan([linkFile()]));

    const link = join(f.skillsRoot, 'acme.md');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(resolve(f.skillsRoot, readlinkSync(link))).toBe(materialized(f, 'acme.md'));
    expect(read(link)).toBe('tresc\n');
    expect(read(materialized(f, 'acme.md'))).toBe('tresc\n');
    expect(report.entries[0]?.outcome).toBe('written');
    expect(probed.entries[0]?.materialization).toBe('symlink');
  });

  posixOnly('link, ktory juz istnieje i wskazuje to samo, to unchanged', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    await run(f, makePlan([linkFile()]));
    const { report } = await run(f, makePlan([linkFile()], { planId: 'plan-2' }));
    expect(report.entries[0]?.outcome).toBe('unchanged');
    expect(report.backupId).toBe('');
  });

  posixOnly('zmiana tresci przy istniejacym linku odswieza kopie bez przepinania', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    await run(f, makePlan([linkFile()]));
    const { report } = await run(
      f,
      makePlan([linkFile({ content: text('v2\n') })], { planId: 'plan-2' }),
    );
    expect(report.entries[0]?.outcome).toBe('written');
    expect(read(join(f.skillsRoot, 'acme.md'))).toBe('v2\n');
  });

  posixOnly('cudze dowiazanie jest podmieniane z kopia, a jego cel nietkniety', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    const victim = join(f.outside, 'cudzy.md');
    writeFileSync(victim, 'cudza tresc');
    symlinkSync(victim, join(f.skillsRoot, 'acme.md'));

    const { report } = await run(f, makePlan([linkFile()]));
    expect(read(victim)).toBe('cudza tresc');
    expect(resolve(f.skillsRoot, readlinkSync(join(f.skillsRoot, 'acme.md')))).toBe(
      materialized(f, 'acme.md'),
    );
    const manifest = JSON.parse(read(join(f.userData, 'backups', report.backupId, 'MANIFEST'))) as {
      entries: { before: { state: string; linkTarget?: string } }[];
    };
    expect(manifest.entries[0]?.before).toEqual({ state: 'symlink', linkTarget: victim });
  });

  posixOnly('zwykly plik jest podmieniany na link z kopia (previous w planie)', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    writeFileSync(join(f.skillsRoot, 'acme.md'), 'reczna wersja');
    const { report } = await run(f, makePlan([linkFile({ previous: text('reczna wersja') })]));
    expect(lstatSync(join(f.skillsRoot, 'acme.md')).isSymbolicLink()).toBe(true);
    const manifest = JSON.parse(read(join(f.userData, 'backups', report.backupId, 'MANIFEST'))) as {
      entries: { before: { state: string; backupFile: string } }[];
    };
    expect(
      read(
        join(
          f.userData,
          'backups',
          report.backupId,
          ...(manifest.entries[0]?.before.backupFile ?? '').split('/'),
        ),
      ),
    ).toBe('reczna wersja');
  });

  it('zwykly plik z previous niezgodnym ze stanem dysku blokuje link', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    writeFileSync(join(f.skillsRoot, 'acme.md'), 'inna');
    const probed = await f.gate.probe(makePlan([linkFile({ previous: text('stara') })]));
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
  });
});

describe('materializacja: degradacja', () => {
  it('bez zdolnosci dowiazan plik trafia jako kopia, z ostrzezeniem i trybem copy', async () => {
    const f = makeFixture({ capability: NO_LINKS });
    const { probed, report } = await run(f, makePlan([linkFile()]));
    expect(lstatSync(join(f.skillsRoot, 'acme.md')).isSymbolicLink()).toBe(false);
    expect(read(join(f.skillsRoot, 'acme.md'))).toBe('tresc\n');
    expect(probed.entries[0]?.materialization).toBe('copy');
    expect(probed.entries[0]?.warnings.join(' ')).toContain('kopię');
    expect(report.entries[0]?.message).toContain('kopię');
    expect(existsSync(materialized(f, 'acme.md'))).toBe(false);
  });

  it('Windows bez uprawnien: katalog przez junction, plik jako kopia', async () => {
    const f = makeFixture({
      capability: { fileSymlink: false, directorySymlink: false, junction: true },
      platform: 'win32',
    });
    const dirEntry = entry({
      action: 'link',
      relPath: 'acme-skill',
      content: null,
      files: [{ relPath: 'SKILL.md', bytes: text('a') }],
    });
    const { probed, report } = await run(f, makePlan([dirEntry, linkFile()]));
    expect(probed.entries[0]?.materialization).toBe('junction');
    expect(probed.entries[0]?.warnings.join(' ')).toContain('junction');
    expect(probed.entries[1]?.materialization).toBe('copy');
    expect(read(join(f.skillsRoot, 'acme-skill', 'SKILL.md'))).toBe('a');
    expect(report.verified).toBe(true);
  });

  posixOnly('gdy system odmowi dowiazania, powstaje kopia z przyczyna w raporcie', async () => {
    const f = makeFixture({
      capability: ALL_LINKS,
      linkOps: {
        symlink: () => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })),
      },
    });
    const { report } = await run(f, makePlan([linkFile()]));
    expect(lstatSync(join(f.skillsRoot, 'acme.md')).isSymbolicLink()).toBe(false);
    expect(read(join(f.skillsRoot, 'acme.md'))).toBe('tresc\n');
    expect(report.entries[0]?.outcome).toBe('written');
    expect(report.entries[0]?.message).toContain('Dowiązanie nie powstało');
    expect(report.verified).toBe(true);
  });
});

describe('materializacja: katalog', () => {
  const dirEntry = (files: { relPath: string; bytes: Uint8Array }[], over = {}) =>
    entry({ action: 'link', relPath: 'acme-skill', content: null, files, ...over });

  posixOnly('linkuje katalog do userData/materialized, plik czytelny przez link', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    await run(
      f,
      makePlan([
        dirEntry([
          { relPath: 'SKILL.md', bytes: text('a') },
          { relPath: 'refs/n.md', bytes: text('b') },
        ]),
      ]),
    );
    expect(lstatSync(join(f.skillsRoot, 'acme-skill')).isSymbolicLink()).toBe(true);
    expect(read(join(f.skillsRoot, 'acme-skill', 'refs', 'n.md'))).toBe('b');
    expect(read(materialized(f, 'acme-skill/SKILL.md'))).toBe('a');
  });

  posixOnly('usuniety plik z listy znika z zawartosci linku (zero dryfu)', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    await run(
      f,
      makePlan([
        dirEntry([
          { relPath: 'SKILL.md', bytes: text('a') },
          { relPath: 'stary.md', bytes: text('x') },
        ]),
      ]),
    );
    const { report } = await run(
      f,
      makePlan([dirEntry([{ relPath: 'SKILL.md', bytes: text('a2') }])], { planId: 'plan-2' }),
    );
    expect(report.entries[0]?.outcome).toBe('written');
    expect(existsSync(join(f.skillsRoot, 'acme-skill', 'stary.md'))).toBe(false);
    expect(read(join(f.skillsRoot, 'acme-skill', 'SKILL.md'))).toBe('a2');
  });

  posixOnly('rzeczywisty katalog w miejscu linku blokuje wpis', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    mkdirSync(join(f.skillsRoot, 'acme-skill'));
    writeFileSync(join(f.skillsRoot, 'acme-skill', 'reczny.md'), 'moj');
    const probed = await f.gate.probe(
      makePlan([dirEntry([{ relPath: 'SKILL.md', bytes: text('a') }])]),
    );
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
    expect(read(join(f.skillsRoot, 'acme-skill', 'reczny.md'))).toBe('moj');
  });

  posixOnly(
    'przejscie z linku na kopie zastepuje nasze dowiazanie katalogiem z plikami',
    async () => {
      const f = makeFixture({ capability: ALL_LINKS });
      const files = [{ relPath: 'SKILL.md', bytes: text('a') }];
      await run(f, makePlan([dirEntry(files)]));
      const copyEntry = dirEntry(files, { action: 'modify', materialization: 'copy' });
      const { report } = await run(f, makePlan([copyEntry], { planId: 'plan-2' }));
      expect(report.verified).toBe(true);
      expect(lstatSync(join(f.skillsRoot, 'acme-skill')).isSymbolicLink()).toBe(false);
      expect(read(join(f.skillsRoot, 'acme-skill', 'SKILL.md'))).toBe('a');
      expect(read(materialized(f, 'acme-skill/SKILL.md'))).toBe('a');
    },
  );

  posixOnly('cudzy symlink katalogu przy zwyklym zapisie jest blokowany', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    symlinkSync(f.outside, join(f.skillsRoot, 'acme-skill'));
    const probed = await f.gate.probe(
      makePlan([dirEntry([{ relPath: 'SKILL.md', bytes: text('a') }], { action: 'modify' })]),
    );
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
  });
});

describe('materializacja: rollback', () => {
  posixOnly('niepowodzenie kolejnego wpisu usuwa link i zmaterializowana kopie', async () => {
    const f = makeFixture({
      capability: ALL_LINKS,
      atomicOps: {
        rename: async (from, to) => {
          if (to.endsWith('boom.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      },
    });
    const probed = await f.gate.probe(makePlan([linkFile(), entry({ relPath: 'boom.md' })]));
    expect(probed.applicable).toBe(true);
    const report = await f.gate.apply(probed, { planId: probed.planId });
    expect(report.rolledBack).toBe(true);
    expect(report.entries.map((e) => e.outcome)).toEqual(['rolled-back', 'failed']);
    expect(existsSync(join(f.skillsRoot, 'acme.md'))).toBe(false);
    expect(lstatSync(join(f.skillsRoot), { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(existsSync(materialized(f, 'acme.md'))).toBe(false);
  });

  posixOnly('rollback przywraca cudze dowiazanie, ktore link podmienil', async () => {
    const f = makeFixture({
      capability: ALL_LINKS,
      atomicOps: {
        rename: async (from, to) => {
          if (to.endsWith('boom.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      },
    });
    const victim = join(f.outside, 'cudzy.md');
    writeFileSync(victim, 'cudza');
    symlinkSync(victim, join(f.skillsRoot, 'acme.md'));
    const probed = await f.gate.probe(makePlan([linkFile(), entry({ relPath: 'boom.md' })]));
    await f.gate.apply(probed, { planId: probed.planId });
    expect(readlinkSync(join(f.skillsRoot, 'acme.md'))).toBe(victim);
    expect(read(victim)).toBe('cudza');
  });
});
