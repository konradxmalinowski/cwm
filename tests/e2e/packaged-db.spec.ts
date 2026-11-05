import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';

import { createTempTree, removeTempTrees } from '../harness/isolation';
import { packagedExecutable } from './launch';
import { seedLibrary } from './seed-library';

/**
 * Dowod na ryzyko R2, oddzielony od narzedzia, ktorym go zdobywamy.
 *
 * Teza do udowodnienia brzmi: `better-sqlite3` laduje sie z `app.asar.unpacked`
 * w zapakowanej aplikacji i wykonuje zapytania. Teza NIE brzmi: Playwright
 * potrafi przylaczyc sie przez protokol debugowania do zapakowanego Electrona.
 * Do tej pory pierwsze zalezalo od drugiego, a drugie zawodzi losowo - zawis
 * `electron.launch` odtworzyl sie lokalnie na macOS, wiec nie jest wlasciwoscia
 * runnera Windows.
 *
 * Tutaj nie ma protokolu debugowania ani okna. Zapakowana binarka jest
 * uruchamiana jak uruchomilby ja uzytkownik, a dowodem jest to, co zostawila na
 * dysku: baza z rejestrem migracji. Zeby ten rejestr powstal, w zapakowanej
 * aplikacji musi sie zaladowac modul natywny i wykonac CREATE TABLE oraz
 * INSERT. Odczyt robi test wlasnym `better-sqlite3`, z zewnatrz.
 */

const executable = packagedExecutable();
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

interface MigrationRow {
  readonly version: number;
  readonly applied_at: string;
}

function readLedger(dbPath: string): MigrationRow[] | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as MigrationRow[];
  } catch {
    // Plik moze byc w trakcie zapisu albo schemat jeszcze nie istnieje.
    return null;
  } finally {
    db?.close();
  }
}

async function waitForLedger(dbPath: string): Promise<MigrationRow[]> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ledger = readLedger(dbPath);
    if (ledger !== null && ledger.length > 0) return ledger;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `zapakowana aplikacja nie zalozyla schematu w ${dbPath} w ${READY_TIMEOUT_MS} ms`,
  );
}

/**
 * Czeka, az zapakowana aplikacja wypelni indeks biblioteki z plikow. Rejestr migracji powstaje
 * wczesniej, wiec jego obecnosc nie dowodzi jeszcze, ze wpisy FTS zostaly zapisane.
 */
