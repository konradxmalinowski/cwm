import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createTempTree, removeTempTrees } from '../harness/isolation';
import { launchAppWithHome } from './launch';

/**
 * Kryterium 1 Etapu 2: tworzenie, edycja, wyszukiwanie i usuwanie elementu przez interfejs.
 * Interfejs prowadzi przeplyw, a asercje o produkcie stoja na dysku: katalog elementu w
 * `userData/library/items` powstaje i znika, a kopia zostaje w `userData/objects`.
 *
 * Wyszukiwanie szuka slowa, ktore jest tylko w tresci (nie w tytule, slugu ani opisie), wiec
 * dziala identycznie na FTS i na filtrze awaryjnym. Test nie zaklada, ktory z nich odpowiada.
 */

const BODY_ONLY_WORD = 'zebrawordacme';
const EDIT_MARKER = 'poprawka-e2e-acme';

test.afterAll(() => {
  removeTempTrees();
});

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

function itemDirs(userData: string): string[] {
  const dir = join(userData, 'library', 'items');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function createItem(
  page: Page,
  fields: { slug: string; title: string; description: string; body: string },
): Promise<string> {
  await openRoute(page, '#/biblioteka/nowy');
  await page.locator('#field-slug').fill(fields.slug);
  await page.locator('#field-title').fill(fields.title);
  await page.locator('#field-description').fill(fields.description);
  await page.locator('#field-body').fill(fields.body);
  await page.click('[data-testid="save"]');
  await page.waitForSelector('[data-testid="flash"]');
  const id = await page.evaluate(() => window.location.hash.split('/')[2] ?? '');
  expect(id, 'po zapisie adres wskazuje na nowy element').not.toBe('');
  return decodeURIComponent(id);
}

test('tworzenie, edycja, wyszukiwanie po tresci i usuniecie z potwierdzeniem zostawiaja slad na dysku', async () => {
  test.setTimeout(120_000);

  const userData = createTempTree('acme-userdata-');
  const { app, page } = await launchAppWithHome(createTempTree('acme-home-'), userData);

  try {
    expect(itemDirs(userData), 'swieza biblioteka jest pusta').toEqual([]);

    // 1. Tworzenie: dwa elementy, tylko pierwszy ma slowo w tresci.
    const wantedId = await createItem(page, {
      slug: 'acme-e2e-wanted',
      title: 'Acme notatka pierwsza',
      description: 'Element tworzony przez interfejs w tescie E2E.',
      body: `Tresc pierwszego elementu zawiera slowo ${BODY_ONLY_WORD} i nic wiecej.\n`,
    });
    const otherId = await createItem(page, {
      slug: 'acme-e2e-other',
      title: 'Acme notatka druga',
      description: 'Drugi element, bez szukanego slowa.',
      body: 'Zupelnie inna tresc drugiego elementu.\n',
    });

    expect(itemDirs(userData)).toEqual([wantedId, otherId].sort());
    const wantedDir = join(userData, 'library', 'items', wantedId);
    expect(readFileSync(join(wantedDir, 'item.json'), 'utf8')).toContain('acme-e2e-wanted');
    expect(readFileSync(join(wantedDir, 'body.md'), 'utf8')).toContain(BODY_ONLY_WORD);
    const objectsAfterCreate = countFiles(join(userData, 'objects'));
    expect(objectsAfterCreate, 'zapis odklada wersje w objects/').toBeGreaterThan(0);

    // 2. Edycja: zmiana tresci widoczna w interfejsie i na dysku.
    await openRoute(page, `#/biblioteka/${wantedId}/edycja`);
    const body = page.locator('#field-body');
    await body.waitFor();
    await body.fill(`${await body.inputValue()}${EDIT_MARKER}\n`);
    await page.click('[data-testid="save"]');
    await page.waitForSelector('[data-testid="flash"]');
    await expect(page.locator('[data-testid="item-body"]')).toContainText(EDIT_MARKER);
    expect(readFileSync(join(wantedDir, 'body.md'), 'utf8')).toContain(EDIT_MARKER);
    expect(countFiles(join(userData, 'objects'))).toBeGreaterThan(objectsAfterCreate);

    // 3. Wyszukiwanie po slowie z tresci: znajduje jeden element, drugi znika z listy.
    await openRoute(page, '#/biblioteka');
    const query = page.locator('#library-query');
    await query.waitFor();
    await query.fill(BODY_ONLY_WORD);
    await expect(page.locator('[data-row-link]')).toHaveCount(1);
    await expect(page.locator(`[data-row-link][data-item-id="${wantedId}"]`)).toBeVisible();

    await query.fill('slowo-ktorego-nie-ma-nigdzie-acme');
    await expect(page.locator('[data-testid="library-no-match"]')).toBeVisible();
    await expect(page.locator('[data-row-link]')).toHaveCount(0);

    await query.fill('');
    await expect(page.locator('[data-row-link]')).toHaveCount(2);

    // 4. Usuniecie z potwierdzeniem: Anuluj niczego nie rusza, potwierdzenie usuwa katalog.
    await openRoute(page, `#/biblioteka/${wantedId}`);
    await page.click('[data-testid="delete-open"]');
    await page.waitForSelector('[data-testid="delete-dialog"][open]');
    await expect(page.locator('[data-testid="confirm-delete"]')).toBeVisible();
    await page.getByRole('button', { name: 'Anuluj' }).click();
    await expect(page.locator('[data-testid="delete-dialog"][open]')).toHaveCount(0);
    expect(existsSync(wantedDir), 'anulowanie nie usuwa elementu').toBe(true);

    const objectsBeforeDelete = countFiles(join(userData, 'objects'));
    await page.click('[data-testid="delete-open"]');
    await page.waitForSelector('[data-testid="delete-dialog"][open]');
    await page.click('[data-testid="confirm-delete"]');
    await expect(page.locator('[data-testid="delete-dialog"][open]')).toHaveCount(0);

    await expect.poll(() => existsSync(wantedDir), { timeout: 15_000 }).toBe(false);
    expect(itemDirs(userData), 'zostal tylko drugi element').toEqual([otherId]);
    expect(
      countFiles(join(userData, 'objects')),
      'kopia usunietego elementu zostaje w objects/',
    ).toBeGreaterThanOrEqual(objectsBeforeDelete);

    await openRoute(page, '#/biblioteka');
    await expect(page.locator('[data-row-link]')).toHaveCount(1);
    await expect(page.locator(`[data-row-link][data-item-id="${otherId}"]`)).toBeVisible();
  } finally {
    await app.close();
  }
});
