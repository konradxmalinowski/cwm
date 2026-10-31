import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { FsLibraryStore, assertPlan, isPortableName } from '../../src/infra/library/library-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

// Reguly Windowsa sprawdzamy na kazdym systemie: to czysta funkcja nazw, a jej brak na Linuksie
// pozwolilby zapisac drzewo, ktorego nie da sie otworzyc na Windowsie (kryterium 10).
const plan = (rel: string) => [{ rel, bytes: new Uint8Array() }];
const dir = join('/', 'acme', 'item');

describe('assertPlan: reguly Windowsa jako obrona w glab (SEC-008)', () => {
  const rejected: [string, string][] = [
    ['assets/C:/x', 'invalid-name'],
    ['assets/a:b.txt', 'invalid-name'],
    ['assets/plik.txt:strumien', 'invalid-name'],
    ['assets/CON', 'invalid-name'],
    ['assets/conin$.md', 'invalid-name'],
    ['assets/CONOUT$', 'invalid-name'],
    ['assets/COM0', 'invalid-name'],
    ['assets/COM¹.txt', 'invalid-name'],
    ['assets/lpt²', 'invalid-name'],
    ['assets/aux.txt', 'invalid-name'],
    ['assets/Com1.md', 'invalid-name'],
    ['assets/LPT9', 'invalid-name'],
    ['assets/nul .txt', 'invalid-name'],
    ['assets/koniec.', 'invalid-name'],
    ['assets/koniec ', 'invalid-name'],
    ['assets/a<b', 'invalid-name'],
    ['assets/a|b', 'invalid-name'],
    ['assets/a?b', 'invalid-name'],
    ['assets/a*b', 'invalid-name'],
    ['assets/a\u0007b', 'invalid-name'],
    ['assets/..', 'path-escape'],
    ['assets/a/../../x', 'path-escape'],
    ['C:/x', 'path-escape'],
  ];

  for (const [rel, reason] of rejected) {
    it(`odrzuca ${JSON.stringify(rel)} jako ${reason}`, () => {
      expect(() => assertPlan(dir, plan(rel))).toThrowError(
        expect.objectContaining({ name: 'LibraryStoreError', reason }),
      );
    });
  }

  const accepted = [
    'assets/plik ze spacjami.txt',
    'assets/zażółć/gęślą jaźń.md',
    'assets/日本語/テスト.txt',
    'assets/LICENSE',
    'assets/notes.tmp',
    'assets/console.log',
    'assets/.hidden',
    'snapshots/claude-code/SKILL.md',
    'body.md',
    'item.json',
  ];

  for (const rel of accepted) {
    it(`przepuszcza ${JSON.stringify(rel)}`, () => {
      expect(() => assertPlan(dir, plan(rel))).not.toThrow();
    });
  }

  it('isPortableName: nazwa zarezerwowana tylko jako cala nazwa lub przed pierwsza kropka', () => {
    expect(isPortableName('con')).toBe(false);
    expect(isPortableName('con.tar.gz')).toBe(false);
    expect(isPortableName('contact.md')).toBe(true);
    expect(isPortableName('com10')).toBe(true);
  });
});

describe('itemDir: id musi byc przenosna nazwa katalogu (SEC-008)', () => {
  it('odrzuca id z regulami Windowsa we wszystkich metodach', async () => {
    const store = new FsLibraryStore(join(createTempTree('acme-paths-'), 'library'));
    for (const id of ['C:', 'a:b', 'CON', 'nul.txt', 'koniec.', 'koniec ', '...', 'a\u0001b']) {
      await expect(store.read(id), id).rejects.toMatchObject({ reason: 'invalid-id' });
      await expect(store.remove(id), id).rejects.toMatchObject({ reason: 'invalid-id' });
    }
  });
});
