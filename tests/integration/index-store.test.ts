import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import {
  IndexStoreOpenError,
  SCHEMA_VERSION,
  SqliteIndexStore,
} from '../../src/infra/db/index-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';

const SCHEMA_FILE = resolve('src/infra/db/schema/001-init.sql');

afterAll(() => {
  removeTempTrees();
});

interface MigrationRow {
  readonly version: number;
  readonly applied_at: string;
}

function readLedger(dbPath: string): MigrationRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as MigrationRow[];
  } finally {
    db.close();
  }
}

function schemaObjects(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * Ten test sprawdza logike indeksu na zwyklym Node, bo `better-sqlite3` 13
 * laduje prebuild N-API, ktory dziala i tu, i w Electronie. Nie zastepuje
 * dowodu z zapakowanej aplikacji - ten jest w tests/e2e/packaged-db.spec.ts.
 */
describe('indeks SQLite', () => {
  it('zaklada schemat przy otwarciu, nie przy pierwszym zapytaniu', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'index.db');

    const store = SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE });
    store.close();

    // Schemat jest na dysku, choc nikt nie wolal probe().
    expect(schemaObjects(dbPath)).toContain('schema_migrations');

    const ledger = readLedger(dbPath);
    expect(ledger.map((row) => row.version)).toEqual([1, 2, SCHEMA_VERSION]);
    expect(ledger.every((row) => !Number.isNaN(Date.parse(row.applied_at)))).toBe(true);
    expect(schemaObjects(dbPath)).toContain('operation_log');
  });

  it('jest idempotentna: powtorne otwarcie nie zmienia schematu ani rejestru', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'index.db');

    const first = SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE });
    first.close();
    const afterFirst = readLedger(dbPath);
    const objectsAfterFirst = schemaObjects(dbPath);

    for (let open = 0; open < 3; open += 1) {
      const store = SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE });
      store.close();
    }

    // Ten sam wpis, ta sama data: wersja wchodzi do rejestru raz, a nie przy
    // kazdym starcie. Inaczej applied_at klamaloby o tym, kiedy migracja
    // faktycznie zostala zastosowana.
    expect(readLedger(dbPath)).toEqual(afterFirst);
    expect(schemaObjects(dbPath)).toEqual(objectsAfterFirst);
    expect(readLedger(dbPath)).toHaveLength(SCHEMA_VERSION);
  });

  it('raport diagnostyczny nie zmienia niczego w bazie', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'index.db');
    const store = SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE });

    try {
      const before = readLedger(dbPath);
      const objectsBefore = schemaObjects(dbPath);

      for (let call = 0; call < 5; call += 1) store.probe();

      expect(readLedger(dbPath)).toEqual(before);
      expect(schemaObjects(dbPath)).toEqual(objectsBefore);
    } finally {
      store.close();
    }
  });

  it('raportuje wersje, tryb dziennika i dostepnosc FTS5', () => {
    const tree = createTempTree('acme-db-');
    const store = SqliteIndexStore.open(join(tree, 'index.db'), {
      home: tree,
      schemaFile: SCHEMA_FILE,
    });

    try {
      const probe = store.probe();
      expect(probe.status).toBe('ok');
      if (probe.status !== 'ok') return;

      expect(probe.engine).toBe('better-sqlite3');
      expect(probe.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(probe.journalMode).toBe('wal');
      expect(probe.schemaVersion).toBe(SCHEMA_VERSION);
      expect(probe.fts5Available).toBe(true);
    } finally {
      store.close();
    }
  });

  it('redaguje katalog domowy w opisie lokalizacji', () => {
    const tree = createTempTree('acme-db-');
    const store = SqliteIndexStore.open(join(tree, 'nested', 'index.db'), {
      home: tree,
      schemaFile: SCHEMA_FILE,
    });

    try {
      const probe = store.probe();
      expect(probe.status).toBe('ok');
      if (probe.status === 'unavailable') return;
      expect(probe.locationLabel).toBe(`~${join('/', 'nested', 'index.db')}`);
    } finally {
      store.close();
    }
  });

  it('porazka migracji jest glosna: otwarcie rzuca, nie zwraca polowicznego stanu', () => {
    const tree = createTempTree('acme-db-');

    expect(() =>
      SqliteIndexStore.open(join(tree, 'index.db'), {
        home: tree,
        schemaFile: join(tree, 'nie-ma-takiego-pliku.sql'),
      }),
    ).toThrow(IndexStoreOpenError);
  });

  it('uszkodzony plik bazy nie przechodzi przez otwarcie', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'broken.db');
    writeFileSync(dbPath, 'to nie jest baza sqlite', 'utf8');

    expect(() => SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE })).toThrow(
      IndexStoreOpenError,
    );
  });
});

/**
 * Rozpoznanie przyczyny jest warunkiem triazu z ADR 0029: dwie z tych
 * przyczyn prowadza do odbudowy, trzy do odmowy. Pomylka w klasyfikacji
 * oznaczalaby albo odmowe tam, gdzie wystarczyla odbudowa, albo odbudowe
 * tam, gdzie wyrzucilaby dane.
 */
describe('rozpoznanie przyczyny awarii indeksu', () => {
  function reasonOf(call: () => unknown): string {
    try {
      call();
    } catch (error: unknown) {
      if (error instanceof IndexStoreOpenError) return error.reason;
      return `inny blad: ${String(error)}`;
    }
    return 'brak bledu';
  }

  it('uszkodzony plik to corrupted', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'broken.db');
    writeFileSync(dbPath, 'to nie jest baza sqlite', 'utf8');

    expect(
      reasonOf(() => SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE })),
    ).toBe('corrupted');
  });

  it('baza z tabelami, ale bez rejestru migracji, to unknown-schema', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'index.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE acme_obce (id INTEGER PRIMARY KEY)');
    db.close();

    expect(
      reasonOf(() => SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE })),
    ).toBe('unknown-schema');
  });

  it('wersja schematu wyzsza od znanej to schema-from-future', () => {
    const tree = createTempTree('acme-db-');
    const dbPath = join(tree, 'index.db');

    const store = SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE });
    store.close();

    const db = new Database(dbPath);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION + 7,
      new Date().toISOString(),
    );
    db.close();

    expect(
      reasonOf(() => SqliteIndexStore.open(dbPath, { home: tree, schemaFile: SCHEMA_FILE })),
    ).toBe('schema-from-future');
  });

  it('niezapisywalny katalog to not-writable', () => {
    if (process.platform === 'win32') return;

    const tree = createTempTree('acme-db-');
    const locked = join(tree, 'bez-zapisu');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);

    try {
      expect(
        reasonOf(() =>
          SqliteIndexStore.open(join(locked, 'index.db'), { home: tree, schemaFile: SCHEMA_FILE }),
        ),
      ).toBe('not-writable');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
