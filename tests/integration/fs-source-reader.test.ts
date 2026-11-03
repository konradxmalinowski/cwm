import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SourceReadError } from '../../src/core/ports/source-reader';
import { FsSourceReader } from '../../src/infra/source/fs-source-reader';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

const isPosix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

interface Tree {
  readonly base: string;
  readonly root: string;
  readonly outside: string;
  readonly reader: FsSourceReader;
}

/** Drzewo: `root/` jest zrodlem, `outside/` lezy obok i nie wolno go czytac przez root. */
function makeTree(): Tree {
  const base = createTempTree('acme-src-');
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'acme-review'), { recursive: true });
  mkdirSync(join(outside, 'zewnetrzny'), { recursive: true });
  writeFileSync(join(root, 'acme-review', 'SKILL.md'), '# acme\n');
  writeFileSync(join(outside, 'zewnetrzny', 'SKILL.md'), 'POZA-ROOTEM\n');
  writeFileSync(join(outside, 'klucz.txt'), 'TAJNE\n');
  const reader = new FsSourceReader((id) =>
    id === 'r1' ? root : id === 'rfile' ? join(root, 'acme-review', 'SKILL.md') : null,
  );
  return { base, root, outside, reader };
}

async function failureOf(task: Promise<unknown>): Promise<SourceReadError> {
  try {
    await task;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SourceReadError);
    return error as SourceReadError;
  }
  throw new Error('oczekiwano SourceReadError');
}