function readIndexedSlugs(dbPath: string, ftsQuery: string): string[] | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT items.slug AS slug FROM items_fts JOIN items ON items.seq = items_fts.rowid
         WHERE items_fts MATCH ? ORDER BY items.slug`,
      )
      .all(ftsQuery) as { slug: string }[];
    return rows.map((row) => row.slug);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function waitForIndexedItems(dbPath: string, expected: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((readIndexedSlugs(dbPath, 'acme*')?.length ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`zapakowana aplikacja nie wypelnila indeksu biblioteki w ${READY_TIMEOUT_MS} ms`);
}

async function runPackagedOnce(userDataDir: string, untilIndexed = 0): Promise<{ output: string }> {
  const child: ChildProcess = spawn(executable as string, [`--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  try {
    await waitForLedger(join(userDataDir, 'index.db'));
    if (untilIndexed > 0) await waitForIndexedItems(join(userDataDir, 'index.db'), untilIndexed);
    return { output };
  } catch (error: unknown) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nwyjscie procesu:\n${output}`,
      { cause: error },
    );
  } finally {
    child.kill('SIGKILL');
  }
}

test.afterAll(() => {
  removeTempTrees();
});

test.describe('zapakowana aplikacja, dowod przez stan na dysku', () => {
  test.skip(executable === null, 'brak paczki probnej - uruchom najpierw `npm run package`');

  test('laduje modul natywny i wykonuje zapytania przy zwyklym starcie', async () => {
    const userDataDir = createTempTree('acme-packaged-db-');
    await runPackagedOnce(userDataDir);

    const ledger = readLedger(join(userDataDir, 'index.db'));
    expect(ledger).not.toBeNull();
    // Cztery migracje (rejestr, log operacji, stan synchronizacji, indeks biblioteki) musza przyjsc z paczki.
    expect(ledger?.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    // Data w rejestrze dowodzi, ze wykonal sie INSERT, a nie tylko CREATE TABLE.
    expect(Number.isNaN(Date.parse(ledger?.[0]?.applied_at ?? ''))).toBe(false);
  });

  test('drugi start nie duplikuje wpisu w rejestrze migracji', async () => {
    const userDataDir = createTempTree('acme-packaged-db-');

    await runPackagedOnce(userDataDir);
    const afterFirst = readLedger(join(userDataDir, 'index.db'));

    await runPackagedOnce(userDataDir);
    const afterSecond = readLedger(join(userDataDir, 'index.db'));

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond).toHaveLength(4);
  });

  /**
   * Kryterium 7 Etapu 2: zapytanie FTS na prawdziwej tabeli pelnotekstowej biblioteki, po
   * zapisie wykonanym przez zapakowana aplikacje. Biblioteka lezy na dysku bez indeksu, wiec
   * paczka sama tworzy `items_fts` (migracja 4) i wypelnia ja z plikow; test czyta stan na dysku
   * i odpytuje FTS5, tak jak przy rejestrze migracji. Wpisy w `items_fts` mogly powstac tylko
   * tak, ze w paczce zaladowal sie modul natywny z FTS5 i wykonal INSERT do tabeli wirtualnej.
   */
  test('FTS5 w paczce: tabela items_fts jest wypelniona z plikow i odpowiada na zapytania', async () => {
    const userDataDir = createTempTree('acme-packaged-fts-');
    const seeded = await seedLibrary(userDataDir);
    const dbPath = join(userDataDir, 'index.db');

    await runPackagedOnce(userDataDir, seeded.length);

    // Dopasowanie prefiksowe, bez rozrozniania wielkosci liter i znakow diakrytycznych.
    expect(readIndexedSlugs(dbPath, 'acme*')).toEqual(seeded.map((item) => item.slug).sort());
    expect(readIndexedSlugs(dbPath, 'przeglad*')).toEqual(['acme-przeglad']);
    expect(readIndexedSlugs(dbPath, 'lodzki*')).toEqual(['acme-lodz']);
    expect(readIndexedSlugs(dbPath, 'znacznikfts')).toEqual(['acme-lodz']);
    expect(readIndexedSlugs(dbPath, 'nieistniejace*')).toEqual([]);
  });

  test('binding w paczce jest tym samym plikiem, ktory laduje test, a FTS5 w nim dziala', () => {
    const packagedRoot = join(dirname(executable as string), '..', 'Resources');
    const candidates = [
      join(
        packagedRoot,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        `${process.platform}-${process.arch}.node`,
      ),
      join(
        dirname(executable as string),
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        `${process.platform}-${process.arch}.node`,
      ),
    ];

    const shipped = candidates.find((candidate) => existsSync(candidate));
    expect(
      shipped,
      `nie znalazlem bindingu natywnego w paczce, sprawdzane sciezki:\n${candidates.join('\n')}`,
    ).toBeDefined();

    const local = join(
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      `${process.platform}-${process.arch}.node`,
    );
    const hash = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex');

    expect(hash(shipped as string)).toBe(hash(local));

    // Probka na pamieci zostaje jako dodatkowy dowod, ze ten sam binding obsluguje FTS5 w procesie testu.
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE acme_fts USING fts5(body);');
      db.exec("INSERT INTO acme_fts (body) VALUES ('acme probe row');");
      const matched = db
        .prepare("SELECT count(*) AS total FROM acme_fts WHERE acme_fts MATCH 'acme'")
        .get() as { total: number } | undefined;
      expect(matched?.total).toBe(1);
    } finally {
      db.close();
    }
  });
});
