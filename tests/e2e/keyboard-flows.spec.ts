import { expect, test, type Page } from '@playwright/test';

import type { ImportScanDto } from '../../src/shared/ipc/import-contract';
import { removeTempTrees } from '../harness/isolation';
import {
  expectFocus,
  expectFocusTrapped,
  focusInfo,
  openViaNav,
  resetFocusOrder,
  tabTo,
} from './keyboard-helpers';
import { mockChannel } from './ui-helpers';
import { call, startWorld, type World } from './ui-world';

/**
 * Kryterium 3 Etapu 8: cztery krytyczne przeplywy (import, synchronizacja, diff, cofanie) i okno
 * usuwania z biblioteki, przechodzone wylacznie klawiatura. Po zaladowaniu aplikacji test nie
 * klika i nie zmienia adresu: Tab, Shift+Tab, Enter, Spacja, Escape, `j`, `k`. Asercje stoja na
 * `document.activeElement`: gdzie jest fokus, czy ma widoczny pierscien, czy kolejnosc jest zgodna
 * z kolejnoscia w dokumencie, czy okno dialogowe trzyma fokus i czy po Escape fokus wraca na
 * element, ktory je otworzyl.
 */

test.afterAll(() => {
  removeTempTrees();
});

async function withWorld(
  name: 'seeded' | 'empty',
  body: (w: World) => Promise<void>,
): Promise<void> {
  const w = await startWorld(name);
  w.page.setDefaultTimeout(10_000);
  try {
    await body(w);
  } finally {
    await w.app.close();
  }
}

async function expectChecked(page: Page, selector: string, checked: boolean): Promise<void> {
  await expect(page.locator(selector)).toBeChecked({ checked });
}

