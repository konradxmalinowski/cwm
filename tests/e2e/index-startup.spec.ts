import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';

import type {
  RebuildIndexApplyResult,
  RebuildIndexPlanDto,
  RebuildIndexPlanResult,
} from '../../src/shared/ipc/diagnostics-contract';
import type { LibraryListDto, Result } from '../../src/shared/ipc/library-contract';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { launchAppWithUserData } from './launch';
import { seedLibrary } from './seed-library';

interface Report {
  database: { status: string; reason?: string };
  index: {
    outcome: string;
    reason?: string;
    message?: string;
    quarantinedAs?: string;
    restoredItems?: number;
    notRestored?: string[];
  };
}

async function readReport(page: import('@playwright/test').Page): Promise<Report> {
  return (await page.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['uasm'] as {
      diagnostics: { report: () => Promise<unknown> };
    };
    return bridge.diagnostics.report();
  })) as Report;
}

test.afterAll(() => {
  removeTempTrees();
});

/**
 * ADR 0029 punkt 3: okno nie zalezy od indeksu. Odmowa startu to nie brak
 * okna, tylko okno pokazujace powod - a tego nie da sie spelnic, jesli okno
 * powstaje po otwarciu indeksu. Te testy sa jedynym miejscem, ktore sprawdza
 * te kolejnosc od zewnatrz: podstawiaja zepsuty indeks jeszcze przed startem
 * i wymagaja, zeby okno bylo.
 */
test('okno powstaje, gdy indeks jest uszkodzony, a indeks jest odbudowywany', async () => {
  const userDataDir = createTempTree('acme-index-');
  mkdirSync(userDataDir, { recursive: true });
  // Plik, ktory nie jest baza SQLite: przyczyna "corrupted", czyli odbudowa.
  writeFileSync(join(userDataDir, 'index.db'), 'to nie jest baza sqlite', 'utf8');

  const { app, page } = await launchAppWithUserData(userDataDir);
  try {
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();

    const report = await readReport(page);
    expect(report.index.outcome).toBe('rebuilt');
    expect(report.index.quarantinedAs).toBeDefined();
    expect(report.index.restoredItems).toBe(0);
    expect(report.index.notRestored?.join(' ')).toMatch(/log operacji/);
    expect(report.database.status).toBe('ok');
  } finally {
    await app.close();
  }
});

test('okno powstaje takze przy odmowie: indeks ze schematem z przyszlosci nie jest odbudowywany', async () => {
  const userDataDir = createTempTree('acme-index-');
  mkdirSync(userDataDir, { recursive: true });
  const dbPath = join(userDataDir, 'index.db');

  const seed = new Database(dbPath);
  seed.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  seed
    .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(99, new Date().toISOString());
  seed.close();

  const { app, page } = await launchAppWithUserData(userDataDir);
  try {
    // Okno jest, choc indeksu nie ma - to jest cala teza ADR 0029 punkt 3.
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();

    const report = await readReport(page);
    expect(report.index.outcome).toBe('refused');
    expect(report.index.reason).toBe('schema-from-future');
    expect(report.database.status).toBe('unavailable');

    // Asercja negatywna z ADR 0029: indeks z przyszlosci NIE jest odbudowywany,
    // bo odbudowa wyrzucilaby log operacji.
    const ledger = new Database(dbPath, { readonly: true });
    try {
      const rows = ledger
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      expect(rows.map((row) => row.version)).toEqual([99]);
    } finally {
      ledger.close();
    }
  } finally {
    await app.close();
  }
});

type Page = import('@playwright/test').Page;

async function invoke<T>(page: Page, path: string, payload?: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ path: target, payload: body }) => {
      const bridge = (globalThis as Record<string, unknown>)['uasm'] as Record<
        string,
        Record<string, (arg?: unknown) => Promise<unknown>>
      >;
      const [namespace, member] = target.split('.') as [string, string];
      return bridge[namespace]![member]!(body);
    },
    { path, payload },
  )) as T;
}

