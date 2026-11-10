import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { WriteGateRefusal } from '../../src/infra/fs/write-gate';
import { FsBackupStore } from '../../src/infra/store/backup';
import { removeTempTrees } from '../harness/isolation';

import {
  ALL_LINKS,
  entry,
  itemId,
  makeFixture,
  makePlan,
  text,
  type Fixture,
} from './write-gate-fixture';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');
const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);
const errno = (code: string) => Object.assign(new Error(code), { code });

const read = (path: string) => readFileSync(path, 'utf8');

function manifestOf(f: Fixture, backupId: string) {
  return JSON.parse(read(join(f.userData, 'backups', backupId, 'MANIFEST'))) as {
    planId: string;
    note: string;
    entries: {
      index: number;
      relPath: string;
      path: string;
      before: { state: string; sha256?: string; backupFile?: string; mode?: string };
      after: { state: string; sha256?: string };
    }[];
  };
}

async function approved(f: Fixture, plan: ReturnType<typeof makePlan>) {
  const probed = await f.gate.probe(plan);
  expect(probed.applicable).toBe(true);
  return probed;
}

describe('WriteGate.probe', () => {
  it('nowy plik i istniejacy czytelny plik sa recoverable, bez sciezki bezwzglednej w powodzie', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'acme'));
    writeFileSync(join(f.skillsRoot, 'acme', 'old.md'), 'stare');
    const probed = await f.gate.probe(
      makePlan([
        entry({ relPath: 'acme/SKILL.md' }),
        entry({ relPath: 'acme/old.md', action: 'modify', previous: text('stare') }),
      ]),
    );
    expect(probed.applicable).toBe(true);
    expect(probed.entries.map((e) => e.recoverability?.status)).toEqual([
      'recoverable',
      'recoverable',
    ]);
  });

  it('previous niezgodne ze stanem dysku blokuje wpis', async () => {
    const f = makeFixture();
    writeFileSync(join(f.skillsRoot, 'a.md'), 'inne niz w planie');
    const probed = await f.gate.probe(
      makePlan([entry({ relPath: 'a.md', action: 'modify', previous: text('stare') })]),
    );
    expect(probed.applicable).toBe(false);
    expect(probed.entries[0]?.recoverability).toMatchObject({
      status: 'blocked',
      reason: 'Plik zmienił się od przygotowania planu.',
    });
  });

  it('konflikt w planie odbiera applicable mimo zdrowych wpisow', async () => {
    const f = makeFixture();
    const probed = await f.gate.probe(
      makePlan([entry()], { conflicts: [{ itemIds: [], relPath: 'acme/SKILL.md', reason: 'x' }] }),
    );
    expect(probed.entries[0]?.recoverability?.status).toBe('recoverable');
    expect(probed.applicable).toBe(false);
  });

  it('cel bedacy katalogiem jest blokowany', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'acme'));
    const probed = await f.gate.probe(makePlan([entry({ relPath: 'acme', action: 'modify' })]));
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
  });

  posixNonRoot('plik nieczytelny jest blokowany, bo nie da sie zrobic kopii', async () => {
    const f = makeFixture();
    const file = join(f.skillsRoot, 'secret.md');
    writeFileSync(file, 'x');
    chmodSync(file, 0o000);
    const probed = await f.gate.probe(
      makePlan([entry({ relPath: 'secret.md', action: 'modify', previous: text('x') })]),
    );
    chmodSync(file, 0o600);
    expect(probed.entries[0]?.recoverability).toMatchObject({ status: 'blocked' });
    expect(probed.entries[0]?.recoverability?.reason).toContain('nieczytelny');
  });

  posixNonRoot(
    'katalog tylko do odczytu blokuje, a plik tylko do odczytu w zapisywalnym katalogu przechodzi',
    async () => {
      const f = makeFixture();
      const locked = join(f.skillsRoot, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      writeFileSync(join(f.skillsRoot, 'ro.md'), 'stare');
      chmodSync(join(f.skillsRoot, 'ro.md'), 0o444);
      const probed = await f.gate.probe(
        makePlan([
          entry({ relPath: 'locked/a.md' }),
          entry({ relPath: 'ro.md', action: 'modify', previous: text('stare') }),
        ]),
      );
      chmodSync(locked, 0o755);
      expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
      expect(probed.entries[1]?.recoverability?.status).toBe('recoverable');
    },
  );

  it('brak miejsca w userData blokuje wpis', async () => {
    const f = makeFixture({ freeBytes: () => Promise.resolve(3) });
    writeFileSync(join(f.skillsRoot, 'a.md'), 'dluzsza tresc');
    const probed = await f.gate.probe(
      makePlan([entry({ relPath: 'a.md', action: 'modify', previous: text('dluzsza tresc') })]),
    );
    expect(probed.entries[0]?.recoverability?.reason).toContain('miejsca');
  });

  // Kolumna pozytywna tego samego bezpiecznika (ARCHITECTURE 12.5): miejsce jest i jest go
  // dosc, albo systemu nie da sie zapytac o wolne miejsce. W obu przypadkach zapis przechodzi.
  for (const [label, free] of [
    ['1 MiB wolnego miejsca', 1024 * 1024],
    ['wolne miejsce nieznane (null)', null],
  ] as const) {
    it(`${label} nie blokuje wpisu`, async () => {
      const f = makeFixture({ freeBytes: () => Promise.resolve(free) });
      writeFileSync(join(f.skillsRoot, 'a.md'), 'dluzsza tresc');
      const probed = await f.gate.probe(
        makePlan([entry({ relPath: 'a.md', action: 'modify', previous: text('dluzsza tresc') })]),
      );
      expect(probed.entries[0]?.recoverability?.status).toBe('recoverable');
      expect(probed.applicable).toBe(true);
    });
  }

  it('dwa wpisy na ten sam plik: drugi jest blokowany', async () => {
    const f = makeFixture();
    const probed = await f.gate.probe(makePlan([entry(), entry({ relPath: 'ACME/skill.md' })]));
    expect(probed.entries[1]?.recoverability?.status).toBe('blocked');
  });
});