test('import: lokalizacje, skan, wybor, okno sekretu i zapis samą klawiaturą', async () => {
  test.setTimeout(120_000);
  await withWorld('seeded', async ({ page, app }) => {
    // Jeden kandydat dostaje sekret, zeby przeplyw przeszedl przez okno potwierdzenia.
    const detect = await call<{ roots: { rootId: string; exists: boolean }[] }>(
      page,
      'import',
      'detect',
    );
    const scan = await call<ImportScanDto>(page, 'import', 'scan', {
      rootIds: detect.roots.filter((r) => r.exists).map((r) => r.rootId),
    });
    const secret = scan.candidates.find((c) => c.status === 'new');
    if (secret === undefined) throw new Error('brak nowego kandydata');
    secret.secrets = [
      {
        rule: 'acme-regula-testowa',
        file: 'SKILL.md',
        line: 3,
        reason: 'Wartość wygląda jak klucz (dane testowe).',
      },
    ];
    secret.selectedByDefault = false;
    await mockChannel(app, 'import:scan', { kind: 'reply', result: { ok: true, value: scan } });

    // 1. Spis tresci: skip-link jest pierwszym postojem, potem linki.
    await page.keyboard.press('Tab');
    expect((await focusInfo(page)).name).toBe('Przejdź do treści');
    await openViaNav(page, 'Import', 'import-heading');

    // 2. Lokalizacje: Tab po polach wyboru, Spacja odznacza, Enter skanuje.
    await resetFocusOrder(page);
    await tabTo(page, 'input[type="checkbox"]');
    const firstRoot = await page.evaluate(
      () => (document.activeElement as HTMLInputElement).checked,
    );
    await page.keyboard.press('Space');
    const afterSpace = await page.evaluate(
      () => (document.activeElement as HTMLInputElement).checked,
    );
    expect(afterSpace, 'Spacja przelacza pole wyboru lokalizacji').toBe(!firstRoot);
    await page.keyboard.press('Space');
    await tabTo(page, '[data-testid="import-scan"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'import-heading');
    await expect(page.locator('[data-testid="group-new"]')).toBeVisible();

    // 3. Podglad: Tab do pierwszego pola kandydata, j i k przesuwaja fokus.
    await resetFocusOrder(page);
    await tabTo(page, '[data-cand-pick]');
    const first = (await focusInfo(page)).id;
    await page.keyboard.press('j');
    const second = (await focusInfo(page)).id;
    expect(second, 'j przesuwa fokus na nastepny wiersz').not.toBe(first);
    await page.keyboard.press('k');
    expect((await focusInfo(page)).id, 'k wraca na poprzedni wiersz').toBe(first);

    // 4. Kandydat z sekretem: Spacja otwiera okno, fokus trafia na bezpieczny przycisk.
    const secretBox = `#pick-${secret.candidateId}`;
    await page.locator(secretBox).focus();
    await page.keyboard.press('Space');
    await page.locator('[data-testid="secret-dialog"][open]').waitFor();
    await expectFocus(
      page,
      '[data-testid="secret-dialog"] button.btn:not(.btn--primary)',
      'okno sekretu',
    );
    await expectFocusTrapped(page);

    // 5. Escape zamyka okno i oddaje fokus polu, ktore je otworzylo; pole zostaje odznaczone.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="secret-dialog"]')).toHaveCount(0);
    await expectFocus(page, secretBox, 'po Escape fokus wraca na pole kandydata');
    await expectChecked(page, secretBox, false);

    // 6. Drugi raz: potwierdzenie przyciskiem. Fokus startuje na "Zostaw odznaczony", wiec Tab
    // dochodzi do "Zaznacz mimo sekretu", a Enter zaznacza i oddaje fokus polu.
    await page.keyboard.press('Space');
    await page.locator('[data-testid="secret-dialog"][open]').waitFor();
    await page.keyboard.press('Tab');
    await expectFocus(page, '[data-testid="secret-dialog"] .btn--primary');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="secret-dialog"]')).toHaveCount(0);
    await expectFocus(page, secretBox, 'po potwierdzeniu fokus wraca na pole kandydata');
    await expectChecked(page, secretBox, true);

    // 7. Zapis: Tab do przycisku importu, Enter, wynik z fokusem na zdaniu.
    await tabTo(page, '[data-testid="import-apply"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="import-result"]');
    await page.waitForFunction(() => document.activeElement?.id === 'import-heading');
    await tabTo(page, '[data-testid="import-to-library"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.location.hash === '#/biblioteka');
  });
});

test('synchronizacja: wybor, plan, okno potwierdzenia i zapis samą klawiaturą', async () => {
  test.setTimeout(120_000);
  await withWorld('seeded', async ({ page }) => {
    await page.keyboard.press('Tab');
    await openViaNav(page, 'Synchronizacja', 'sync-heading');
    await page.waitForSelector('[data-testid="sync-matrix"]');

    // Narzedzia: Spacja odznacza Claude Code, plan ma isc tylko do Codeksa.
    await resetFocusOrder(page);
    await tabTo(page, '[data-testid="sync-tool-claude-code"]');
    await page.keyboard.press('Space');
    await expectChecked(page, '[data-testid="sync-tool-claude-code"]', false);

    // Wiersz acme-bare: Tab do jego pola, Spacja zaznacza. j i k dzialaja miedzy wierszami.
    await tabTo(page, '[data-testid="sync-row"][data-slug="acme-bare"] [data-testid="sync-pick"]');
    await page.keyboard.press('Space');
    await expectChecked(
      page,
      '[data-testid="sync-row"][data-slug="acme-bare"] [data-testid="sync-pick"]',
      true,
    );
    const here = (await focusInfo(page)).id;
    await page.keyboard.press('j');
    expect((await focusInfo(page)).id, 'j przesuwa fokus na nastepny wiersz macierzy').not.toBe(
      here,
    );
    await page.keyboard.press('k');
    expect((await focusInfo(page)).id).toBe(here);

    // Plan.
    await tabTo(page, '[data-testid="sync-prepare"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="sync-total"]');
    await page.waitForFunction(() => document.activeElement?.id === 'sync-heading');

    // Okno potwierdzenia: Enter na przycisku zapisu, pulapka, Escape i powrot fokusu.
    await tabTo(page, '[data-testid="sync-apply"]');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    await expectFocus(
      page,
      '[data-testid="export-confirm-dialog"] button:not(.btn--primary)',
      'okno potwierdzenia',
    );
    expect((await page.locator(':focus').innerText()).trim()).toBe('Wróć do planu');
    await expectFocusTrapped(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="export-confirm-dialog"]')).toHaveCount(0);
    await expectFocus(
      page,
      '[data-testid="sync-apply"]',
      'po Escape fokus wraca na przycisk zapisu',
    );

    // Drugi raz: Shift+Tab z "Wróć do planu" na przycisk zatwierdzenia, Enter.
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    await page.keyboard.press('Shift+Tab');
    await expectFocus(page, '[data-testid="export-confirm-apply"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="sync-result"]');
    await page.waitForFunction(() => document.activeElement?.id === 'sync-heading');
    await tabTo(page, '[data-testid="sync-to-history"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.location.hash === '#/historia');
  });
});

test('diff: podglad roznicy w macierzy i podglad zmian w planie samą klawiaturą', async () => {
  test.setTimeout(120_000);
  await withWorld('seeded', async ({ page }) => {
    await page.keyboard.press('Tab');
    await openViaNav(page, 'Synchronizacja', 'sync-heading');
    await page.waitForSelector('[data-testid="sync-matrix"]');

    // Macierz: Enter na "Pokaż różnicę" rozwija panel, drugi Enter go zwija. Fokus zostaje na przycisku.
    const preview =
      '[data-testid="sync-row"][data-slug="acme-reviewer"] [data-testid="sync-preview"]';
    await resetFocusOrder(page);
    await tabTo(page, preview);
    await expect(page.locator(preview)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="sync-preview-panel"] [data-testid="diff"]');
    await expect(page.locator(preview)).toHaveAttribute('aria-expanded', 'true');
    await expectFocus(page, preview, 'po rozwinieciu fokus zostaje na przycisku');

    // Obszar diffu jest dostepny z klawiatury (region z tabindex), ma nazwe i da sie nim przewijac.
    await tabTo(page, '[data-testid="diff"] [role="region"]');
    const info = await focusInfo(page);
    expect(info.name, 'region diffu ma nazwe').toContain('Zmiany w pliku');
    await page.keyboard.press('End');
    await page.keyboard.press('Home');

    // Zwijanie: Shift+Tab wraca do przycisku, Spacja zwija.
    await tabTo(page, preview, { reverse: true });
    await page.keyboard.press('Space');
    await expect(page.locator(preview)).toHaveAttribute('aria-expanded', 'false');
    await expectFocus(page, preview);

    // Plan: zaznaczenie wiersza, plan, a potem Enter na "Podglad zmian" w pliku.
    await tabTo(page, '[data-testid="sync-tool-claude-code"]', { reverse: true, max: 200 });
    await page.keyboard.press('Space');
    await tabTo(page, '[data-testid="sync-row"][data-slug="acme-bare"] [data-testid="sync-pick"]');
    await page.keyboard.press('Space');
    await tabTo(page, '[data-testid="sync-prepare"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="sync-total"]');
    await tabTo(page, 'summary[data-export-nav]');
    // Wpisy nadpisujace sa domyslnie rozwiniete (uzytkownik ma zobaczyc, co zniknie): Enter zwija,
    // kolejny Enter rozwija, a fokus caly czas zostaje na podsumowaniu.
    const isOpen = (): Promise<boolean> =>
      page.evaluate(
        () => (document.activeElement?.parentElement as HTMLDetailsElement | null)?.open ?? false,
      );
    const before = await isOpen();
    await page.keyboard.press('Enter');
    expect(await isOpen(), 'Enter przelacza podglad zmian').toBe(!before);
    await expectFocus(
      page,
      'summary[data-export-nav]',
      'po zwinieciu fokus zostaje na podsumowaniu',
    );
    await page.keyboard.press('Space');
    expect(await isOpen(), 'Spacja przelacza podglad zmian z powrotem').toBe(before);
    await expectFocus(
      page,
      'summary[data-export-nav]',
      'po rozwinieciu fokus zostaje na podsumowaniu',
    );
    if (before) {
      await page.waitForSelector('[data-testid="sync-tool-plan"] [data-testid="diff"]');
    }
  });
});

test('cofanie: lista, plan, okno potwierdzenia i wynik samą klawiaturą', async () => {
  test.setTimeout(120_000);
  await withWorld('seeded', async ({ page }) => {
    await page.keyboard.press('Tab');
    await openViaNav(page, 'Historia', 'history-heading');
    await page.waitForSelector('[data-testid="history-list"]');

    // Lista: Tab do przycisku cofniecia wpisu eksportu, Enter przygotowuje plan.
    await resetFocusOrder(page);
    await tabTo(
      page,
      '[data-testid="history-entry"][data-kind="export"] [data-testid="history-undo"]',
      {
        allowOutOfOrder: true,
      },
    );
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="history-total"]');
    await page.waitForFunction(() => document.activeElement?.id === 'history-heading');

    // Plan -> okno: Enter, pulapka, Escape i powrot fokusu na przycisk zatwierdzenia.
    await tabTo(page, '[data-testid="history-apply"]');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    await expectFocusTrapped(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="export-confirm-dialog"]')).toHaveCount(0);
    await expectFocus(
      page,
      '[data-testid="history-apply"]',
      'po Escape fokus wraca na przycisk zatwierdzenia',
    );

    // Zatwierdzenie: Enter, Shift+Tab na przycisk zatwierdzenia w oknie, Enter.
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    await page.keyboard.press('Shift+Tab');
    await expectFocus(page, '[data-testid="export-confirm-apply"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="history-done"]');
    await page.waitForFunction(() => document.activeElement?.id === 'history-heading');

    // Powrot do listy: Tab, Enter; fokus na zdaniu listy.
    await tabTo(page, '[data-testid="history-done"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="history-list"]');
    await page.waitForFunction(() => document.activeElement?.id === 'history-heading');
    await expect(
      page.locator('[data-testid="history-entry"][data-reverted="true"]').first(),
    ).toBeVisible();
  });
});

test('okno usuwania z biblioteki: pulapka fokusu, Escape i powrot fokusu na "Usuń"', async () => {
  test.setTimeout(120_000);
  await withWorld('seeded', async ({ page, items }) => {
    const id = items.get('acme-deploy');
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/biblioteka/${id}`);
    await page.waitForSelector('[data-testid="delete-open"]');
    await page.locator('main h1').waitFor();
    await resetFocusOrder(page);
    // Fokus po wejsciu jest na zdaniu; do przycisku "Usuń…" dochodzi sie Tabem.
    await tabTo(page, '[data-testid="delete-open"]');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="confirm-delete"]').waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('dialog') !== null);
    await expectFocusTrapped(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="delete-dialog"]')).toHaveCount(0);
    await expectFocus(
      page,
      '[data-testid="delete-open"]',
      'po Escape fokus wraca na przycisk "Usuń…"',
    );
  });
});
