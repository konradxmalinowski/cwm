import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isAtomicTempName } from '../../src/core/model/library-file-names';
import { AtomicWriteError, writeFileAtomic } from '../../src/infra/fs/atomic';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

const text = (s: string) => new TextEncoder().encode(s);
const errno = (code: string) => Object.assign(new Error(code), { code });

// Tryby plikow sa pojeciem POSIX. Na Windowsie chmod nie jest udawany (ADR 0018), wiec nie ma czego sprawdzac.
const posixOnly = it.skipIf(process.platform === 'win32');
const asRoot = process.getuid?.() === 0;

describe('zapis atomowy (ADR 0012, 0031)', () => {
  it('zapisuje bajty i nie zostawia pliku tymczasowego', async () => {
    const dir = createTempTree('acme-atomic-');
    await writeFileAtomic(join(dir, 'acme.txt'), text('tresc'));

    expect(readFileSync(join(dir, 'acme.txt'), 'utf8')).toBe('tresc');
    expect(readdirSync(dir)).toEqual(['acme.txt']);
  });

  posixOnly('nowy plik dostaje 0600', async () => {
    const dir = createTempTree('acme-atomic-');
    await writeFileAtomic(join(dir, 'acme.txt'), text('a'));
    expect(statSync(join(dir, 'acme.txt')).mode & 0o777).toBe(0o600);
  });

  posixOnly('nadpisanie zachowuje tryb istniejacego pliku mimo nowego inode', async () => {
    const dir = createTempTree('acme-atomic-');
    const target = join(dir, 'acme.txt');
    writeFileSync(target, 'stare');
    chmodSync(target, 0o600);
    const inodeBefore = statSync(target).ino;

    await writeFileAtomic(target, text('nowe'));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(target).ino).not.toBe(inodeBefore);

    chmodSync(target, 0o640);
    await writeFileAtomic(target, text('nowsze'));
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  posixOnly('jawny tryb wygrywa z trybem istniejacego pliku', async () => {
    const dir = createTempTree('acme-atomic-');
    const target = join(dir, 'acme.txt');
    writeFileSync(target, 'stare');
    chmodSync(target, 0o644);

    await writeFileAtomic(target, text('nowe'), { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('awaria rename sprzata plik tymczasowy i zostawia stary plik', async () => {
    const dir = createTempTree('acme-atomic-');
    const target = join(dir, 'acme.txt');
    writeFileSync(target, 'stare');

    const failure = writeFileAtomic(target, text('nowe'), {
      ops: { rename: () => Promise.reject(errno('EIO')) },
    });

    await expect(failure).rejects.toMatchObject({ name: 'AtomicWriteError', reason: 'io' });
    expect(readFileSync(target, 'utf8')).toBe('stare');
    expect(readdirSync(dir)).toEqual(['acme.txt']);
  });

  it('odczyt kontrolny wykrywa roznice bajtow', async () => {
    const dir = createTempTree('acme-atomic-');
    writeFileSync(join(dir, 'acme.txt'), 'stare');
    const failure = writeFileAtomic(join(dir, 'acme.txt'), text('nowe'), {
      ops: { readFile: () => Promise.resolve(text('inne')) },
    });
    await expect(failure).rejects.toMatchObject({ reason: 'verify-failed' });
    expect(readFileSync(join(dir, 'acme.txt'), 'utf8')).toBe('stare');
    expect(readdirSync(dir)).toEqual(['acme.txt']);
  });

  it('brak katalogu docelowego to rozpoznany blad', async () => {
    const dir = createTempTree('acme-atomic-');
    const failure = writeFileAtomic(join(dir, 'nie-ma', 'acme.txt'), text('a'));
    await expect(failure).rejects.toMatchObject({ reason: 'missing-directory' });
  });

  // Root omija uprawnienia katalogu, wiec test nic by nie dowodzil.
  it.skipIf(process.platform === 'win32' || asRoot)(
    'katalog tylko do odczytu daje permission-denied i nic po sobie nie zostawia',
    async () => {
      const dir = createTempTree('acme-atomic-');
      writeFileSync(join(dir, 'acme.txt'), 'stare');
      chmodSync(dir, 0o500);
      try {
        const failure = writeFileAtomic(join(dir, 'acme.txt'), text('nowe'));
        await expect(failure).rejects.toBeInstanceOf(AtomicWriteError);
        await expect(failure).rejects.toMatchObject({ reason: 'permission-denied' });
        expect(readdirSync(dir)).toEqual(['acme.txt']);
        expect(readFileSync(join(dir, 'acme.txt'), 'utf8')).toBe('stare');
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('dwa rownolegle zapisy do jednego pliku nie psuja tresci ani nie zostawiaja smieci', async () => {
    const dir = createTempTree('acme-atomic-');
    const target = join(dir, 'acme.txt');
    await Promise.all([
      writeFileAtomic(target, text('A'.repeat(4096))),
      writeFileAtomic(target, text('B'.repeat(4096))),
    ]);

    const content = readFileSync(target, 'utf8');
    expect([content === 'A'.repeat(4096), content === 'B'.repeat(4096)]).toContain(true);
    expect(readdirSync(dir)).toEqual(['acme.txt']);
  });
});

// Logike ponowien da sie sprawdzic na kazdym systemie, bo platforme i rename podstawia test.
// Prawdziwe EPERM z antywirusa trzeba zobaczyc na runnerze Windows.
describe('rozpoznawanie pliku tymczasowego', () => {
  it('rozpoznaje to, co sam generuje, i nic wiecej', async () => {
    const dir = createTempTree('acme-atomic-');
    let seen = '';
    await writeFileAtomic(join(dir, 'acme.txt'), text('a'), {
      ops: {
        rename: (from, to) => {
          seen = from.slice(dir.length + 1);
          return import('node:fs/promises').then((fs) => fs.rename(from, to));
        },
      },
    });

    expect(isAtomicTempName(seen)).toBe(true);
    for (const name of [
      'notes.tmp',
      '.hidden.tmp',
      'acme.txt',
      '.a.tmp',
      '.a.md.x.0a1b2c3d4e5f.tmp',
    ]) {
      expect(isAtomicTempName(name), name).toBe(false);
    }
  });
});

describe('ponowienia rename na Windowsie', () => {
  it('przeczekuje chwilowe EPERM i konczy sukcesem', async () => {
    const dir = createTempTree('acme-atomic-');
    const target = join(dir, 'acme.txt');
    const { rename } = await import('node:fs/promises');
    let calls = 0;
    const sleeps: number[] = [];

    await writeFileAtomic(target, text('nowe'), {
      ops: {
        platform: 'win32',
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        rename: (from, to) => {
          calls++;
          return calls <= 2 ? Promise.reject(errno('EPERM')) : rename(from, to);
        },
      },
    });

    expect(calls).toBe(3);
    expect(sleeps).toEqual([25, 50]);
    expect(readFileSync(target, 'utf8')).toBe('nowe');
    expect(readdirSync(dir)).toEqual(['acme.txt']);
  });

  it('po wyczerpaniu prob zwraca busy, sprzata i nie rusza starego pliku', async () => {
    const dir = createTempTree('acme-atomic-');
    const target = join(dir, 'acme.txt');
    writeFileSync(target, 'stare');
    let calls = 0;

    const failure = writeFileAtomic(target, text('nowe'), {
      ops: {
        platform: 'win32',
        sleep: () => Promise.resolve(),
        rename: () => {
          calls++;
          return Promise.reject(errno('EBUSY'));
        },
      },
    });

    await expect(failure).rejects.toMatchObject({ reason: 'busy' });
    expect(calls).toBe(6);
    expect(readFileSync(target, 'utf8')).toBe('stare');
    expect(readdirSync(dir)).toEqual(['acme.txt']);
  });

  it('poza Windowsem EPERM nie jest ponawiane', async () => {
    const dir = createTempTree('acme-atomic-');
    let calls = 0;

    const failure = writeFileAtomic(join(dir, 'acme.txt'), text('nowe'), {
      ops: {
        platform: 'linux',
        rename: () => {
          calls++;
          return Promise.reject(errno('EPERM'));
        },
      },
    });

    await expect(failure).rejects.toMatchObject({ reason: 'permission-denied' });
    expect(calls).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('inny kod bledu na Windowsie nie jest ponawiany', async () => {
    const dir = createTempTree('acme-atomic-');
    let calls = 0;

    const failure = writeFileAtomic(join(dir, 'acme.txt'), text('nowe'), {
      ops: {
        platform: 'win32',
        rename: () => {
          calls++;
          return Promise.reject(errno('ENOSPC'));
        },
      },
    });

    await expect(failure).rejects.toMatchObject({ reason: 'no-space' });
    expect(calls).toBe(1);
  });
});