async function listSlugs(page: Page, query?: string): Promise<string[]> {
  const result = await invoke<Result<LibraryListDto>>(
    page,
    'library.list',
    query === undefined ? {} : { query },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value.items.map((item) => item.slug).sort();
}

test('odbudowa uszkodzonego indeksu wczytuje biblioteke z plikow i podaje prawdziwa liczbe', async () => {
  const userDataDir = createTempTree('acme-index-');
  const seeded = await seedLibrary(userDataDir);
  writeFileSync(join(userDataDir, 'index.db'), 'to nie jest baza sqlite', 'utf8');

  const { app, page } = await launchAppWithUserData(userDataDir);
  try {
    const report = await readReport(page);
    expect(report.index.outcome).toBe('rebuilt');
    expect(report.index.restoredItems).toBe(seeded.length);
    // Kontrakt: nazwa pliku w kwarantannie, nie etykieta katalogu.
    expect(report.index.quarantinedAs).toMatch(/^index-.+\.sqlite$/);
    expect(readdirSync(join(userDataDir, 'quarantine'))).toContain(report.index.quarantinedAs);
    const lost = report.index.notRestored?.join(' ') ?? '';
    expect(lost).toMatch(/log operacji/);
    expect(lost).toMatch(/stan synchronizacji/);

    expect(await listSlugs(page, 'znacznikfts')).toEqual(['acme-lodz']);
    expect(await listSlugs(page, 'przeglad')).toEqual(['acme-przeglad']);
  } finally {
    await app.close();
  }
});

test('kryterium 2: usuniecie index.db i restart odtwarzaja indeks z plikow bez utraty danych', async () => {
  const userDataDir = createTempTree('acme-index-');
  const seeded = await seedLibrary(userDataDir);

  const first = await launchAppWithUserData(userDataDir);
  try {
    expect(await listSlugs(first.page, 'acme')).toHaveLength(seeded.length);
  } finally {
    await first.app.close();
  }

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(userDataDir, `index.db${suffix}`), { force: true });
  }
  expect(existsSync(join(userDataDir, 'index.db'))).toBe(false);

  const second = await launchAppWithUserData(userDataDir);
  try {
    const report = await readReport(second.page);
    expect(report.index.outcome).toBe('ready');
    expect(report.database.status).toBe('ok');
    expect(await listSlugs(second.page, 'acme')).toEqual(seeded.map((i) => i.slug).sort());
    expect(await listSlugs(second.page, 'znacznikfts')).toEqual(['acme-lodz']);
    expect(await listSlugs(second.page)).toHaveLength(seeded.length);
  } finally {
    await second.app.close();
  }
});

test('reczna odbudowa przez dwa kanaly jest wyjsciem ze schematu z przyszlosci', async () => {
  const userDataDir = createTempTree('acme-index-');
  const seeded = await seedLibrary(userDataDir);
  const dbPath = join(userDataDir, 'index.db');

  const seed = new Database(dbPath);
  seed.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  seed
    .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(99, new Date().toISOString());
  seed.close();

  const { app, page } = await launchAppWithUserData(userDataDir);
  try {
    expect((await readReport(page)).index.outcome).toBe('refused');

    const planResult = await invoke<RebuildIndexPlanResult>(page, 'diagnostics.rebuildIndexPlan', {
      path: '/etc/passwd',
    });
    if (!planResult.ok) throw new Error(planResult.error.message);
    const plan: RebuildIndexPlanDto = planResult.value;
    expect(plan.currentOutcome).toBe('refused');
    expect(plan.recoverability).toBe('recoverable');
    expect(plan.itemsToRestore).toBe(seeded.length);
    expect(plan.notRecoverable.join(' ')).toMatch(/log operacji/);
    expect(plan.quarantineName).toMatch(/^index-.+\.sqlite$/);

    const refused = await invoke<RebuildIndexApplyResult>(page, 'diagnostics.rebuildIndexApply', {
      planId: plan.planId,
      confirmed: false,
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('confirmation-required');

    const applied = await invoke<RebuildIndexApplyResult>(page, 'diagnostics.rebuildIndexApply', {
      planId: plan.planId,
      confirmed: true,
      path: '/etc',
    });
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.value.restoredItems).toBe(seeded.length);
    expect(applied.value.quarantineName).toBe(plan.quarantineName);

    const after = await readReport(page);
    expect(after.index.outcome).toBe('rebuilt');
    expect(after.database.status).toBe('ok');
    expect(await listSlugs(page, 'znacznikfts')).toEqual(['acme-lodz']);

    // Stary plik lezy w kwarantannie, a zadne zrodlo prawdy poza indeksem nie ucierpialo.
    expect(readdirSync(join(userDataDir, 'quarantine'))).toContain(plan.quarantineName);

    const check = new Database(dbPath, { readonly: true });
    try {
      const log = check
        .prepare("SELECT operation, note FROM operation_log WHERE operation = 'rebuild-index'")
        .all() as { operation: string; note: string }[];
      expect(log).toHaveLength(1);
      expect(log[0]?.note).toContain(plan.quarantineName);
    } finally {
      check.close();
    }
  } finally {
    await app.close();
  }
});