describe('WriteGate.apply: odmowy na starcie', () => {
  it('bez zatwierdzenia albo z cudzym planId nic nie jest zapisane', async () => {
    const f = makeFixture();
    const probed = await approved(f, makePlan([entry()]));
    await expect(f.gate.apply(probed, { planId: 'inny' })).rejects.toMatchObject({
      code: 'approval-mismatch',
    });
    await expect(
      f.gate.apply(probed, undefined as unknown as { planId: string }),
    ).rejects.toBeInstanceOf(WriteGateRefusal);
    expect(existsSync(join(f.skillsRoot, 'acme'))).toBe(false);
    expect(existsSync(join(f.userData, 'backups'))).toBe(false);
  });

  it('plan nieaplikowalny jest odrzucony', async () => {
    const f = makeFixture();
    const plan = makePlan([entry()]);
    await expect(f.gate.apply(plan, { planId: plan.planId })).rejects.toMatchObject({
      code: 'not-applicable',
    });
  });

  it('plan niesprawdzony, z podrobiona flaga applicable, jest odrzucony', async () => {
    const f = makeFixture();
    const plan = makePlan([entry()], { applicable: true });
    await expect(f.gate.apply(plan, { planId: plan.planId })).rejects.toMatchObject({
      code: 'not-probed',
    });
  });

  it('plan przeterminowany (plik zmieniony po probe) jest odrzucony, a plik nietkniety', async () => {
    const f = makeFixture();
    const file = join(f.skillsRoot, 'a.md');
    writeFileSync(file, 'v1');
    const probed = await approved(
      f,
      makePlan([
        entry({ relPath: 'a.md', action: 'modify', previous: text('v1'), content: text('v2') }),
      ]),
    );
    writeFileSync(file, 'zmienione przez uzytkownika');
    await expect(f.gate.apply(probed, { planId: probed.planId })).rejects.toMatchObject({
      code: 'plan-changed',
    });
    expect(read(file)).toBe('zmienione przez uzytkownika');
    expect(existsSync(join(f.userData, 'backups'))).toBe(false);
  });

  it('nieudana kopia zapasowa oznacza brak zapisu', async () => {
    const blocker = makeFixture();
    // Katalog kopii wskazuje na zwykly plik, wiec utworzenie kopii musi sie nie udac.
    const brokenDir = join(blocker.userData, 'not-a-dir');
    writeFileSync(brokenDir, 'x');
    const f = makeFixture({ backups: new FsBackupStore(brokenDir) });
    const probed = await approved(f, makePlan([entry()]));
    await expect(f.gate.apply(probed, { planId: probed.planId })).rejects.toMatchObject({
      code: 'backup-failed',
    });
    expect(existsSync(join(f.skillsRoot, 'acme'))).toBe(false);
  });
});

