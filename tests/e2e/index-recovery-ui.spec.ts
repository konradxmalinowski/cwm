import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, test, type Page } from '@playwright/test';

import { createTempTree, removeTempTrees } from '../harness/isolation';
import { launchAppWithHome, launchAppWithUserData } from './launch';

/**
 * Kryterium 4 Etapu 2 od strony tresci widoku: `index-startup.spec.ts` sprawdza, ze okno
 * powstaje i co mowi raport, ten plik sprawdza, co zobaczy uzytkownik. Pasek startu mowi, co
 * sie stalo, odbudowa pokazuje liczbe elementow i liste nieodzyskanych rzeczy, a odmowa pokazuje
 * powod i jedyna droge (reczna odbudowa w Diagnostyce, ADR 0029 i 0030).
 *
 * Reczna odbudowa ma dwa testy, z ktorych dokladnie jeden sie wykonuje: kanaly z ADR 0030 maja
 * handlery po stronie main albo jeszcze ich nie maja. Brak handlera sprawdza stan bledu w UI,
 * obecnosc sprawdza caly przeplyw. Pominiecie jest jawne i ma powod w raporcie.
 */

interface IndexReport {
  index: {
    outcome: string;
    quarantinedAs?: string;
    restoredItems?: number;
    notRestored?: string[];
  };
}

test.afterAll(() => {
  removeTempTrees();
});

async function indexReport(page: Page): Promise<IndexReport> {
  return (await page.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['uasm'] as {
      diagnostics: { report: () => Promise<unknown> };
    };
    return bridge.diagnostics.report();
  })) as IndexReport;
}

async function hasRebuildChannels(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (globalThis as Record<string, unknown>)['uasm'] as {
      diagnostics: Record<string, unknown>;
    };
    return (
      typeof bridge.diagnostics['rebuildIndexPlan'] === 'function' &&
      typeof bridge.diagnostics['rebuildIndexApply'] === 'function'
    );
  });
}

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

/** Indeks zapisany przez "nowsza wersje aplikacji": jedyny wpis w migracjach ma wersje 99. */
function seedFutureIndex(userDataDir: string): string {
  const dbPath = join(userDataDir, 'index.db');
  const seed = new Database(dbPath);
  seed.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  seed
    .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(99, new Date().toISOString());
  seed.close();
  return dbPath;
}

test('uszkodzony indeks: pasek mowi, co sie stalo, ile elementow wczytano i czego nie odzyskano', async () => {
  test.setTimeout(120_000);

  const userData = createTempTree('acme-userdata-');
  const home = createTempTree('acme-home-');

  // Pierwsze uruchomienie tworzy w bibliotece element, zeby odbudowa miala co liczyc.
  const first = await launchAppWithHome(home, userData);
  try {
    await openRoute(first.page, '#/biblioteka/nowy');
    await first.page.locator('#field-slug').fill('acme-recovery-item');
    await first.page.locator('#field-title').fill('Acme element do odbudowy');
    await first.page.locator('#field-description').fill('Element, ktory ma przetrwac odbudowe.');
    await first.page.locator('#field-body').fill('Tresc elementu do odbudowy indeksu.\n');
    await first.page.click('[data-testid="save"]');
    await first.page.waitForSelector('[data-testid="flash"]');
  } finally {
    await first.app.close();
  }

  // Indeks przestaje byc baza SQLite; pliki WAL zostalyby z poprzedniego procesu.
  for (const name of ['index.db-wal', 'index.db-shm']) {
    rmSync(join(userData, name), { force: true });
  }
  writeFileSync(join(userData, 'index.db'), 'to nie jest baza sqlite', 'utf8');

  const { app, page } = await launchAppWithHome(home, userData);
  try {
    const report = await indexReport(page);
    expect(report.index.outcome).toBe('rebuilt');
    const restored = report.index.restoredItems ?? -1;
    expect(restored, 'raport podaje liczbe wczytanych elementow').toBeGreaterThanOrEqual(0);

    const banner = page.locator('[data-testid="startup-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Indeks odbudowany.');
    await expect(banner).toContainText('Indeks był uszkodzony.');
    await expect(banner).toContainText('odłożyła stary plik do kwarantanny');

    // Liczba w pasku to liczba z raportu, a zero nie wyglada na sukces.
    if (restored === 0) {
      await expect(banner).toContainText('Nie wczytano żadnego elementu.');
      await expect(banner).toContainText('To nie potwierdza, że biblioteka jest pusta');
    } else {
      await expect(banner).toContainText(`Wczytano elementów: ${restored}.`);
      await expect(banner).not.toContainText('To nie potwierdza');
    }

    // Lista nieodzyskanych rzeczy: log operacji zawsze, plus to, co podal main.
    await expect(banner).toContainText('Nie odzyskano:');
    const lost = banner.locator('.notice__list li');
    await expect(lost.first()).toContainText('Log operacji');
    expect(await lost.count()).toBe(1 + (report.index.notRestored?.length ?? 0));

    // Stary indeks lezy w katalogu kwarantanny, a pasek nie pokazuje sciezki bezwzglednej.
    // `quarantinedAs` w raporcie to dzis etykieta katalogu, a nie nazwa pliku.
    const quarantined = report.index.quarantinedAs;
    expect(quarantined).toBeDefined();
    const quarantineLabel = String(quarantined).split(/[\\/]/).pop() as string;
    expect(readdirSync(join(userData, 'quarantine'))).toHaveLength(1);
    expect(await banner.innerText()).not.toContain(userData);

    // Diagnostyka powtarza te same fakty.
    await openRoute(page, '#/diagnostyka');
    const diagnostics = page.locator('[data-testid="diagnostics-report"]');
    await expect(diagnostics).toContainText('Odbudowa indeksu');
    await expect(diagnostics).toContainText(quarantineLabel);
    await expect(diagnostics).toContainText('Log operacji');
  } finally {
    await app.close();
  }
});