function expectNoAbsolute(error: SourceReadError, tree: Tree): void {
  expect(error.message).not.toContain(tree.base);
  expect(error.message).not.toMatch(/(?:^|[\s"'])(?:\/|[A-Za-z]:\\)\S/);
  expect(error.relPath).not.toContain(tree.base);
}

describe('FsSourceReader: odczyt', () => {
  it('listuje wpisy z typem i rozmiarem, posortowane', async () => {
    const t = makeTree();
    writeFileSync(join(t.root, 'b.md'), 'bb');
    mkdirSync(join(t.root, 'a dir z polskimi znakami żółć'));
    const entries = await t.reader.list('r1', '');
    expect(entries.map((e) => e.name)).toEqual([
      'a dir z polskimi znakami żółć',
      'acme-review',
      'b.md',
    ]);
    expect(entries.find((e) => e.name === 'b.md')).toEqual({ name: 'b.md', type: 'file', size: 2 });
    expect(entries.find((e) => e.name === 'acme-review')?.type).toBe('directory');
  });

  it('czyta plik i respektuje limit rozmiaru', async () => {
    const t = makeTree();
    const bytes = await t.reader.read('r1', 'acme-review/SKILL.md', 1024);
    expect(new TextDecoder().decode(bytes)).toBe('# acme\n');

    writeFileSync(join(t.root, 'duzy.md'), 'x'.repeat(100));
    const error = await failureOf(t.reader.read('r1', 'duzy.md', 50));
    expect(error.failure).toBe('too-large');
    expect(error.relPath).toBe('duzy.md');
    expectNoAbsolute(error, t);
    // Plik rowno na limicie przechodzi (sciezka pozytywna).
    expect((await t.reader.read('r1', 'duzy.md', 100)).length).toBe(100);
  });

  it('root bedacy dowiazaniem (dotfiles) jest rozwiazywany, wnetrze juz nie', async () => {
    const t = makeTree();
    const link = join(t.base, 'root-link');
    symlinkSync(t.root, link);
    const reader = new FsSourceReader(() => link);
    expect((await reader.read('x', 'acme-review/SKILL.md', 1024)).length).toBeGreaterThan(0);
  });

  it('root bedacy plikiem (CLAUDE.md) daje sie wylistowac i przeczytac', async () => {
    const t = makeTree();
    const [entry] = await t.reader.list('rfile', '');
    expect(entry).toMatchObject({ name: 'SKILL.md', type: 'file' });
    expect((await t.reader.read('rfile', '', 1024)).length).toBe(7);
    expect((await t.reader.read('rfile', 'SKILL.md', 1024)).length).toBe(7);
    expect((await failureOf(t.reader.read('rfile', 'inny.md', 1024))).failure).toBe('not-found');
  });

  it.runIf(isPosix)('zwraca tryb pliku', async () => {
    const t = makeTree();
    chmodSync(join(t.root, 'acme-review', 'SKILL.md'), 0o640);
    expect(await t.reader.mode('r1', 'acme-review/SKILL.md')).toBe(0o640);
  });

  it.runIf(isPosix && !isRoot)(
    'EACCES daje permission-denied z nazwa pliku, bez sciezki bezwzglednej',
    async () => {
      const t = makeTree();
      const file = join(t.root, 'acme-review', 'SKILL.md');
      chmodSync(file, 0o000);
      try {
        const error = await failureOf(t.reader.read('r1', 'acme-review/SKILL.md', 1024));
        expect(error.failure).toBe('permission-denied');
        expect(error.message).toContain('acme-review/SKILL.md');
        expectNoAbsolute(error, t);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it.runIf(isPosix && !isRoot)(
    'katalog bez uprawnien do odczytu nie przerywa listowania obok',
    async () => {
      const t = makeTree();
      mkdirSync(join(t.root, 'zamkniety'));
      chmodSync(join(t.root, 'zamkniety'), 0o000);
      try {
        const error = await failureOf(t.reader.list('r1', 'zamkniety'));
        expect(error.failure).toBe('permission-denied');
        expect((await t.reader.list('r1', '')).length).toBeGreaterThan(1);
      } finally {
        chmodSync(join(t.root, 'zamkniety'), 0o755);
      }
    },
  );

  it('brak pliku, katalog zamiast pliku i nieznany root to jawne bledy', async () => {
    const t = makeTree();
    const missing = await failureOf(t.reader.read('r1', 'nie-ma.md', 10));
    expect(missing.failure).toBe('not-found');
    expectNoAbsolute(missing, t);
    expect((await failureOf(t.reader.read('r1', 'acme-review', 10))).failure).toBe('not-a-file');
    expect((await failureOf(t.reader.list('r1', 'acme-review/SKILL.md'))).failure).toBe(
      'not-a-file',
    );
    expect((await failureOf(t.reader.read('nieznany', 'x', 10))).failure).toBe('not-found');
    expectNoAbsolute(await failureOf(t.reader.list('r1', 'nie-ma')), t);
  });
});

describe('FsSourceReader: granica roota', () => {
  it('odrzuca wyjscie przez .., sciezke bezwzgledna, backslash, NUL i puste segmenty', async () => {
    const t = makeTree();
    for (const rel of [
      '../outside/klucz.txt',
      'acme-review/../../outside/klucz.txt',
      join(t.outside, 'klucz.txt'),
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'acme-review\\SKILL.md',
      'acme-review/\0',
      'acme-review//SKILL.md',
      './acme-review/SKILL.md',
    ]) {
      const error = await failureOf(t.reader.read('r1', rel, 1024));
      expect(error.failure, rel).toBe('outside-root');
      expect(error.message).not.toContain(t.base);
    }
  });

  it.runIf(isPosix)('nie idzie za dowiazaniem do pliku poza rootem', async () => {
    const t = makeTree();
    symlinkSync(join(t.outside, 'klucz.txt'), join(t.root, 'link.txt'));
    const error = await failureOf(t.reader.read('r1', 'link.txt', 1024));
    expect(error.failure).toBe('not-a-file');
    expectNoAbsolute(error, t);
    const entries = await t.reader.list('r1', '');
    expect(entries.find((e) => e.name === 'link.txt')?.type).toBe('symlink');
  });

  it.runIf(isPosix)(
    'nie przechodzi przez dowiazany katalog ani przy odczycie, ani przy listowaniu',
    async () => {
      const t = makeTree();
      symlinkSync(join(t.outside, 'zewnetrzny'), join(t.root, 'link-dir'));
      symlinkSync(join(t.root, 'acme-review'), join(t.root, 'link-wewnetrzny'));
      for (const rel of ['link-dir/SKILL.md', 'link-wewnetrzny/SKILL.md']) {
        expect((await failureOf(t.reader.read('r1', rel, 1024))).failure, rel).toBe('not-a-file');
      }
      expect((await failureOf(t.reader.list('r1', 'link-dir'))).failure).toBe('not-a-file');
    },
  );

  it.runIf(isPosix)(
    'resolveSymlink: cel poza rootem daje relPath null i identity null',
    async () => {
      const t = makeTree();
      symlinkSync(join(t.outside, 'zewnetrzny'), join(t.root, 'link-dir'));
      expect(await t.reader.resolveSymlink('r1', 'link-dir')).toEqual({
        relPath: null,
        identity: null,
      });
    },
  );

  it.runIf(isPosix)(
    'resolveSymlink: cel pod rootem i stabilna identity do wykrywania aliasow',
    async () => {
      const t = makeTree();
      symlinkSync(join(t.root, 'acme-review'), join(t.root, 'alias-a'));
      symlinkSync('acme-review', join(t.root, 'alias-b'));
      const a = await t.reader.resolveSymlink('r1', 'alias-a');
      const b = await t.reader.resolveSymlink('r1', 'alias-b');
      expect(a.relPath).toBe('acme-review');
      expect(b).toEqual(a);

      const info = statSync(join(t.root, 'acme-review'), { bigint: true });
      expect(a.identity).toBe(`${info.dev}:${info.ino}`);
      // Inny cel, inna tozsamosc.
      symlinkSync(join(t.root, 'alias-a'), join(t.root, 'alias-c'));
      expect((await t.reader.resolveSymlink('r1', 'alias-c')).identity).toBe(a.identity);
      mkdirSync(join(t.root, 'drugi'));
      symlinkSync('drugi', join(t.root, 'alias-d'));
      expect((await t.reader.resolveSymlink('r1', 'alias-d')).identity).not.toBe(a.identity);
    },
  );

  it.runIf(isPosix)(
    'resolveSymlink: wiszace dowiazanie to not-found, zwykly plik to not-a-file',
    async () => {
      const t = makeTree();
      symlinkSync('nie-ma-takiego', join(t.root, 'wiszace'));
      expect((await failureOf(t.reader.resolveSymlink('r1', 'wiszace'))).failure).toBe('not-found');
      expect((await failureOf(t.reader.resolveSymlink('r1', 'acme-review/SKILL.md'))).failure).toBe(
        'not-a-file',
      );
    },
  );
});
