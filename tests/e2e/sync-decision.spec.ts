import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { BLOCK_END, BLOCK_START } from '../../src/adapters/shared/marker-block';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { launchAppWithHome } from './launch';

/**
 * Jak `export-decision.spec.ts`, ale przez Synchronizacje: konflikt instrukcji globalnej z opcjami
 * jest rozstrzygany w planie synchronizacji, a zapis zmienia tylko fragment pliku.
 * Bazuje na konflikcie z ADR 0025, regula 3. AGENTS.md w CODEX_HOME
 * nie ma znacznikow aplikacji, zostaje zaimportowany w calosci i edytowany w bibliotece, wiec
 * eksport nie moze po cichu dopisac go drugi raz. Asercje o pliku stoja na bajtach na dysku:
 * zamiana fragmentu nie rusza reszty pliku, ktora uzytkownik dopisal po imporcie.
 */

const IMPORTED = '# Zasady ACME\n\nStara tresc zasad globalnych.\n';
const NEW_BODY = '# Zasady ACME\n\nNowa tresc po edycji w bibliotece.\n';
const PREFIX = 'Notatka przed importem, zostaje nietknieta.\n\n';
const SUFFIX = '\nNotatka na koncu pliku, tez zostaje.\n';

test.afterAll(() => {
  removeTempTrees();
});

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

test('synchronizacja: konflikt instrukcji globalnej, wybor "Zamien" przelicza plan i zapisuje fragment', async () => {
  test.setTimeout(150_000);

  const home = createTempTree('acme-home-');
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const agentsFile = join(codexHome, 'AGENTS.md');
  writeFileSync(agentsFile, IMPORTED);

  const { app, page } = await launchAppWithHome(home, createTempTree('acme-userdata-'));

  try {
    // 1. Import instrukcji globalnej z Codeksa, w calosci.
    await openRoute(page, '#/import');
    await page.waitForSelector('[data-testid="import-scan"]');
    await page.click('[data-testid="import-scan"]');
    await page.waitForSelector('[data-testid="candidate"]');
    await page.click('[data-testid="import-apply"]');
    await page.waitForSelector('[data-testid="import-result"]', { timeout: 30_000 });

    const itemId = await page.evaluate(async () => {
      const bridge = (
        window as unknown as {
          uasm: { library: { list: (request: object) => Promise<unknown> } };
        }
      ).uasm;
      const result = (await bridge.library.list({})) as {
        value: { items: { id: string; kind: string }[] };
      };
      return result.value.items.find((i) => i.kind === 'global-instruction')?.id ?? null;
    });
    expect(itemId, 'instrukcja globalna z importu jest w bibliotece').not.toBeNull();

    // 2. Uzytkownik dopisuje tekst w pliku po imporcie.
    const original = `${PREFIX}${IMPORTED}${SUFFIX}`;
    writeFileSync(agentsFile, original);

    // 3. Edycja instrukcji w bibliotece.
    await openRoute(page, `#/biblioteka/${itemId}/edycja`);
    const body = page.locator('#field-body');
    await body.waitFor();
    await body.fill(NEW_BODY);
    await page.click('[data-testid="save"]');
    await page.waitForSelector('[data-testid="flash"]');

    // 4. Synchronizacja tylko z Codeksem: plan ma konflikt z opcjami i nie jest wykonywalny.
    await openRoute(page, '#/synchronizacja');
    const row = page.locator('[data-testid="sync-row"]').first();
    await row.waitFor();
    const claude = page.locator('[data-testid="sync-tool-claude-code"]');
    if ((await claude.count()) > 0) await claude.uncheck();
    await row.locator('[data-testid="sync-pick"]').check();
    await page.click('[data-testid="sync-prepare"]');
    await page.waitForSelector('[data-testid="export-decisions"]');

    const options = page.locator('[data-testid="export-decision-option"]');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).not.toBeChecked();
    await expect(options.nth(1)).not.toBeChecked();
    await expect(page.locator('[data-testid="sync-apply"]')).toBeDisabled();
    await expect(page.locator('[data-testid="sync-blockers"]')).toContainText('decyzji');
    expect(readFileSync(agentsFile, 'utf8'), 'plan niczego nie zapisuje').toBe(original);

    // 5. Wybor "Zamien": plan jest przeliczany i staje sie wykonywalny.
    await page.locator('[data-option="replace-fragment"]').check();
    await expect(page.locator('[data-testid="sync-apply"]')).toBeEnabled();
    await expect(page.locator('[data-option="replace-fragment"]')).toBeChecked();

    await page.click('[data-testid="sync-apply"]');
    await page.waitForSelector('[data-testid="export-confirm-dialog"][open]');
    await page.click('[data-testid="export-confirm-apply"]');
    await page.waitForSelector('[data-testid="sync-result"]', { timeout: 30_000 });

    // 6. Dysk: blok z nowa trescia, stary fragment znikl, reszta pliku bajt w bajt.
    const text = readFileSync(agentsFile).toString('utf8');
    expect(text).toContain(BLOCK_START);
    expect(text).toContain(BLOCK_END);
    expect(text).toContain('Nowa tresc po edycji w bibliotece.');
    expect(text).not.toContain('Stara tresc zasad globalnych.');
    const start = text.indexOf(BLOCK_START);
    const end = text.indexOf(BLOCK_END) + BLOCK_END.length;
    const rest = Buffer.from(text.slice(0, start) + text.slice(end), 'utf8');
    expect(rest.equals(Buffer.from(original.replace(IMPORTED.trim(), ''), 'utf8'))).toBe(true);
    expect(text.startsWith(PREFIX)).toBe(true);
    expect(text.endsWith(SUFFIX)).toBe(true);
  } finally {
    await app.close();
  }
});
