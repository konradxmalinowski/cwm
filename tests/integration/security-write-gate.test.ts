import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { removeTempTrees } from '../harness/isolation';

import { entry, expectNoBytesWritten, makeFixture, makePlan, text } from './write-gate-fixture';

/**
 * Kryteria 6 i 8 Etapu 5, uzupelnienie testow `write-gate.test.ts`. Tu: cele niebedace zwyklym
 * plikiem oraz asercja negatywna, ze `apply` planu z wpisem `blocked` nie zapisuje ani bajtu.
 */

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');
const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

describe('cel niebedacy zwyklym plikiem (kryterium 8)', () => {
  posixOnly('potok FIFO jest blokowany, a zapis nie rusza drzewa', async () => {
    const f = makeFixture();
    execFileSync('mkfifo', [join(f.skillsRoot, 'rura')]);
    const probed = await f.gate.probe(
      makePlan([entry({ relPath: 'rura', action: 'modify', previous: text('x') })]),
    );
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
    expect(probed.entries[0]?.recoverability?.reason ?? '').not.toContain(f.tree);
    await expectNoBytesWritten(f, makePlan([entry({ relPath: 'rura', action: 'modify' })]));
  });

  posixOnly('dowiazanie jako plik docelowy jest blokowane, a jego cel nietkniety', async () => {
    const f = makeFixture();
    writeFileSync(join(f.outside, 'cel.md'), 'poza rootem');
    symlinkSync(join(f.outside, 'cel.md'), join(f.skillsRoot, 'alias.md'));
    await expectNoBytesWritten(
      f,
      makePlan([entry({ relPath: 'alias.md', action: 'modify', previous: text('poza rootem') })]),
    );
    expect(readFileSync(join(f.outside, 'cel.md'), 'utf8')).toBe('poza rootem');
  });
});

describe('apply planu z wpisem blocked nie zapisuje ani bajtu (kryterium 8, asercja negatywna)', () => {
  const good = () => entry({ relPath: 'zdrowy/SKILL.md', content: text('zdrowa tresc\n') });

  it('katalog w miejscu pliku', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'acme'));
    writeFileSync(join(f.skillsRoot, 'acme', 'x.md'), 'x');
    await expectNoBytesWritten(f, makePlan([good(), entry({ relPath: 'acme', action: 'modify' })]));
  });

  it('wyjscie przez .. (path traversal)', async () => {
    const f = makeFixture();
    await expectNoBytesWritten(f, makePlan([good(), entry({ relPath: '../../outside/poza.md' })]));
  });

  it('nazwa z NUL i nazwa zarezerwowana Windowsa', async () => {
    const f = makeFixture();
    await expectNoBytesWritten(
      f,
      makePlan([good(), entry({ relPath: 'a\0b.md' }), entry({ relPath: 'nul.md' })]),
    );
  });

  it('UNC i \\\\?\\ w sciezce wpisu', async () => {
    const f = makeFixture();
    await expectNoBytesWritten(
      f,
      makePlan([
        good(),
        entry({ relPath: '\\\\serwer\\share\\x.md' }),
        entry({ relPath: '\\\\?\\C:\\x.md' }),
      ]),
    );
  });

  posixOnly('symlink wyprowadzajacy poza root', async () => {
    const f = makeFixture();
    symlinkSync(f.outside, join(f.skillsRoot, 'wyjscie'));
    await expectNoBytesWritten(f, makePlan([good(), entry({ relPath: 'wyjscie/x.md' })]));
    expect(readdirSync(f.outside)).toEqual([]);
  });

  posixNonRoot('plik nieczytelny', async () => {
    const f = makeFixture();
    const file = join(f.skillsRoot, 'tajny.md');
    writeFileSync(file, 'x');
    chmodSync(file, 0o000);
    try {
      await expectNoBytesWritten(
        f,
        makePlan([good(), entry({ relPath: 'tajny.md', action: 'modify', previous: text('x') })]),
      );
    } finally {
      chmodSync(file, 0o600);
    }
  });

  posixNonRoot('katalog tylko do czytania', async () => {
    const f = makeFixture();
    const locked = join(f.skillsRoot, 'zamkniety');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    try {
      await expectNoBytesWritten(f, makePlan([good(), entry({ relPath: 'zamkniety/a.md' })]));
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('brak miejsca w userData (podstawiony port, bez zapelniania dysku)', async () => {
    const f = makeFixture({ freeBytes: () => Promise.resolve(2) });
    writeFileSync(join(f.skillsRoot, 'duzy.md'), 'dluzsza tresc do skopiowania');
    await expectNoBytesWritten(
      f,
      makePlan([
        entry({
          relPath: 'duzy.md',
          action: 'modify',
          previous: text('dluzsza tresc do skopiowania'),
        }),
      ]),
    );
  });

  it('dwa wpisy na ten sam plik: drugi blokowany, nic nie zapisane', async () => {
    const f = makeFixture();
    await expectNoBytesWritten(f, makePlan([entry(), entry({ relPath: 'ACME/skill.md' })]));
  });
});
