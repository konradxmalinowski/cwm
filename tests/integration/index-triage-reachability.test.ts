import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { IndexFailureReason } from '../../src/core/model/index-health';
import { startIndex } from '../../src/main/bootstrap/index-startup';
import {
  IndexStoreOpenError,
  SCHEMA_VERSION,
  SqliteIndexStore,
} from '../../src/infra/db/index-store';
import { quarantineIndex } from '../../src/infra/db/quarantine';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

/**
 * Kryterium 5 i 3 Etapu 2: kazda z czterech galezi triazu (pieciu przyczyn) jest osiagalna z
 * prawdziwego `SqliteIndexStore`, a nie z atrapy, i daje reakcje z ADR 0029. Test osiagalnosci
 * jest osobny od testu zachowania: galaz, do ktorej nie da sie dojsc, jest tekstem, nie decyzja.
 */
interface Setup {
  readonly root: string;
  readonly dbPath: string;
  readonly open: () => SqliteIndexStore;
  readonly quarantine: ReturnType<typeof vi.fn>;
  readonly describeFailure: (
    error: unknown,
  ) => { reason: IndexFailureReason; message: string } | null;
}

function setup(loadDriver?: () => never): Setup {
  const root = createTempTree('acme-triage-');
  const dbPath = join(root, 'index.db');
  const quarantine = vi.fn(
    () => quarantineIndex(dbPath, join(root, 'quarantine'), 'proba').directory,
  );
  return {
    root,
    dbPath,
    quarantine,
    open: () =>
      SqliteIndexStore.open(dbPath, {
        home: root,
        ...(loadDriver === undefined ? {} : { loadDriver }),
      }),
    describeFailure: (error) =>
      error instanceof IndexStoreOpenError
        ? { reason: error.reason, message: error.message }
        : null,
  };
}

function run(s: Setup) {
  return startIndex({
    openStore: s.open,
    quarantine: s.quarantine as unknown as () => string,
    describeFailure: s.describeFailure,
  });
}

describe('osiagalnosc galezi triazu przez prawdziwy indeks', () => {
  it('corrupted: plik nie jest baza, reakcja to odbudowa po kwarantannie', () => {
    const s = setup();
    writeFileSync(s.dbPath, 'to nie jest baza sqlite', 'utf8');

    const result = run(s);
    try {
      expect(result.info.outcome).toBe('rebuilt');
      expect(result.info.reason).toBe('corrupted');
      expect(s.quarantine).toHaveBeenCalledOnce();
      expect(existsSync(join(s.root, 'quarantine', 'index-proba.sqlite'))).toBe(true);
    } finally {
      (result.store as SqliteIndexStore | null)?.close();
    }
  });

  it('unknown-schema: tabele bez rejestru migracji, reakcja to odbudowa po kwarantannie', () => {
    const s = setup();
    const db = new Database(s.dbPath);
    db.exec('CREATE TABLE acme_obce (id INTEGER PRIMARY KEY)');
    db.close();

    const result = run(s);
    try {
      expect(result.info.outcome).toBe('rebuilt');
      expect(result.info.reason).toBe('unknown-schema');
      expect(s.quarantine).toHaveBeenCalledOnce();
    } finally {
      (result.store as SqliteIndexStore | null)?.close();
    }
  });

  it('schema-from-future: odmowa, plik nietkniety, bez kwarantanny i bez odbudowy (asercja negatywna)', () => {
    const s = setup();
    const seed = s.open();
    seed.close();
    const db = new Database(s.dbPath);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION + 5,
      new Date().toISOString(),
    );
    db.exec(
      "INSERT INTO operation_log (operation, item_id, at) VALUES ('create', '01ACME', '2026-11-05')",
    );
    db.close();
    const before = readFileSync(s.dbPath);

    const result = run(s);

    expect(result.info.outcome).toBe('refused');
    expect(result.info.reason).toBe('schema-from-future');
    expect(result.store).toBeNull();
    expect(s.quarantine).not.toHaveBeenCalled();
    expect(existsSync(join(s.root, 'quarantine'))).toBe(false);

    // Log operacji, jedyna rzecz nieodtwarzalna z plikow, nadal tam jest.
    const after = new Database(s.dbPath, { readonly: true });
    try {
      const rows = after.prepare('SELECT count(*) AS total FROM operation_log').get() as {
        total: number;
      };
      expect(rows.total).toBe(1);
    } finally {
      after.close();
    }
    expect(readFileSync(s.dbPath).equals(before)).toBe(true);
  });

  it('not-writable: odmowa, bez kwarantanny', () => {
    if (process.platform === 'win32') return;
    const s = setup();
    const locked = join(s.root, 'bez-zapisu');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    const dbPath = join(locked, 'index.db');
    const quarantine = vi.fn(() => 'nie powinno sie wykonac');

    try {
      const result = startIndex({
        openStore: () => SqliteIndexStore.open(dbPath, { home: s.root }),
        quarantine,
        describeFailure: s.describeFailure,
      });
      expect(result.info.outcome).toBe('refused');
      expect(result.info.reason).toBe('not-writable');
      expect(result.store).toBeNull();
      expect(quarantine).not.toHaveBeenCalled();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('native-module: podstawione ladowanie sterownika daje odmowe, nie zawieszenie procesu', () => {
    const loadDriver = (): never => {
      throw new Error("Cannot find module 'better_sqlite3.node'");
    };
    const s = setup(loadDriver);
    writeFileSync(s.dbPath, 'plik uzytkownika, ktorego odbudowa nie ma prawa tknac', 'utf8');
    const before = readFileSync(s.dbPath);

    // Samo otwarcie rozpoznaje przyczyne, a nie rzuca nierozpoznanym bledem.
    let caught: unknown;
    try {
      s.open();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexStoreOpenError);
    expect((caught as IndexStoreOpenError).reason).toBe('native-module');

    const result = run(s);

    expect(result.info.outcome).toBe('refused');
    expect(result.info.reason).toBe('native-module');
    expect(result.store).toBeNull();
    expect(s.quarantine).not.toHaveBeenCalled();
    expect(readFileSync(s.dbPath).equals(before)).toBe(true);
  });

  it('nieudana kwarantanna wstrzymuje odbudowe takze na prawdziwym pliku', () => {
    const s = setup();
    writeFileSync(s.dbPath, 'to nie jest baza sqlite', 'utf8');
    const open = vi.fn(s.open);
    const result = startIndex({
      openStore: open,
      quarantine: () => {
        throw new Error('brak miejsca na dysku');
      },
      describeFailure: s.describeFailure,
    });

    expect(result.info.outcome).toBe('refused');
    expect(open).toHaveBeenCalledOnce();
    expect(readFileSync(s.dbPath, 'utf8')).toBe('to nie jest baza sqlite');
  });
});
