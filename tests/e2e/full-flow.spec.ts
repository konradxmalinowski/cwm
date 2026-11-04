import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createTempTree, removeTempTrees } from '../harness/isolation';
import { launchAppWithHome } from './launch';

/**
 * Kryterium 7 Etapu 5: pelny przeplyw przez prawdziwa aplikacje i prawdziwe pliki narzedzi.
 * Import, eksport, edycja w bibliotece, synchronizacja, cofniecie. Asercje stoja na stanie
 * dysku, bo to on jest produktem tej aplikacji; interfejs tylko prowadzi przeplyw.
 *
 * Element to agent: ma kopie jako tryb materializacji na kazdym systemie, wiec bajty pliku
 * w Codeksie sa jego wlasnymi bajtami. Test czyta tresc plikow, nie sprawdza, czy to link,
 * wiec jest ten sam dla dowiazania, junction i kopii.
 */

const SLUG = 'acme-bare';
const EDIT_MARKER = 'Zmiana-e2e-w-bibliotece';

test.afterAll(() => {
  removeTempTrees();
});

function readOrNull(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

test('import, edycja, synchronizacja do Codeksa i cofniecie wracaja do stanu co do bajta', async () => {
  test.setTimeout(150_000);

  const home = createTempTree('acme-home-');
  cpSync('tests/fixtures/claude-code/home', home, { recursive: true });
  cpSync('tests/fixtures/codex/home', home, { recursive: true });
  const codexHome = join(home, '.codex');
  const agentFile = join(codexHome, 'agents', `${SLUG}.toml`);
  const configFile = join(codexHome, 'config.toml');

  const { app, page } = await launchAppWithHome(home, createTempTree('acme-userdata-'));

  try {
    // 1. Import z Claude Code (katalog Codeksa zostaje, ale nie jest skanowany).
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

    const itemId = await page.evaluate(async (slug) => {
      const bridge = (
        window as unknown as {
          uasm: { library: { list: (request: object) => Promise<unknown> } };
        }
      ).uasm;
      const result = (await bridge.library.list({})) as {
        ok: boolean;
        value: { items: { id: string; slug: string }[] };
      };
      return result.value.items.find((i) => i.slug === slug)?.id ?? null;
    }, SLUG);
    expect(itemId, 'agent z importu jest w bibliotece').not.toBeNull();

    // 2. Pierwszy zapis do Codeksa przez eksport: po nim element ma stan synchronizacji.
    await openRoute(page, '#/eksport');
    await page.waitForSelector('[data-testid="export-items"]');
    await page.locator(`[data-testid="export-item"][data-slug="${SLUG}"] input`).first().check();
    await page.locator('[data-testid="export-tool-codex"]').check();
    await page.click('[data-testid="export-prepare"]');
    await page.waitForSelector('[data-testid="export-stats"]');
    await page.click('[data-testid="export-apply"]');
    await page.waitForSelector('[data-testid="export-confirm-dialog"][open]');
    await page.click('[data-testid="export-confirm-apply"]');
    await page.waitForSelector('[data-testid="export-result"]', { timeout: 30_000 });
    expect(existsSync(agentFile), 'eksport utworzyl plik agenta w CODEX_HOME').toBe(true);

    // 3. Edycja elementu w bibliotece.
    await openRoute(page, `#/biblioteka/${itemId}/edycja`);
    const body = page.locator('#field-body');
    await body.waitFor();
    await body.fill(`${await body.inputValue()}\n${EDIT_MARKER}\n`);
    await page.click('[data-testid="save"]');
    await page.waitForSelector('[data-testid="flash"]');

    // 4. Synchronizacja widzi zmiane w bibliotece.
    await openRoute(page, '#/synchronizacja');
    const row = page.locator(`[data-testid="sync-row"][data-slug="${SLUG}"]`);
    await row.waitFor();
    await expect(row.locator('[data-label="Codex"]')).toContainText('Zmieniony w bibliotece');

    const agentBeforeSync = readOrNull(agentFile);
    const configBeforeSync = readOrNull(configFile);
    expect(agentBeforeSync, 'plik agenta istnieje przed synchronizacja').not.toBeNull();
    expect(agentBeforeSync?.toString('utf8')).not.toContain(EDIT_MARKER);

    // 5. Plan tylko do Codeksa, zatwierdzenie, raport z weryfikacja.
    await page.locator('[data-testid="sync-tool-claude-code"]').uncheck();
    await row.locator('[data-testid="sync-pick"]').check();
    await page.click('[data-testid="sync-prepare"]');
    await page.waitForSelector('[data-testid="sync-total"]');
    await expect(page.locator('[data-testid="sync-apply"]')).toBeEnabled();
    await page.click('[data-testid="sync-apply"]');
    await page.waitForSelector('[data-testid="export-confirm-dialog"][open]');
    await page.click('[data-testid="export-confirm-apply"]');
    await page.waitForSelector('[data-testid="sync-result"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="export-verified"]').first()).toContainText(
      'zgadzają się z planem',
    );

    // 6. Dysk: plik w CODEX_HOME ma nowa tresc.
    const agentAfterSync = readOrNull(agentFile);
    expect(agentAfterSync?.toString('utf8')).toContain(EDIT_MARKER);
    expect(agentAfterSync?.equals(agentBeforeSync as Buffer)).toBe(false);

    // 7. Ponowny status: zgodny.
    await page.click('[data-testid="sync-restart"]');
    await page.waitForSelector(`[data-testid="sync-row"][data-slug="${SLUG}"]`);
    await expect(
      page.locator(`[data-testid="sync-row"][data-slug="${SLUG}"] [data-label="Codex"]`),
    ).toContainText('Zgodny');

    // 8. Historia: cofniecie tej synchronizacji.
    await openRoute(page, '#/historia');
    const syncEntry = page.locator('[data-testid="history-entry"][data-kind="sync"]').first();
    await syncEntry.waitFor();
    await syncEntry.getByRole('button', { name: /Cofnij synchronizację/ }).click();
    await page.waitForSelector('[data-testid="history-total"]');
    await expect(page.locator('[data-testid="history-apply"]')).toBeEnabled();
    await page.click('[data-testid="history-apply"]');
    await page.waitForSelector('[data-testid="export-confirm-dialog"][open]');
    await page.click('[data-testid="export-confirm-apply"]');
    await page.waitForSelector('[data-testid="export-result"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="export-verified"]')).toContainText(
      'zgadzają się z planem',
    );

    // 9. Dysk: stan sprzed synchronizacji, bajt w bajt.
    const agentAfterUndo = readOrNull(agentFile);
    expect(agentAfterUndo, 'plik agenta wrocil').not.toBeNull();
    expect(agentAfterUndo?.equals(agentBeforeSync as Buffer)).toBe(true);
    expect(
      readOrNull(configFile)?.equals(configBeforeSync as Buffer) ?? configBeforeSync === null,
    ).toBe(true);
  } finally {
    await app.close();
  }
});