describe('WriteGate.apply: zapis', () => {
  it('zapisuje, robi kopie z MANIFEST i wpis w logu', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'acme'));
    writeFileSync(join(f.skillsRoot, 'acme', 'old.md'), 'stare');
    const probed = await approved(
      f,
      makePlan([
        entry({ relPath: 'acme/SKILL.md', itemIds: [itemId('I1')] }),
        entry({
          relPath: 'acme/old.md',
          action: 'modify',
          previous: text('stare'),
          content: text('nowe'),
          itemIds: [itemId('I2')],
        }),
      ]),
    );
    const report = await f.gate.apply(probed, { planId: probed.planId });

    expect(report.verified).toBe(true);
    expect(report.rolledBack).toBe(false);
    expect(report.entries.map((e) => e.outcome)).toEqual(['written', 'written']);
    expect(read(join(f.skillsRoot, 'acme', 'SKILL.md'))).toBe('tresc\n');
    expect(read(join(f.skillsRoot, 'acme', 'old.md'))).toBe('nowe');

    const manifest = manifestOf(f, report.backupId);
    expect(manifest.planId).toBe(probed.planId);
    expect(manifest.note).toContain('backupFile');
    expect(manifest.entries[0]).toMatchObject({
      relPath: 'acme/SKILL.md',
      before: { state: 'missing' },
    });
    const second = manifest.entries[1];
    expect(second?.before.state).toBe('file');
    expect(second?.after.state).toBe('file');
    expect(second?.before.sha256).not.toBe(second?.after.sha256);
    expect(
      read(
        join(
          f.userData,
          'backups',
          report.backupId,
          ...(second?.before.backupFile ?? '').split('/'),
        ),
      ),
    ).toBe('stare');
    // Kopia jest tez w content store.
    const { sha256Bytes } = await import('../../src/core/services/normalization/hash');
    expect(await f.objects.get(sha256Bytes(text('stare')))).not.toBeNull();

    expect(f.log.map((r) => [r.operation, r.itemId])).toEqual([
      ['export', 'I1'],
      ['export', 'I2'],
    ]);
    // Raport nie niesie sciezek bezwzglednych.
    expect(JSON.stringify(report)).not.toContain(f.tree);
  });

  posixOnly('zachowuje tryb 0600 istniejacego pliku', async () => {
    const f = makeFixture();
    const file = join(f.skillsRoot, 'cfg.md');
    writeFileSync(file, 'sekret');
    chmodSync(file, 0o600);
    const probed = await approved(
      f,
      makePlan([
        entry({
          relPath: 'cfg.md',
          action: 'modify',
          previous: text('sekret'),
          content: text('nowe'),
        }),
      ]),
    );
    await f.gate.apply(probed, { planId: probed.planId });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(read(file)).toBe('nowe');
  });

  it('zachowuje CRLF istniejacego celu, a nowy plik dostaje LF', async () => {
    const f = makeFixture();
    const file = join(f.skillsRoot, 'crlf.md');
    writeFileSync(file, 'a\r\nb\r\n');
    const probed = await approved(
      f,
      makePlan([
        entry({
          relPath: 'crlf.md',
          action: 'modify',
          previous: text('a\r\nb\r\n'),
          content: text('a\nb\nc\n'),
        }),
        entry({ relPath: 'nowy.md', content: text('x\ny\n') }),
      ]),
    );
    await f.gate.apply(probed, { planId: probed.planId });
    expect(read(file)).toBe('a\r\nb\r\nc\r\n');
    expect(read(join(f.skillsRoot, 'nowy.md'))).toBe('x\ny\n');
  });

  it('plik z przewazajacym LF zostaje w LF, a mieszany liczy sie wg przewagi', async () => {
    const f = makeFixture();
    const file = join(f.skillsRoot, 'lf.md');
    writeFileSync(file, 'a\nb\nc\r\n');
    const probed = await approved(
      f,
      makePlan([
        entry({
          relPath: 'lf.md',
          action: 'modify',
          previous: text('a\nb\nc\r\n'),
          content: text('x\ny\n'),
        }),
      ]),
    );
    await f.gate.apply(probed, { planId: probed.planId });
    expect(read(file)).toBe('x\ny\n');
  });

  it('identyczna tresc to unchanged, bez kopii i bez wpisu w logu', async () => {
    const f = makeFixture();
    writeFileSync(join(f.skillsRoot, 'a.md'), 'to samo\n');
    const probed = await approved(
      f,
      makePlan([
        entry({
          relPath: 'a.md',
          action: 'modify',
          previous: text('to samo\n'),
          content: text('to samo\n'),
          itemIds: [itemId('I1')],
        }),
        entry({ relPath: 'b.md', action: 'unchanged', content: text('x') }),
      ]),
    );
    const report = await f.gate.apply(probed, { planId: probed.planId });
    expect(report.entries.map((e) => e.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(report.backupId).toBe('');
    expect(existsSync(join(f.userData, 'backups'))).toBe(false);
    expect(f.log).toEqual([]);
  });

  it('root bedacy plikiem: pusty relPath, takze gdy pliku jeszcze nie ma', async () => {
    const f = makeFixture();
    mkdirSync(join(f.tree, 'tool'), { recursive: true });
    const probed = await approved(f, makePlan([entry({ rootId: 'r-file', relPath: 'CLAUDE.md' })]));
    await f.gate.apply(probed, { planId: probed.planId });
    expect(read(f.instructionsFile)).toBe('tresc\n');

    const again = await approved(
      f,
      makePlan(
        [
          entry({
            rootId: 'r-file',
            relPath: '',
            action: 'modify',
            previous: text('tresc\n'),
            content: text('v2\n'),
          }),
        ],
        {
          planId: 'plan-2',
        },
      ),
    );
    await f.gate.apply(again, { planId: 'plan-2' });
    expect(read(f.instructionsFile)).toBe('v2\n');
  });

  it('wpis katalogowy zapisuje wszystkie pliki, tworzac katalogi', async () => {
    const f = makeFixture();
    const probed = await approved(
      f,
      makePlan([
        entry({
          relPath: 'acme-skill',
          content: null,
          files: [
            { relPath: 'SKILL.md', bytes: text('a') },
            { relPath: 'refs/note.md', bytes: text('b') },
          ],
        }),
      ]),
    );
    const report = await f.gate.apply(probed, { planId: probed.planId });
    expect(read(join(f.skillsRoot, 'acme-skill', 'refs', 'note.md'))).toBe('b');
    expect(manifestOf(f, report.backupId).entries).toHaveLength(2);
  });

  it('dwa apply naraz: jeden zapisuje, drugi dostaje odmowe z aktualnego stanu', async () => {
    const f = makeFixture();
    const probed = await approved(f, makePlan([entry()]));
    const results = await Promise.allSettled([
      f.gate.apply(probed, { planId: probed.planId }),
      f.gate.apply(probed, { planId: probed.planId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'plan-changed' });
    expect(read(join(f.skillsRoot, 'acme', 'SKILL.md'))).toBe('tresc\n');
  });
});

describe('WriteGate.apply: atomowosc i rollback', () => {
  function faultyRename(): Partial<import('../../src/infra/fs/atomic').AtomicOps> {
    return {
      rename: async (from, to) => {
        if (to.includes(`${sep}locked${sep}`) && to.endsWith('x.md')) throw errno('EACCES');
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
    };
  }

  it('blad przy drugim wpisie cofa pierwszy, kopia istnieje, stan jak przed', async () => {
    const f = makeFixture({ atomicOps: faultyRename() });
    mkdirSync(join(f.skillsRoot, 'locked'));
    writeFileSync(join(f.skillsRoot, 'first.md'), 'pierwotne');
    chmodSync(join(f.skillsRoot, 'first.md'), 0o640);
    const probed = await approved(
      f,
      makePlan([
        entry({
          relPath: 'first.md',
          action: 'modify',
          previous: text('pierwotne'),
          content: text('nowe'),
        }),
        entry({ relPath: 'nowe-w-nowym-katalogu/a.md' }),
        entry({ relPath: 'locked/x.md' }),
      ]),
    );
    const report = await f.gate.apply(probed, { planId: probed.planId });

    expect(report.rolledBack).toBe(true);
    expect(report.verified).toBe(false);
    expect(report.entries.map((e) => e.outcome)).toEqual(['rolled-back', 'rolled-back', 'failed']);
    expect(JSON.stringify(report)).not.toContain(f.tree);
    expect(read(join(f.skillsRoot, 'first.md'))).toBe('pierwotne');
    if (process.platform !== 'win32') {
      expect(statSync(join(f.skillsRoot, 'first.md')).mode & 0o777).toBe(0o640);
    }
    expect(existsSync(join(f.skillsRoot, 'nowe-w-nowym-katalogu'))).toBe(false);
    expect(readdirSync(join(f.skillsRoot, 'locked'))).toEqual([]);
    expect(readdirSync(f.skillsRoot).sort()).toEqual(['first.md', 'locked']);
    expect(existsSync(join(f.userData, 'backups', report.backupId, 'MANIFEST'))).toBe(true);
    expect(f.log).toEqual([]);
  });

  it('ponowny przebieg po usunieciu przyczyny domyka operacje', async () => {
    const broken = makeFixture({ atomicOps: faultyRename() });
    mkdirSync(join(broken.skillsRoot, 'locked'));
    const first = await approved(broken, makePlan([entry({ relPath: 'locked/x.md' })]));
    const failed = await broken.gate.apply(first, { planId: first.planId });
    expect(failed.rolledBack).toBe(true);

    const healthy = makeFixture();
    mkdirSync(join(healthy.skillsRoot, 'locked'));
    const second = await approved(healthy, makePlan([entry({ relPath: 'locked/x.md' })]));
    const ok = await healthy.gate.apply(second, { planId: second.planId });
    expect(ok.verified).toBe(true);
    expect(read(join(healthy.skillsRoot, 'locked', 'x.md'))).toBe('tresc\n');
  });

  it('blad odczytu kontrolnego cofa zapis i raportuje failed', async () => {
    let root = '';
    const g = makeFixture({
      atomicOps: {
        readFile: async (path) => {
          if (root !== '' && path.startsWith(root)) return text('zepsute');
          const { readFile } = await import('node:fs/promises');
          return readFile(path);
        },
      },
    });
    root = g.skillsRoot;
    const probed = await approved(g, makePlan([entry()]));
    // Kopia zapasowa tez przechodzi przez atomicOps, ale lezy poza rootem, wiec nie jest psuta.
    const report = await g.gate.apply(probed, { planId: probed.planId });
    expect(report.entries[0]?.outcome).toBe('failed');
    expect(report.entries[0]?.message).toContain('Odczyt kontrolny');
    expect(report.rolledBack).toBe(true);
    expect(existsSync(join(g.skillsRoot, 'acme', 'SKILL.md'))).toBe(false);
  });
});

describe('WriteGate: bezpiecznik sciezek (ARCHITECTURE 12.5), obie kolumny', () => {
  const negative: [string, string][] = [
    ['..', '../poza.md'],
    ['.. w srodku', 'acme/../../poza.md'],
    ['absolutna POSIX', '/etc/passwd'],
    ['litera dysku', 'C:/Windows/x.md'],
    ['backslash', 'acme\\x.md'],
    ['UNC', '//serwer/share/x.md'],
    ['UNC z backslashami', '\\\\serwer\\share\\x.md'],
    ['prefiks \\\\?\\', '\\\\?\\C:\\x.md'],
    ['NUL', 'acme/a\0.md'],
    ['znak sterujacy', 'acme/a\n.md'],
    ['nazwa zarezerwowana', 'aux.txt'],
    ['zarezerwowana w katalogu', 'acme/CON/x.md'],
    ['COM1', 'com1'],
    ['koncowa kropka', 'acme/x.'],
    ['koncowa spacja', 'acme/x '],
    ['pusta czesc', 'acme//x.md'],
    ['pusta sciezka', ''],
    ['znak zakazany', 'acme/a?.md'],
  ];

  for (const [name, relPath] of negative) {
    it(`blokuje: ${name}`, async () => {
      const f = makeFixture();
      // Pusty relPath na roocie katalogowym wskazuje sam katalog, wiec tez ma byc zablokowany.
      const probed = await f.gate.probe(makePlan([entry({ relPath })]));
      expect(probed.applicable).toBe(false);
      expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
      expect(probed.entries[0]?.recoverability?.reason ?? '').not.toContain(f.tree);

      // Obrona w glab: plan z podrobionym werdyktem tez jest odrzucony przez apply.
      const forged = makePlan(
        [
          {
            ...entry({ relPath }),
            recoverability: {
              status: 'recoverable',
              reason: null,
              probedAt: '2026-11-03T10:00:00.000Z',
            },
          },
        ],
        { applicable: true },
      );
      await expect(f.gate.apply(forged, { planId: forged.planId })).rejects.toBeInstanceOf(
        WriteGateRefusal,
      );
      expect(readdirSync(f.outside)).toEqual([]);
    });
  }

  posixOnly('blokuje symlink wyprowadzajacy poza root i nie zapisuje przez niego', async () => {
    const f = makeFixture();
    symlinkSync(f.outside, join(f.skillsRoot, 'wyjscie'));
    const probed = await f.gate.probe(makePlan([entry({ relPath: 'wyjscie/x.md' })]));
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
    expect(probed.entries[0]?.recoverability?.reason).toContain('poza lokalizację');
    expect(readdirSync(f.outside)).toEqual([]);
  });

  posixOnly('blokuje symlink do nieistniejacego miejsca poza rootem (wiszacy)', async () => {
    const f = makeFixture();
    symlinkSync(join(f.outside, 'nie-ma'), join(f.skillsRoot, 'wiszacy'));
    const probed = await f.gate.probe(makePlan([entry({ relPath: 'wiszacy/x.md' })]));
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
  });

  it('blokuje root UNC i \\\\?\\ na Windowsie', async () => {
    for (const root of [
      '\\\\serwer\\share\\skills',
      '\\\\?\\C:\\Users\\x\\skills',
      '//serwer/share/skills',
    ]) {
      const g = makeFixture({ platform: 'win32' });
      const gate = new (await import('../../src/infra/fs/write-gate')).FsWriteGate({
        resolveRoot: () => root,
        userDataDir: g.userData,
        objects: g.objects,
        linkMode: { capability: () => Promise.resolve(ALL_LINKS) },
        platform: 'win32',
      });
      const probed = await gate.probe(makePlan([entry()]));
      expect(probed.entries[0]?.recoverability?.status, root).toBe('blocked');
    }
  });

  it('przepuszcza: spacje, znaki spoza ASCII, nazwy zblizone do zarezerwowanych', async () => {
    const f = makeFixture();
    const probed = await f.gate.probe(
      makePlan([
        entry({ relPath: 'katalog ze spacjami/plik o dlugiej nazwie.md' }),
        entry({ relPath: 'zażółć/gęślą jaźń.md' }),
        entry({ relPath: 'tokyo/日本語.md' }),
        entry({ relPath: 'console.md' }),
        entry({ relPath: 'com10.md' }),
        entry({ relPath: 'auxiliary/x.md' }),
        entry({ relPath: '.ukryty/plik' }),
      ]),
    );
    expect(probed.entries.map((e) => e.recoverability?.reason)).toEqual(Array(7).fill(null));
    expect(probed.applicable).toBe(true);
  });

  it('przepuszcza sciezke gleboko zagniezdzona i zapisuje ja', async () => {
    const f = makeFixture();
    const deep = Array.from({ length: 12 }, (_, i) => `poziom ${i}`).join('/');
    const probed = await approved(f, makePlan([entry({ relPath: `${deep}/SKILL.md` })]));
    await f.gate.apply(probed, { planId: probed.planId });
    expect(read(join(f.skillsRoot, ...deep.split('/'), 'SKILL.md'))).toBe('tresc\n');
  });

  posixOnly('przepuszcza symlink wewnatrz roota, takze gdy sam root jest dowiazaniem', async () => {
    const f = makeFixture();
    mkdirSync(join(f.skillsRoot, 'prawdziwy'));
    symlinkSync(join(f.skillsRoot, 'prawdziwy'), join(f.skillsRoot, 'alias'));
    const realRoot = join(f.tree, 'dotfiles-skills');
    mkdirSync(realRoot);
    const probed = await approved(f, makePlan([entry({ relPath: 'alias/x.md' })]));
    await f.gate.apply(probed, { planId: probed.planId });
    expect(read(join(f.skillsRoot, 'prawdziwy', 'x.md'))).toBe('tresc\n');
  });

  posixOnly('root bedacy dowiazaniem do katalogu z dotfiles jest dozwolony', async () => {
    const f = makeFixture();
    const real = join(f.tree, 'dotfiles');
    mkdirSync(real);
    const { rmSync } = await import('node:fs');
    rmSync(f.skillsRoot, { recursive: true });
    symlinkSync(real, f.skillsRoot);
    const probed = await approved(f, makePlan([entry({ relPath: 'acme/SKILL.md' })]));
    await f.gate.apply(probed, { planId: probed.planId });
    expect(read(join(real, 'acme', 'SKILL.md'))).toBe('tresc\n');
  });

  posixOnly(
    'zapis do pliku bedacego cudzym dowiazaniem jest blokowany i nie rusza celu',
    async () => {
      const f = makeFixture();
      const victim = join(f.outside, 'dotfile.md');
      writeFileSync(victim, 'dotfiles');
      symlinkSync(victim, join(f.skillsRoot, 'link.md'));
      const probed = await f.gate.probe(
        makePlan([entry({ relPath: 'link.md', action: 'modify', previous: text('dotfiles') })]),
      );
      expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
      expect(probed.entries[0]?.recoverability?.reason).toContain('dowiązaniem');
      expect(read(victim)).toBe('dotfiles');
      expect(lstatSync(join(f.skillsRoot, 'link.md')).isSymbolicLink()).toBe(true);
    },
  );
});
