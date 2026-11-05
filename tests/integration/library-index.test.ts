import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ItemId, Sha256 } from '../../src/core/model/item';
import type { LibraryIndexEntry } from '../../src/core/ports/library-index';
import { SqliteIndexStore } from '../../src/infra/db/index-store';
import { toFtsQuery } from '../../src/infra/db/library-index';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

function openIndex() {
  const tree = createTempTree('acme-libindex-');
  const store = SqliteIndexStore.open(join(tree, 'index.db'), { home: tree });
  return { store, index: store.libraryIndex() };
}

let counter = 0;
function entry(overrides: Partial<LibraryIndexEntry> & { slug: string }): LibraryIndexEntry {
  counter += 1;
  const id = `01ACME${String(counter).padStart(20, '0')}` as ItemId;
  return {
    id,
    kind: 'skill',
    slugKey: overrides.slug.toLowerCase(),
    title: 'Tytul',
    description: 'Opis',
    body: 'Tresc',
    revision: 1,
    contentHash: 'a'.repeat(64) as Sha256,
    updatedAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('indeks biblioteki w SQLite (migracja 4)', () => {
  it('migracja zaklada tabele items i items_fts oraz unikalny indeks po (kind, slug_key)', () => {
    const { store } = openIndex();
    try {
      const probe = store.probe();
      expect(probe.status === 'ok' && probe.schemaVersion).toBe(4);
    } finally {
      store.close();
    }
  });

  it('upsert dodaje i podmienia, remove usuwa, count i slugs sa zgodne', () => {
    const { store, index } = openIndex();
    try {
      const a = entry({ slug: 'acme-aaa', title: 'Alfa' });
      index.upsert(a);
      index.upsert(entry({ slug: 'acme-beta', title: 'Beta' }));
      expect(index.count()).toBe(2);

      index.upsert({ ...a, title: 'Gamma', revision: 2 });
      expect(index.count()).toBe(2);
      expect(index.search('alfa')).toEqual([]);
      expect(index.search('gamma')).toEqual([a.id]);
      expect(
        index
          .slugs()
          .map((s) => s.slug)
          .sort(),
      ).toEqual(['acme-aaa', 'acme-beta']);

      index.remove(a.id);
      index.remove(a.id);
      expect(index.count()).toBe(1);
      expect(index.search('gamma')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('baza pilnuje unikalnosci po typie i kluczu kolizji', () => {
    const { store, index } = openIndex();
    try {
      index.upsert(entry({ slug: 'Acme-Review', slugKey: 'acme-review' }));
      expect(() => index.upsert(entry({ slug: 'acme-review', slugKey: 'acme-review' }))).toThrow(
        /UNIQUE/,
      );
      // Ten sam klucz w innym typie jest dozwolony.
      expect(() =>
        index.upsert(entry({ slug: 'acme-review', slugKey: 'acme-review', kind: 'agent' })),
      ).not.toThrow();
      expect(index.count()).toBe(2);
    } finally {
      store.close();
    }
  });

  it('wyszukiwanie: prefiks na tokenach, wszystkie slowa, polskie znaki, filtr typu', () => {
    const { store, index } = openIndex();
    try {
      const lodz = entry({
        slug: 'acme-lodz',
        title: 'Przegląd w Łodzi',
        description: 'Zażółć gęślą jaźń',
        body: 'Pierwsza linia\nDruga linia z kodem ABC123',
      });
      const agent = entry({ slug: 'acme-agent', kind: 'agent', title: 'Agent przeglądu' });
      index.upsert(lodz);
      index.upsert(agent);

      expect(index.search('przeg')).toEqual(expect.arrayContaining([lodz.id, agent.id]));
      expect(index.search('przeglad')).toHaveLength(2);
      expect(index.search('lodzi')).toEqual([lodz.id]);
      expect(index.search('ŁÓDŹ')).toEqual([lodz.id]);
      expect(index.search('zazolc gesla jazn')).toEqual([lodz.id]);
      expect(index.search('abc1')).toEqual([lodz.id]);
      expect(index.search('lodzi druga')).toEqual([lodz.id]);
      expect(index.search('lodzi nieistnieje')).toEqual([]);
      expect(index.search('przeglad', 'agent')).toEqual([agent.id]);
      expect(index.search('acme-lod')).toEqual([lodz.id]);
    } finally {
      store.close();
    }
  });

  it('znaki specjalne FTS w zapytaniu nie daja bledu skladni', () => {
    const { store, index } = openIndex();
    try {
      const target = entry({
        slug: 'acme-cpp',
        title: 'Notatki C++ i "cudzyslowy"',
        body: 'NEAR AND OR NOT',
      });
      index.upsert(target);
      const hostile = [
        '"',
        '""',
        '*',
        '(',
        ')',
        'a AND',
        'OR b',
        'NOT',
        'NEAR(a b)',
        'title:x',
        '-x',
        '^x',
        "'; DROP TABLE items; --",
        'c++',
        '"cudzyslowy"',
        'a"b',
        '{x}',
        '\\',
      ];
      for (const query of hostile) {
        expect(() => index.search(query), query).not.toThrow();
      }
      expect(index.search('c++')).toEqual([target.id]);
      expect(index.search('"cudzyslowy"')).toEqual([target.id]);
      expect(index.search('near and')).toEqual([target.id]);
      // Zapytanie bez slow nie jest zapytaniem: wolajacy wraca do filtra po plikach.
      expect(index.search('***')).toBeNull();
      expect(index.count()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('toFtsQuery ujmuje kazde slowo w cudzyslowy, dodaje prefiks i ogranicza liczbe slow', () => {
    expect(toFtsQuery('Łódź  przegląd')).toBe('"Lódź"* "przegląd"*');
    expect(toFtsQuery('a"b')).toBe('"a"* "b"*');
    expect(toFtsQuery('   ')).toBeNull();
    expect((toFtsQuery('a b c d e f g h i j k l m n o')?.match(/\*/g) ?? []).length).toBe(12);
  });

  it('replaceAll zastepuje zawartosc i oddaje wpisy kolidujace, nie przerywajac reszty', () => {
    const { store, index } = openIndex();
    try {
      index.upsert(entry({ slug: 'acme-stary', title: 'Stary' }));
      const first = entry({ slug: 'acme-dup', slugKey: 'acme-dup' });
      const clash = entry({ slug: 'ACME-DUP', slugKey: 'acme-dup' });
      const other = entry({ slug: 'acme-inny', title: 'Inny' });

      const { rejected } = index.replaceAll([first, clash, other]);

      expect(rejected.map((r) => r.id)).toEqual([clash.id]);
      expect(index.count()).toBe(2);
      expect(index.search('stary')).toEqual([]);
      expect(index.search('inny')).toEqual([other.id]);
    } finally {
      store.close();
    }
  });

  it('migracja z wersji 3 dodaje tabele do istniejacego indeksu bez utraty logu', async () => {
    // Plik 001 z szwem testowym nie rusza reszty migracji; sprawdzamy, ze 4 przechodzi na bazie z 1 do 3.
    const tree = createTempTree('acme-libindex-');
    const dbPath = join(tree, 'index.db');
    const schemaFile = resolve('src/infra/db/schema/001-init.sql');
    const first = SqliteIndexStore.open(dbPath, { home: tree, schemaFile });
    await first.operationLog().append({
      operation: 'create',
      itemId: '01ACME00000000000000000001' as ItemId,
      itemKind: 'skill',
      slug: 'acme-x',
      at: '2026-11-05T10:00:00.000Z',
      before: null,
      after: null,
    });
    first.close();

    const second = SqliteIndexStore.open(dbPath, { home: tree, schemaFile });
    try {
      const rows = await second.operationLogReader().groups(10);
      expect(rows).toHaveLength(1);
      expect(second.libraryIndex().count()).toBe(0);
    } finally {
      second.close();
    }
  });
});
