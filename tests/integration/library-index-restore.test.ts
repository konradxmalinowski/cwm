import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { restoreLibraryIndex } from '../../src/main/bootstrap/library-index';
import { startIndex } from '../../src/main/bootstrap/index-startup';
import { IndexStoreOpenError, SqliteIndexStore } from '../../src/infra/db/index-store';
import { quarantineIndex } from '../../src/infra/db/quarantine';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { FakeClock, MemoryOperationLog, deterministicRandom, draft } from '../unit/library-fakes';

afterAll(() => {
  removeTempTrees();
});

/** Aplikacja w miniaturze: katalog `userData` z biblioteka na dysku i indeksem otwieranym jak przy starcie. */
function openApp(root: string) {
  const dbPath = join(root, 'index.db');
  const clock = new FakeClock();
  let current: SqliteIndexStore | null = null;
  const service = new LibraryService({
    store: new FsLibraryStore(join(root, 'library')),
    objects: new FsObjectStore(join(root, 'objects')),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
    index: () => current?.libraryIndex() ?? null,
  });
  const started = startIndex({
    openStore: () => SqliteIndexStore.open(dbPath, { home: root }),
    quarantine: () =>
      quarantineIndex(dbPath, join(root, 'quarantine'), String(Date.now())).directory,
    describeFailure: (error) =>
      error instanceof IndexStoreOpenError
        ? { reason: error.reason, message: error.message }
        : null,
  });
  current = started.store as SqliteIndexStore | null;
  return {
    service,
    dbPath,
    info: started.info,
    store: current,
    close: () => current?.close(),
  };
}

const TITLES = ['Przegląd zmian', 'Łódzki raport', 'Notatki ze spotkania'] as const;

async function seed(root: string): Promise<string[]> {
  const app = openApp(root);
  const ids: string[] = [];
  for (const [i, title] of TITLES.entries()) {
    const result = await app.service.create(
      draft({
        slug: `acme-item-${i}`,
        content: {
          title,
          description: `Opis numer ${i}`,
          descriptionOrigin: 'source',
          body: `Tresc elementu ${i} z unikalnym slowem znacznik${i}\n`,
        },
      }),
    );
    ids.push(result.item.id);
  }
  app.close();
  return ids;
}

describe('kryterium 2: usuniecie index.db odtwarza pelny indeks z plikow', () => {
  it('po skasowaniu index.db i ponownym starcie wyszukiwanie znajduje wszystko', async () => {
    const root = createTempTree('acme-restore-');
    const ids = await seed(root);

    for (const suffix of ['', '-wal', '-shm']) {
      const file = join(root, `index.db${suffix}`);
      if (existsSync(file)) rmSync(file);
    }
    expect(existsSync(join(root, 'index.db'))).toBe(false);

    const app = openApp(root);
    try {
      expect(app.info.outcome).toBe('ready');
      expect(app.store!.libraryIndex().count()).toBe(0);
      expect(app.service.search('znacznik')).toBeNull();

      const info = await restoreLibraryIndex(app.service, app.info, () => undefined);

      expect(info.outcome).toBe('ready');
      expect(app.store!.libraryIndex().count()).toBe(3);
      expect(app.service.search('znacznik')?.slice().sort()).toEqual([...ids].sort());
      expect(app.service.search('znacznik1')).toEqual([ids[1]]);
      expect(app.service.search('lodzki')).toEqual([ids[1]]);
      expect(app.service.search('przeglad')).toEqual([ids[0]]);
      expect(app.service.search('spotkania notatki')).toEqual([ids[2]]);

      // Pliki nietkniete: te same elementy, ta sama tresc.
      const listed = await app.service.list();
      expect(listed.items.map((i) => i.id).sort()).toEqual([...ids].sort());
    } finally {
      app.close();
    }
  });

  it('indeks w sprawnym stanie nie jest wypelniany drugi raz', async () => {
    const root = createTempTree('acme-restore-');
    await seed(root);

    const app = openApp(root);
    try {
      await restoreLibraryIndex(app.service, app.info, () => undefined);
      const filled = app.store!.libraryIndex().count();
      expect(filled).toBe(3);

      const second = openApp(root);
      try {
        const report = await second.service.syncIndex();
        expect(report.status).toBe('current');
        expect(report.restored).toBe(3);
      } finally {
        second.close();
      }
    } finally {
      app.close();
    }
  });

  it('indeks uszkodzony: odbudowa po kwarantannie podaje prawdziwa liczbe i liste nieodzyskanego', async () => {
    const root = createTempTree('acme-restore-');
    await seed(root);
    writeFileSync(join(root, 'index.db'), 'to nie jest baza sqlite', 'utf8');

    const app = openApp(root);
    try {
      expect(app.info.outcome).toBe('rebuilt');
      expect(app.info.restoredItems).toBe(0);

      const info = await restoreLibraryIndex(app.service, app.info, () => undefined);

      expect(info.outcome).toBe('rebuilt');
      expect(info.restoredItems).toBe(3);
      const lines = (info.notRestored ?? []).join('\n');
      expect(lines).toMatch(/log operacji/);
      expect(lines).toMatch(/stan synchronizacji/);
      expect(lines).not.toMatch(/Etapie 2/);
      expect(app.service.search('znacznik')).toHaveLength(3);
    } finally {
      app.close();
    }
  });

  it('element, ktorego nie dalo sie wczytac, jest w notRestored z powodem, a reszta w indeksie', async () => {
    const root = createTempTree('acme-restore-');
    const ids = await seed(root);
    writeFileSync(join(root, 'library', 'items', ids[1]!, 'item.json'), '{nie json', 'utf8');
    writeFileSync(join(root, 'index.db'), 'to nie jest baza sqlite', 'utf8');

    const app = openApp(root);
    try {
      const info = await restoreLibraryIndex(app.service, app.info, () => undefined);

      expect(info.restoredItems).toBe(2);
      const lines = info.notRestored ?? [];
      expect(lines.some((l) => l.startsWith(`element ${ids[1]}:`))).toBe(true);
      expect(lines.join('\n')).toMatch(/log operacji/);
      expect(app.service.search('znacznik1')).toEqual([]);
      expect(app.service.search('znacznik0')).toEqual([ids[0]]);
    } finally {
      app.close();
    }
  });

  it('migracja istniejacego indeksu: nowa tabela jest pusta, start wypelnia ja z plikow', async () => {
    const root = createTempTree('acme-restore-');
    await seed(root);

    // Indeks z kopii zapasowej sprzed migracji 4: wersja 3, bez wpisu biblioteki w tabelach.
    const app = openApp(root);
    app.close();
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(join(root, 'index.db'));
    raw.exec('DELETE FROM items_fts; DELETE FROM items;');
    raw.close();

    const again = openApp(root);
    try {
      expect(again.store!.libraryIndex().count()).toBe(0);
      await restoreLibraryIndex(again.service, again.info, () => undefined);
      expect(again.store!.libraryIndex().count()).toBe(3);
    } finally {
      again.close();
    }
  });
});