test('indeks z przyszlosci: pasek i Diagnostyka podaja powod i wskazuja reczna odbudowe jako jedyne wyjscie', async () => {
  test.setTimeout(120_000);

  const userData = createTempTree('acme-userdata-');
  seedFutureIndex(userData);

  const { app, page } = await launchAppWithUserData(userData);
  try {
    const banner = page.locator('[data-testid="startup-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Odmowa startu.');
    await expect(banner).toContainText('Indeks zapisała nowsza wersja aplikacji.');
    await expect(banner).toContainText('Indeks nie został zmieniony');
    await expect(banner.locator('[data-testid="banner-rebuild-hint"]')).toContainText(
      'jedyne wyjście to ręczna odbudowa indeksu w Diagnostyce',
    );
    await expect(banner).not.toContainText('Indeks odbudowany.');

    await banner.getByRole('link', { name: 'Odbuduj indeks w Diagnostyce' }).click();
    const diagnostics = page.locator('[data-testid="diagnostics-report"]');
    await expect(diagnostics).toBeVisible();
    await expect(diagnostics).toContainText('Odmowa startu');
    await expect(diagnostics).toContainText('Indeks zapisała nowsza wersja aplikacji.');
    await expect(diagnostics.locator('[data-testid="rebuild-only-exit"]')).toContainText(
      'Jedyne wyjście bez nowszej wersji aplikacji',
    );
    await expect(diagnostics.locator('[data-testid="rebuild-open"]')).toBeEnabled();
  } finally {
    await app.close();
  }
});

test('reczna odbudowa bez handlerow w main: Diagnostyka pokazuje blad i pozwala sprobowac ponownie', async () => {
  test.setTimeout(120_000);

  const userData = createTempTree('acme-userdata-');
  seedFutureIndex(userData);

  const { app, page } = await launchAppWithUserData(userData);
  try {
    test.skip(
      await hasRebuildChannels(page),
      'kanaly odbudowy (ADR 0030) sa w main: ten stan sprawdza test pelnego przeplywu',
    );

    await openRoute(page, '#/diagnostyka');
    await page.click('[data-testid="rebuild-open"]');
    const error = page.locator('[data-testid="rebuild-error"]');
    await expect(error).toContainText('Błąd.');
    await expect(error).toContainText('Nie udało się przygotować planu odbudowy.');
    await expect(page.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible();
    await expect(page.locator('[data-testid="rebuild-apply"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('reczna odbudowa z Diagnostyki: plan, potwierdzenie utraty, wynik z zerem jako wynikiem niepelnym', async () => {
  test.setTimeout(120_000);

  const userData = createTempTree('acme-userdata-');
  const dbPath = seedFutureIndex(userData);

  const { app, page } = await launchAppWithUserData(userData);
  try {
    test.skip(
      !(await hasRebuildChannels(page)),
      'brak kanalow odbudowy (ADR 0030) w main: stan bledu sprawdza osobny test',
    );

    await openRoute(page, '#/diagnostyka');
    await page.click('[data-testid="rebuild-open"]');

    // Plan: nazwa pliku w kwarantannie, liczba elementow, jawna lista strat.
    const plan = page.locator('[data-testid="rebuild-plan"]');
    await expect(plan).toBeVisible();
    const quarantineName = (
      await plan.locator('[data-testid="rebuild-quarantine"]').innerText()
    ).trim();
    expect(quarantineName.length).toBeGreaterThan(0);
    expect(quarantineName).not.toContain(userData);
    await expect(plan.locator('[data-testid="rebuild-items"]')).toContainText('0');
    await expect(plan.locator('[data-testid="rebuild-unrecoverable"] li').first()).toContainText(
      /log operacji/i,
    );

    // Bez zaznaczenia nie da sie wykonac, a indeks na dysku zostaje nietkniety.
    const apply = page.locator('[data-testid="rebuild-apply"]');
    await expect(apply).toBeDisabled();
    expect(existsSync(dbPath)).toBe(true);

    await page.locator('[data-testid="rebuild-confirm"]').check();
    await expect(apply).toBeEnabled();
    await apply.click();

    // Pusta biblioteka: zero odtworzonych elementow to wynik niepelny, nie sukces.
    const result = page.locator('[data-testid="rebuild-result"]');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result).toHaveAttribute('data-outcome', 'incomplete');
    await expect(result).toContainText('Odbudowa niepełna.');
    await expect(result.locator('[data-testid="rebuild-restored"]')).toContainText(
      'Nie odtworzono żadnego elementu.',
    );
    await expect(result).toContainText('To nie potwierdza, że biblioteka jest pusta');
    await expect(result.locator('[data-testid="rebuild-lost"] li').first()).toContainText(
      /log operacji/i,
    );
    await expect(result).not.toContainText('Indeks odbudowany.');

    // Stary plik jest w kwarantannie pod nazwa z planu.
    expect(readdirSync(join(userData, 'quarantine'))).toContain(quarantineName);
  } finally {
    await app.close();
  }
});
