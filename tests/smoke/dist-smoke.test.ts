import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { createTempTree, removeTempTrees } from '../harness/isolation';

/**
 * Dowod, ze paczka dystrybucyjna uruchamia sie po instalacji (ROADMAP Etap 9 kryterium 6).
 * Ta sama metoda co tests/e2e/packaged-db.spec.ts, ale na artefakcie z `electron-builder`
 * (DMG, instalator NSIS, deb) po instalacji tak, jak zrobilby to uzytkownik, a nie na `--dir`.
 *
 * Czarna skrzynka (ARCHITECTURE 12.6): binarka startuje bez protokolu debugowania, a dowodem
 * jest stan na dysku. Rejestr migracji w `index.db` powstaje tylko wtedy, gdy proces glowny
 * wystartowal z paczki, zaladowal `better-sqlite3` z `app.asar.unpacked` i wykonal zapis.
 */

const executable = process.env['CWM_DIST_EXECUTABLE'];
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 250;
/** Cztery migracje: rejestr, log operacji, stan synchronizacji, indeks biblioteki. */
const EXPECTED = [1, 2, 3, 4];

afterAll(() => {
  removeTempTrees();
});

function ledger(dbPath: string): number[] | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    return rows.map((r) => r.version);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function startOnce(userData: string): Promise<{ versions: number[]; exitedEarly: boolean }> {
  // Jak w tests/e2e/launch.ts: NODE_OPTIONS i ELECTRON_RUN_AS_NODE z procesu testu nie wchodza.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete env['NODE_OPTIONS'];
  delete env['ELECTRON_RUN_AS_NODE'];
  const child = spawn(executable as string, [`--user-data-dir=${userData}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '';
  let exitedEarly = false;
  child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
  child.once('exit', () => {
    exitedEarly = true;
  });
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let versions: number[] | null = null;
    while (Date.now() < deadline) {
      versions = ledger(join(userData, 'index.db'));
      if (versions !== null && versions.length >= EXPECTED.length) return { versions, exitedEarly };
      if (exitedEarly) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `paczka nie zalozyla schematu w ${READY_TIMEOUT_MS} ms (rejestr: ${JSON.stringify(versions)}, proces zakonczony: ${exitedEarly})\n${output}`,
    );
  } finally {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    if (!exitedEarly) await gone;
  }
}

describe('paczka dystrybucyjna po instalacji (Etap 9 kryterium 6)', () => {
  it('binarka z artefaktu startuje, laduje modul natywny i zaklada schemat; drugi start go nie dubluje', async () => {
    // Bez zmiennej test pada zamiast sie pomijac: pominiety dowod niczego nie dowodzi.
    expect(executable, 'brak CWM_DIST_EXECUTABLE').toBeTruthy();
    expect(existsSync(executable as string), executable).toBe(true);

    const userData = createTempTree('acme-dist-');
    const first = await startOnce(userData);
    expect(first.exitedEarly).toBe(false);
    expect(first.versions).toEqual(EXPECTED);

    const second = await startOnce(userData);
    expect(second.versions).toEqual(EXPECTED);

    // Procesy pomocnicze Chromium koncza sie chwile po glownym i jeszcze pisza do userData
    // (ENOTEMPTY przy sprzataniu na Linuksie), wiec katalog znika z ponowieniami.
    rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
});
