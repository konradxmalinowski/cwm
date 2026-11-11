import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { removeTempTrees } from '../harness/isolation';

import {
  ALL_LINKS,
  NO_LINKS,
  entry,
  makeFixture,
  makePlan,
  text,
  treeHash,
  type Fixture,
} from './write-gate-fixture';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');
const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);
const read = (path: string) => readFileSync(path, 'utf8');

/** Katalog skilla, ktory ktos stworzyl recznie: pliki w planie i poza nim, podkatalog, tryb 0755. */
function seedForeignDir(f: Fixture): string {
  const dir = join(f.skillsRoot, 'acme-x');
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'stara tresc\n');
  writeFileSync(join(dir, 'references', 'a.md'), 'a\n');
  writeFileSync(join(dir, 'notatki.txt'), 'moje notatki\n');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(join(dir, 'run.sh'), 0o755);
  return dir;
}

const planFiles = [
  { relPath: 'SKILL.md', bytes: text('nowa tresc\n') },
  { relPath: 'references/a.md', bytes: text('a\n') },
];

const dirEntry = (over = {}) =>
  entry({ action: 'link', relPath: 'acme-x', content: null, files: planFiles, ...over });

async function probeAndApply(f: Fixture, entries: ReturnType<typeof entry>[], planId = 'plan-1') {
  const probed = await f.gate.probe(makePlan(entries, { planId }));
  expect(probed.applicable).toBe(true);
  return { probed, report: await f.gate.apply(probed, { planId: probed.planId }) };
}

function manifestOf(f: Fixture, backupId: string) {
  return JSON.parse(readFileSync(join(f.userData, 'backups', backupId, 'MANIFEST'), 'utf8')) as {
    entries: {
      before: { state: string; files?: { relPath: string; backupFile: string }[] };
      after: { state: string };
    }[];
  };
}

describe('WriteGate: zastapienie zwyklego katalogu dowiazaniem', () => {
  posixOnly('robi kopie calego katalogu i zastepuje go dowiazaniem do nowej tresci', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    const dir = seedForeignDir(f);
    const { report } = await probeAndApply(f, [dirEntry()]);

    expect(report.verified).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(read(join(dir, 'SKILL.md'))).toBe('nowa tresc\n');
    expect(existsSync(join(dir, 'notatki.txt'))).toBe(false);

    const manifest = manifestOf(f, report.backupId);
    const saved = manifest.entries[0]?.before;
    expect(saved?.state).toBe('directory');
    expect(saved?.files?.map((x) => x.relPath).sort()).toEqual([
      'SKILL.md',
      'notatki.txt',
      'references/a.md',
      'run.sh',
    ]);
    const stored = saved?.files?.find((x) => x.relPath === 'notatki.txt');
    expect(read(join(f.userData, 'backups', report.backupId, stored?.backupFile ?? ''))).toBe(
      'moje notatki\n',
    );
  });

  posixOnly('drugi plan dla tego samego stanu to unchanged', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    seedForeignDir(f);
    await probeAndApply(f, [dirEntry()]);
    const again = await f.gate.probe(makePlan([dirEntry()], { planId: 'plan-2' }));
    expect(again.entries[0]?.action).toBe('unchanged');
  });

  posixOnly('niepowodzenie kolejnego wpisu przywraca katalog bajt w bajt', async () => {
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
    seedForeignDir(f);
    const before = treeHash(f.skillsRoot);
    const probed = await f.gate.probe(makePlan([dirEntry(), entry({ relPath: 'boom.md' })]));
    expect(probed.applicable).toBe(true);
    const report = await f.gate.apply(probed, { planId: probed.planId });
    expect(report.rolledBack).toBe(true);
    expect(treeHash(f.skillsRoot)).toBe(before);
    expect(lstatSync(join(f.skillsRoot, 'acme-x', 'run.sh')).mode & 0o777).toBe(0o755);
  });

  posixNonRoot('plik nieczytelny w katalogu blokuje wpis i niczego nie zmienia', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    const dir = seedForeignDir(f);
    chmodSync(join(dir, 'notatki.txt'), 0o000);
    try {
      const before = treeHash(f.skillsRoot);
      const probed = await f.gate.probe(makePlan([dirEntry()]));
      expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
      expect(probed.entries[0]?.recoverability?.reason).toContain('nieczytelny');
      expect(probed.applicable).toBe(false);
      expect(treeHash(f.skillsRoot)).toBe(before);
    } finally {
      chmodSync(join(dir, 'notatki.txt'), 0o644);
    }
  });

  posixOnly('dowiazanie wewnatrz katalogu blokuje wpis', async () => {
    const f = makeFixture({ capability: ALL_LINKS });
    const dir = seedForeignDir(f);
    symlinkSync(f.outside, join(dir, 'na-zewnatrz'));
    const probed = await f.gate.probe(makePlan([dirEntry()]));
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
    expect(probed.applicable).toBe(false);
  });
});

describe('WriteGate: zastapienie zwyklego katalogu kopia', () => {
  posixOnly(
    'pliki spoza planu znikaja, ale sa w kopii; rollback przy bledzie je zwraca',
    async () => {
      const f = makeFixture({
        capability: NO_LINKS,
        atomicOps: {
          rename: async (from, to) => {
            if (to.endsWith('boom.md'))
              throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            const { rename } = await import('node:fs/promises');
            await rename(from, to);
          },
        },
      });
      seedForeignDir(f);
      const before = treeHash(f.skillsRoot);
      const copy = dirEntry({ action: 'modify', materialization: 'copy' });
      const probed = await f.gate.probe(makePlan([copy, entry({ relPath: 'boom.md' })]));
      expect(probed.applicable).toBe(true);
      const failed = await f.gate.apply(probed, { planId: probed.planId });
      expect(failed.rolledBack).toBe(true);
      expect(treeHash(f.skillsRoot)).toBe(before);

      const { report } = await probeAndApply(f, [copy], 'plan-2');
      expect(readdirSync(join(f.skillsRoot, 'acme-x')).sort()).toEqual(['SKILL.md', 'references']);
      expect(read(join(f.skillsRoot, 'acme-x', 'SKILL.md'))).toBe('nowa tresc\n');
      expect(manifestOf(f, report.backupId).entries[0]?.before.files).toHaveLength(4);
    },
  );

  posixOnly('katalog bez plikow spoza planu zachowuje zapis plik po pliku', async () => {
    const f = makeFixture({ capability: NO_LINKS });
    const dir = join(f.skillsRoot, 'acme-x');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'stara\n');
    writeFileSync(join(dir, 'references', 'a.md'), 'a\n');
    const { report } = await probeAndApply(f, [
      dirEntry({ action: 'modify', materialization: 'copy' }),
    ]);
    expect(read(join(dir, 'SKILL.md'))).toBe('nowa tresc\n');
    expect(manifestOf(f, report.backupId).entries.every((e) => e.before.state === 'file')).toBe(
      true,
    );
  });
});
