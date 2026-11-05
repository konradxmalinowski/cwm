import { cpSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createTempTree, removeTempTrees } from '../harness/isolation';
import { launchAppWithHome } from './launch';

/**
 * Kryterium 5 Etapu 4, strona widoczna: tryb materializacji jest w planie eksportu przy kazdym
 * wpisie, razem z wyjasnieniem, co znaczy dla edycji w bibliotece (ADR 0015). Poprawnosc samych
 * dowiazan per system sprawdzaja testy integracyjne `link-mode` i `write-gate-link`; ten test
 * sprawdza, co przeczyta uzytkownik, i ze zapis na dysku zgadza sie z tym, co plan obiecal.
 *
 * Skill to katalog, wiec na macOS i Linuksie plan obiecuje dowiazanie symboliczne. Windows moze
 * dac dowiazanie, junction albo kopie zaleznie od uprawnien runnera, wiec tam test przyjmuje
 * kazdy z trzech trybow, ale wymaga, zeby wyjasnienie pasowalo do tego, ktory plan pokazal.
 */

const SLUG = 'acme-plain';

const EFFECT_PROPAGATES = 'Zmiany propagują się automatycznie.';
const EFFECT_COPY = 'Wymaga ponownej synchronizacji po zmianie w bibliotece.';

test.afterAll(() => {
  removeTempTrees();
});

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

test('plan eksportu pokazuje tryb materializacji skilla i jego skutek dla edycji', async () => {
  test.setTimeout(120_000);

  const home = createTempTree('acme-home-');
  cpSync('tests/fixtures/claude-code/home', home, { recursive: true });
  // Katalog Codeksa jest pusty: eksport ma tu nowy skill, a nie konflikt z fixture'em.
  mkdirSync(join(home, '.codex'), { recursive: true });
  const codexSkill = join(home, '.codex', 'skills', SLUG);

  const { app, page } = await launchAppWithHome(home, createTempTree('acme-userdata-'));

  try {
    // Import skilla z Claude Code; katalog Codeksa zostaje, ale nie jest skanowany.
    await openRoute(page, '#/import');
    await page.waitForSelector('[data-testid="import-scan"]');
    const codexRoots = page.locator('[data-testid="tool-codex"] input[type="checkbox"]');
    for (let i = 0; i < (await codexRoots.count()); i++) {
      await codexRoots.nth(i).setChecked(false);
    }
    await page.click('[data-testid="import-scan"]');
    await page.waitForSelector('[data-testid="candidate"]');
    await page.click('[data-testid="import-apply"]');
    await page.waitForSelector('[data-testid="import-result"]', { timeout: 30_000 });

    // Plan eksportu skilla do Codeksa.
    await openRoute(page, '#/eksport');
    await page.waitForSelector('[data-testid="export-items"]');
    await page.locator(`[data-testid="export-item"][data-slug="${SLUG}"] input`).first().check();
    await page.locator('[data-testid="export-tool-codex"]').check();
    await page.click('[data-testid="export-prepare"]');
    await page.waitForSelector('[data-testid="export-stats"]');

    const modes = page.locator('[data-testid="export-materialization"]');
    await expect(modes.first()).toBeVisible();
    const text = (await modes.first().innerText()).replace(/\s+/g, ' ');
    expect(text).toContain('Tryb');

    if (process.platform === 'win32') {
      const pairs: readonly (readonly [string, string])[] = [
        ['Dowiązanie symboliczne.', EFFECT_PROPAGATES],
        ['Junction.', EFFECT_PROPAGATES],
        ['Kopia.', EFFECT_COPY],
      ];
      const matched = pairs.filter(
        ([label, effect]) => text.includes(label) && text.includes(effect),
      );
      expect(matched, `tryb i wyjasnienie w planie: ${text}`).toHaveLength(1);
    } else {
      expect(text).toContain('Dowiązanie symboliczne.');
      expect(text).toContain(EFFECT_PROPAGATES);
      expect(text).not.toContain(EFFECT_COPY);
    }

    // Zapis na dysku zgadza sie z planem: na POSIX-ie to dowiazanie, nie kopia.
    await page.click('[data-testid="export-apply"]');
    await page.waitForSelector('[data-testid="export-confirm-dialog"][open]');
    await page.click('[data-testid="export-confirm-apply"]');
    await page.waitForSelector('[data-testid="export-result"]', { timeout: 30_000 });
    expect(existsSync(join(codexSkill, 'SKILL.md')), 'skill jest czytelny w CODEX_HOME').toBe(true);
    if (process.platform !== 'win32') {
      expect(lstatSync(codexSkill).isSymbolicLink(), 'plan obiecal dowiazanie').toBe(true);
    }
  } finally {
    await app.close();
  }
});
