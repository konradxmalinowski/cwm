import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import type { ImportScanDto } from '../../src/shared/ipc/import-contract';
import type { LibraryListDto } from '../../src/shared/ipc/library-contract';
import {
  freshRoute,
  mockChannel,
  type ChannelMock,
  type ChannelMode,
  openRoute,
} from './ui-helpers';
import { LONG_SLUG, call, type World, type WorldName } from './ui-world';

/**
 * Rejestr scen interfejsu (Etap 8): jedno miejsce, ktore wie, jak doprowadzic aplikacje do kazdego
 * stanu widoku i dialogu. Korzystaja z niego trzy specyfikacje:
 *
 * - `view-states.spec.ts` - kazda scena ma asercje o tym, co uzytkownik widzi (kryterium 2);
 * - `a11y-fit.spec.ts` - kazda scena przechodzi audyt axe w obu motywach (kryterium 4) i miesci
 *   sie w oknie 1024 x 700 (kryterium 5);
 * - `controls-inventory.spec.ts` - kazda scena dostarcza kontrolek do inwentaryzacji (kryterium 1).
 *
 * Stany, ktorych prawdziwy backend nie wytwarza na zadanie (ladowanie, blad, odmowa), powstaja
 * przez podmiane handlera IPC w procesie glownym (`ui-helpers.ts`), nigdy przez kod aplikacji.
 */

export type ViewName =
  'Biblioteka' | 'Import' | 'Eksport' | 'Diagnostyka' | 'Synchronizacja' | 'Historia';

export const VIEWS: readonly ViewName[] = [
  'Biblioteka',
  'Import',
  'Eksport',
  'Diagnostyka',
  'Synchronizacja',
  'Historia',
];

export type ViewState = 'pusty' | 'ladowanie' | 'sukces' | 'ostrzezenie' | 'blad';

export const VIEW_STATES: readonly ViewState[] = [
  'pusty',
  'ladowanie',
  'sukces',
  'ostrzezenie',
  'blad',
];

export interface SceneContext {
  readonly w: World;
  readonly page: Page;
  readonly app: ElectronApplication;
  /** Podmienia handler kanalu; przywrocenie nastepuje po scenie albo wczesniej przez `restore()`. */
  mock(channel: string, mode: ChannelMode): Promise<ChannelMock>;
  go(hash: string): Promise<void>;
  /** Wywoluje sie po przywroceniu mockow, przed zamknieciem dialogow: sprzata stan, ktory scena zostawila w aplikacji. */
  onCleanup(fn: () => Promise<void>): void;
}

export interface Scene {
  readonly id: string;
  readonly view: ViewName;
  /** Ktory z pieciu stanow widoku ta scena pokazuje; brak oznacza krok lub dialog. */
  readonly state?: ViewState;
  readonly world: WorldName;
  reach(ctx: SceneContext): Promise<void>;
  assert(ctx: SceneContext): Promise<void>;
}

export function createContext(w: World): { ctx: SceneContext; cleanup: () => Promise<void> } {
  const restores: ChannelMock[] = [];
  const afterRestore: (() => Promise<void>)[] = [];
  const ctx: SceneContext = {
    w,
    page: w.page,
    app: w.app,
    async mock(channel, mode) {
      const handle = await mockChannel(w.app, channel, mode);
      restores.push(handle);
      return handle;
    },
    go: (hash) => freshRoute(w.page, hash),
    onCleanup: (fn) => {
      afterRestore.push(fn);
    },
  };
  const cleanup = async (): Promise<void> => {
    for (const handle of restores.splice(0).reverse()) await handle.restore();
    for (const fn of afterRestore.splice(0)) {
      await fn().catch((error: unknown) => {
        console.warn(
          'sprzatanie sceny:',
          error instanceof Error ? error.message.split('\n')[0] : error,
        );
      });
    }
    // Otwarte okno dialogowe blokuje strone; zamyka je Escape, tak jak zrobiłby uzytkownik.
    for (let i = 0; i < 3; i++) {
      if ((await w.page.locator('dialog[open]').count()) === 0) break;
      await w.page.keyboard.press('Escape');
      await w.page.waitForTimeout(50);
    }
    await openRoute(w.page, '#/pusty-adres-testowy');
  };
  return { ctx, cleanup };
}

const t = (page: Page, id: string): Locator => page.locator(`[data-testid="${id}"]`);
const heading = (page: Page): Locator => page.locator('main h1');

function item(w: World, slug: string): string {
  const id = w.items.get(slug);
  if (id === undefined) throw new Error(`swiat ${w.name} nie ma elementu ${slug}`);
  return id;
}

async function realScan(page: Page): Promise<ImportScanDto> {
  const detect = await call<{ roots: { rootId: string; exists: boolean }[] }>(
    page,
    'import',
    'detect',
  );
  return call<ImportScanDto>(page, 'import', 'scan', {
    rootIds: detect.roots.filter((r) => r.exists).map((r) => r.rootId),
  });
}

async function startScan(ctx: SceneContext): Promise<void> {
  await ctx.go('#/import');
  await t(ctx.page, 'import-scan').waitFor();
  await t(ctx.page, 'import-scan').click();
}

async function exportSelect(ctx: SceneContext, tool: string, slugs: string[]): Promise<void> {
  await ctx.go('#/eksport');
  await t(ctx.page, 'export-items').waitFor();
  await t(ctx.page, `export-tool-${tool}`).check();
  for (const slug of slugs) {
    await ctx.page
      .locator(`[data-testid="export-item"][data-slug="${slug}"] input[type="checkbox"]`)
      .check();
  }
}

async function exportPlan(ctx: SceneContext, tool: string, slugs: string[]): Promise<void> {
  await exportSelect(ctx, tool, slugs);
  await t(ctx.page, 'export-prepare').click();
}

async function syncSelect(ctx: SceneContext, slugs: string[]): Promise<void> {
  await ctx.go('#/synchronizacja');
  await t(ctx.page, 'sync-matrix').waitFor();
  await t(ctx.page, 'sync-tool-claude-code').uncheck();
  for (const slug of slugs) {
    await ctx.page
      .locator(`[data-testid="sync-row"][data-slug="${slug}"] [data-testid="sync-pick"]`)
      .check();
  }
}

/** Po scenie z bledem albo zawieszonym raportem stan startu jest globalny; wraca przez ponowienie. */
async function reloadDiagnostics(page: Page): Promise<void> {
  await page
    .locator('[data-testid="diagnostics-report"], [data-testid="diagnostics-error"]')
    .first()
    .waitFor();
  const retry = t(page, 'diagnostics-error').getByRole('button', { name: 'Spróbuj ponownie' });
  if (await retry.isVisible()) await retry.click();
  await t(page, 'diagnostics-report').waitFor();
}

async function firstUndo(page: Page): Promise<Locator> {
  const entry = page.locator('[data-testid="history-entry"][data-kind="export"]').first();
  await entry.waitFor();
  return entry.locator('[data-testid="history-undo"]');
}

export const SCENES: readonly Scene[] = [
  // ======================= Biblioteka =======================
  {
    id: 'biblioteka/lista',
    view: 'Biblioteka',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/biblioteka');
      await t(c.page, 'library-table').waitFor();
    },
    assert: async ({ page, w }) => {
      await expect(heading(page)).toContainText('W bibliotece jest');
      await expect(page.locator('[data-testid="library-table"] tbody tr')).toHaveCount(
        w.items.size,
      );
    },
  },
  {
    id: 'biblioteka/ladowanie',
    view: 'Biblioteka',
    state: 'ladowanie',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:list', { kind: 'hold' });
      await c.go('#/biblioteka');
      await t(c.page, 'library-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Wczytuję bibliotekę.');
      await expect(page.locator('section.view')).toHaveAttribute('aria-busy', 'true');
      await expect(t(page, 'library-table')).toHaveCount(0);
    },
  },
  {
    id: 'biblioteka/blad',
    view: 'Biblioteka',
    state: 'blad',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:list', { kind: 'fail', message: 'Indeks biblioteki nie odpowiada.' });
      await c.go('#/biblioteka');
      await t(c.page, 'library-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się wczytać biblioteki.');
      await expect(t(page, 'library-error')).toContainText('Indeks biblioteki nie odpowiada.');
      await expect(t(page, 'library-error')).toHaveAttribute('role', 'alert');
      await expect(
        t(page, 'library-error').getByRole('button', { name: 'Spróbuj ponownie' }),
      ).toBeVisible();
    },
  },
  {
    id: 'biblioteka/pusta',
    view: 'Biblioteka',
    state: 'pusty',
    world: 'empty',
    reach: async (c) => {
      await c.go('#/biblioteka');
      await t(c.page, 'library-empty').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Biblioteka jest pusta.');
      await expect(page.getByRole('link', { name: 'Utwórz pierwszy element' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Zaimportuj z Claude Code/ })).toBeVisible();
    },
  },
  {
    id: 'biblioteka/do-naprawy',
    view: 'Biblioteka',
    state: 'ostrzezenie',
    world: 'seeded',
    reach: async (c) => {
      const real = await call<LibraryListDto>(c.page, 'library', 'list', {});
      const first = real.items[0];
      if (first === undefined) throw new Error('brak elementow');
      await c.mock('library:list', {
        kind: 'reply',
        result: {
          ok: true,
          value: {
            items: real.items,
            inconsistent: [
              {
                id: first.id,
                slug: first.slug,
                kind: first.kind,
                files: [
                  { path: 'body.md', problem: 'hash-differs' },
                  {
                    path: 'assets/references/bardzo-dluga-sciezka-do-pliku-pomocniczego-elementu.md',
                    problem: 'missing',
                  },
                ],
              },
            ],
            problems: [
              {
                id: '01ACMEPROBLEMNIECZYTELNY00000',
                reason: 'invalid-metadata',
                message:
                  'Nie udało się odczytać metadanych elementu: plik item.json jest uszkodzony.',
              },
            ],
          },
        },
      });
      await c.go('#/biblioteka');
      await t(c.page, 'inconsistent').waitFor();
    },
    assert: async ({ page }) => {
      await expect(page.locator('main .view__sub').first()).toContainText(
        'Do naprawy: 1 niespójny, 1 nieczytelny.',
      );
      await expect(t(page, 'inconsistent')).toContainText('Nadpisze');
      await expect(t(page, 'problem')).toContainText('Nieczytelny.');
      await expect(page.getByRole('button', { name: 'Przyjmij stan z dysku' })).toBeEnabled();
    },
  },
  {
    id: 'biblioteka/brak-wynikow',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/biblioteka');
      await t(c.page, 'library-table').waitFor();
      await c.page.locator('#library-query').fill('zzzniemaczegostakiego');
      await t(c.page, 'library-no-match').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nic nie pasuje do tego zapytania.');
      await expect(page.getByRole('button', { name: 'Wyczyść filtry' })).toBeVisible();
    },
  },
  {
    id: 'biblioteka/zaznaczenie-do-eksportu',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/biblioteka');
      await t(c.page, 'library-table').waitFor();
      await c.page.locator('[data-testid="library-pick"][aria-label*="Acme"]').first().check();
      await expect(t(c.page, 'library-export-selected')).toBeEnabled();
    },
    assert: async ({ page }) => {
      // Przycisk dziala: prowadzi do eksportu z zaznaczonym elementem.
      await t(page, 'library-export-selected').click();
      await t(page, 'export-items').waitFor();
      await expect(t(page, 'export-select-total')).toContainText('1');
    },
  },
  {
    id: 'biblioteka/szczegol',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.go(`#/biblioteka/${item(c.w, LONG_SLUG)}`);
      await t(c.page, 'item-body').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('to agent');
      await expect(t(page, 'edit-link')).toBeVisible();
      await expect(t(page, 'export-link')).toBeVisible();
      await expect(t(page, 'delete-open')).toBeVisible();
    },
  },
  {
    id: 'biblioteka/szczegol-ladowanie',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:get', { kind: 'hold' });
      await c.go(`#/biblioteka/${item(c.w, 'acme-flat')}`);
      await t(c.page, 'detail-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Wczytuję element.');
    },
  },
  {
    id: 'biblioteka/szczegol-blad',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:get', { kind: 'fail', message: 'Nie udało się odczytać elementu.' });
      await c.go(`#/biblioteka/${item(c.w, 'acme-flat')}`);
      await t(c.page, 'detail-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się wczytać elementu.');
      await expect(page.getByRole('link', { name: 'Wróć do listy' })).toBeVisible();
    },
  },
  {
    id: 'biblioteka/formularz-nowy',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/biblioteka/nowy');
      await c.page.locator('#field-slug').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'save')).toBeEnabled();
      await expect(page.getByRole('link', { name: 'Anuluj' })).toBeVisible();
    },
  },
  {
    id: 'biblioteka/formularz-bledy',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/biblioteka/nowy');
      await c.page.locator('#field-slug').waitFor();
      await t(c.page, 'save').click();
      await t(c.page, 'error-slug').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'error-slug')).toContainText('Błąd');
      await expect(t(page, 'error-title')).toContainText('Błąd');
      await expect(page.locator('#field-slug')).toHaveAttribute('aria-invalid', 'true');
    },
  },
  {
    id: 'biblioteka/formularz-ladowanie',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:get', { kind: 'hold' });
      await c.go(`#/biblioteka/${item(c.w, 'acme-flat')}/edycja`);
      await t(c.page, 'form-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'form-loading')).toBeVisible();
    },
  },
  {
    id: 'biblioteka/formularz-blad-odczytu',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:get', { kind: 'fail', message: 'Nie udało się odczytać elementu.' });
      await c.go(`#/biblioteka/${item(c.w, 'acme-flat')}/edycja`);
      await t(c.page, 'form-load-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'form-load-error')).toContainText('Nie udało się odczytać elementu.');
    },
  },
  {
    id: 'biblioteka/formularz-blad-zapisu',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:save', { kind: 'fail', message: 'Zapis elementu nie powiódł się.' });
      await c.go(`#/biblioteka/${item(c.w, 'acme-flat')}/edycja`);
      await c.page.locator('#field-title').waitFor();
      await t(c.page, 'save').click();
      await t(c.page, 'form-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'form-error')).toContainText('Zapis elementu nie powiódł się.');
    },
  },
  {
    id: 'biblioteka/zapis-komunikat',
    view: 'Biblioteka',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await c.go(`#/biblioteka/${item(c.w, 'acme-flat')}/edycja`);
      await c.page.locator('#field-body').waitFor();
      const body = c.page.locator('#field-body');
      await body.fill(`${await body.inputValue()}\nDopisek E2E.\n`);
      await t(c.page, 'save').click();
      await t(c.page, 'flash').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'flash')).toBeVisible();
      await expect(heading(page)).toContainText('wersja');
    },
  },
  {
    id: 'biblioteka/usuwanie-plan',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.go(`#/biblioteka/${item(c.w, 'acme-deploy')}`);
      await t(c.page, 'delete-open').click();
      await t(c.page, 'confirm-delete').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'delete-dialog')).toHaveAttribute('open', '');
      await expect(page.locator('#delete-title')).toContainText('Usuniesz element');
    },
  },
  {
    id: 'biblioteka/usuwanie-ladowanie',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:delete-plan', { kind: 'hold' });
      await c.go(`#/biblioteka/${item(c.w, 'acme-deploy')}`);
      await t(c.page, 'delete-open').click();
      await c.page.locator('#delete-title').waitFor();
    },
    assert: async ({ page }) => {
      await expect(page.locator('#delete-title')).toHaveText('Sprawdzam, co usunięcie zmieni.');
    },
  },
  {
    id: 'biblioteka/usuwanie-blad',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:delete-plan', {
        kind: 'fail',
        message: 'Nie udało się przygotować planu.',
      });
      await c.go(`#/biblioteka/${item(c.w, 'acme-deploy')}`);
      await t(c.page, 'delete-open').click();
      await c.page.getByRole('button', { name: 'Zamknij' }).waitFor();
    },
    assert: async ({ page }) => {
      await expect(page.locator('#delete-title')).toHaveText(
        'Nie udało się przygotować usunięcia.',
      );
    },
  },
  {
    id: 'biblioteka/usuwanie-zablokowane',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      const id = item(c.w, 'acme-deploy');
      await c.mock('library:delete-plan', {
        kind: 'reply',
        result: {
          ok: true,
          value: {
            token: 'acme-token',
            itemId: id,
            kind: 'command',
            slug: 'acme-deploy',
            title: 'Acme deploy',
            recoverability: 'blocked',
            unrecoverable: [],
            blockedReason: 'Katalog kopii zapasowych nie jest zapisywalny.',
          },
        },
      });
      await c.go(`#/biblioteka/${id}`);
      await t(c.page, 'delete-open').click();
      await c.page.locator('.dialog__label', { hasText: 'Zablokowane.' }).waitFor();
    },
    assert: async ({ page }) => {
      await expect(page.locator('#delete-title')).toContainText('jest zablokowane');
      await expect(t(page, 'confirm-delete')).toHaveCount(0);
    },
  },
  {
    id: 'biblioteka/usuwanie-czesciowe',
    view: 'Biblioteka',
    world: 'seeded',
    reach: async (c) => {
      const id = item(c.w, 'acme-deploy');
      await c.mock('library:delete-plan', {
        kind: 'reply',
        result: {
          ok: true,
          value: {
            token: 'acme-token',
            itemId: id,
            kind: 'command',
            slug: 'acme-deploy',
            title: 'Acme deploy',
            recoverability: 'partial',
            unrecoverable: [
              {
                path: 'assets/references/bardzo-dluga-sciezka-do-pliku-pomocniczego.md',
                reason: 'brak kopii w magazynie',
              },
            ],
            blockedReason: null,
          },
        },
      });
      await c.go(`#/biblioteka/${id}`);
      await t(c.page, 'delete-open').click();
      await t(c.page, 'unrecoverable-list').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'confirm-delete')).toBeDisabled();
      await t(page, 'acknowledge').check();
      await expect(t(page, 'confirm-delete')).toBeEnabled();
    },
  },

  // ======================= Import =======================
  {
    id: 'import/lokalizacje',
    view: 'Import',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/import');
      await t(c.page, 'import-scan').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText(
        'Wybierz, z których lokalizacji zaimportować elementy.',
      );
      await expect(t(page, 'import-scan')).toBeEnabled();
    },
  },
  {
    id: 'import/ladowanie',
    view: 'Import',
    state: 'ladowanie',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:detect', { kind: 'hold' });
      await c.go('#/import');
      await t(c.page, 'import-detect-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Szukam lokalizacji narzędzi.');
    },
  },
  {
    id: 'import/blad-lokalizacji',
    view: 'Import',
    state: 'blad',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:detect', {
        kind: 'fail',
        message: 'Nie udało się sprawdzić katalogów narzędzi.',
      });
      await c.go('#/import');
      await t(c.page, 'import-detect-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się sprawdzić lokalizacji.');
      await expect(page.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible();
    },
  },
  {
    id: 'import/brak-katalogow',
    view: 'Import',
    state: 'pusty',
    world: 'empty',
    reach: async (c) => {
      await c.go('#/import');
      await c.page
        .locator('main h1')
        .filter({ hasText: /Żaden|nie znalazła/ })
        .waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Żaden z katalogów narzędzi nie istnieje');
      await expect(t(page, 'import-scan')).toBeDisabled();
    },
  },
  {
    id: 'import/skanowanie',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:scan', { kind: 'hold' });
      await startScan(c);
      await t(c.page, 'import-scan-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Skanuję wybrane lokalizacje.');
      await expect(page.getByRole('button', { name: 'Anuluj skan' })).toBeVisible();
    },
  },
  {
    id: 'import/blad-skanu',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:scan', { kind: 'fail', message: 'Skan został przerwany.' });
      await startScan(c);
      await t(c.page, 'import-scan-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'import-scan-error')).toContainText('Skan został przerwany.');
      await expect(t(page, 'import-scan')).toBeEnabled();
    },
  },
  {
    id: 'import/podglad',
    view: 'Import',
    state: 'ostrzezenie',
    world: 'seeded',
    reach: async (c) => {
      await startScan(c);
      await t(c.page, 'group-changed').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'group-changed')).toBeVisible();
      await expect(t(page, 'group-duplicate')).toBeVisible();
      await expect(t(page, 'group-conflict')).toBeVisible();
      await expect(t(page, 'import-skipped')).toBeVisible();
      await expect(t(page, 'import-apply')).toBeEnabled();
      await expect(
        page.locator('[data-testid="candidate"][data-status="conflict"] input'),
      ).toHaveCount(0);
    },
  },
  {
    id: 'import/podglad-nadpisanie',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      await startScan(c);
      await t(c.page, 'group-changed').waitFor();
      await c.page
        .locator('[data-testid="candidate"][data-status="changed"] input[type="checkbox"]')
        .first()
        .check();
      await t(c.page, 'import-overwrite-total').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'import-overwrite-total')).toContainText('Nadpisze');
      await expect(page.locator('.cand--overwrite').first()).toBeVisible();
    },
  },
  {
    id: 'import/podglad-pusty',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:scan', {
        kind: 'reply',
        result: { ok: true, value: { scanToken: 'acme-skan', candidates: [], skipped: [] } },
      });
      await startScan(c);
      await t(c.page, 'import-no-candidates').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Skan nie znalazł niczego do zaimportowania.');
      await expect(page.getByRole('button', { name: 'Wróć do lokalizacji' }))
        .toBeVisible()
        .catch(() => undefined);
    },
  },
  {
    id: 'import/dialog-sekret',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      const scan = await realScan(c.page);
      const target = scan.candidates.find((cand) => cand.status === 'new');
      if (target === undefined) throw new Error('brak nowego kandydata');
      target.secrets = [
        {
          rule: 'acme-regula-testowa',
          file: 'SKILL.md',
          line: 3,
          reason: 'Wartość wygląda jak klucz dostępowy (dane testowe).',
        },
      ];
      target.selectedByDefault = false;
      await c.mock('import:scan', { kind: 'reply', result: { ok: true, value: scan } });
      await startScan(c);
      const box = c.page.locator(
        `[data-testid="candidate"][data-slug="${target.slug}"][data-status="new"] input[type="checkbox"]`,
      );
      await box.first().waitFor();
      await box
        .first()
        .check({ force: true })
        .catch(() => undefined);
      await t(c.page, 'secret-dialog').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'secret-hits')).toContainText('acme-regula-testowa');
      await expect(page.getByRole('button', { name: 'Zostaw odznaczony' })).toBeFocused();
    },
  },
  {
    id: 'import/zapis-ladowanie',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:apply', { kind: 'hold' });
      await startScan(c);
      await t(c.page, 'import-apply').waitFor();
      await t(c.page, 'import-apply').click();
      await t(c.page, 'import-apply-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Importuję wybrane elementy.');
    },
  },
  {
    id: 'import/zapis-blad',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('import:apply', {
        kind: 'fail',
        message: 'Zapis do biblioteki nie powiódł się.',
      });
      await startScan(c);
      await t(c.page, 'import-apply').click();
      await t(c.page, 'import-apply-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'import-apply-error')).toContainText(
        'Zapis do biblioteki nie powiódł się.',
      );
      await expect(t(page, 'import-apply')).toBeEnabled();
    },
  },
  {
    id: 'import/wynik-z-bledem',
    view: 'Import',
    world: 'seeded',
    reach: async (c) => {
      const scan = await realScan(c.page);
      const first = scan.candidates.find((cand) => cand.status === 'new');
      if (first === undefined) throw new Error('brak nowego kandydata');
      await c.mock('import:scan', { kind: 'reply', result: { ok: true, value: scan } });
      await c.mock('import:apply', {
        kind: 'reply',
        result: {
          ok: true,
          value: {
            imported: [],
            skipped: [{ candidateId: scan.candidates[0]?.candidateId, reason: 'już w bibliotece' }],
            failed: [
              {
                candidateId: first.candidateId,
                code: 'write-failed',
                message: 'Nie udało się zapisać elementu.',
              },
            ],
          },
        },
      });
      await startScan(c);
      await t(c.page, 'import-apply').click();
      await t(c.page, 'import-result').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nic nie zostało zaimportowane.');
      await expect(t(page, 'apply-failed')).toContainText('write-failed');
    },
  },

  // ======================= Eksport =======================
  {
    id: 'eksport/wybor',
    view: 'Eksport',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/eksport');
      await t(c.page, 'export-items').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText(
        'Wybierz narzędzie i elementy, które trafią do jego konfiguracji.',
      );
      await expect(t(page, 'export-prepare')).toBeDisabled();
    },
  },
  {
    id: 'eksport/ladowanie',
    view: 'Eksport',
    state: 'ladowanie',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:list', { kind: 'hold' });
      await c.go('#/eksport');
      await t(c.page, 'export-items-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Wczytuję bibliotekę.');
    },
  },
  {
    id: 'eksport/blad',
    view: 'Eksport',
    state: 'blad',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('library:list', { kind: 'fail', message: 'Biblioteka nie odpowiada.' });
      await c.go('#/eksport');
      await t(c.page, 'export-items-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się wczytać biblioteki.');
    },
  },
  {
    id: 'eksport/pusta-biblioteka',
    view: 'Eksport',
    state: 'pusty',
    world: 'empty',
    reach: async (c) => {
      await c.go('#/eksport');
      await t(c.page, 'export-empty-library').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText(
        'Biblioteka jest pusta, więc nie ma czego eksportować.',
      );
    },
  },
  {
    id: 'eksport/brak-wynikow',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/eksport');
      await t(c.page, 'export-items').waitFor();
      await c.page.locator('#export-query').fill('zzzniemaczegostakiego');
      await t(c.page, 'export-no-match').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'export-no-match')).toBeVisible();
    },
  },
  {
    id: 'eksport/plan-ladowanie',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('export:plan', { kind: 'hold' });
      await exportPlan(c, 'codex', ['acme-flat']);
      await t(c.page, 'export-plan-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Przygotowuję plan zapisu');
    },
  },
  {
    id: 'eksport/plan-blad',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('export:plan', { kind: 'fail', message: 'Nie udało się przygotować planu.' });
      await exportPlan(c, 'codex', ['acme-flat']);
      await t(c.page, 'export-plan-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'export-plan-error')).toContainText('Wybór został zachowany');
    },
  },
  {
    id: 'eksport/plan',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await exportPlan(c, 'codex', ['acme-flat', 'acme-deploy']);
      await t(c.page, 'export-stats').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Zapis zmieni');
      await expect(t(page, 'export-apply')).toBeEnabled();
      await expect(t(page, 'export-entries')).toBeVisible();
    },
  },
  {
    id: 'eksport/plan-nadpisanie',
    view: 'Eksport',
    state: 'ostrzezenie',
    world: 'seeded',
    reach: async (c) => {
      await exportPlan(c, 'codex', ['acme-bare', 'acme-reviewer']);
      await t(c.page, 'export-stats').waitFor();
      await c.page
        .locator('[data-testid="export-entry"] details.entry__diff > summary')
        .first()
        .click();
      await t(c.page, 'diff').first().waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'export-overwrite-total')).toContainText('Nadpisze');
      await expect(t(page, 'diff').first()).toBeVisible();
      await expect(t(page, 'export-verdicts')).toBeVisible();
    },
  },
  {
    id: 'eksport/plan-decyzja',
    view: 'Eksport',
    state: 'ostrzezenie',
    world: 'seeded',
    reach: async (c) => {
      // Prawdziwy plan jako podstawa, z konfliktem z opcjami i wpisem z zastapieniem katalogu:
      // swiat seeded nie ma instrukcji globalnej bez znacznikow, a prawdziwy przeplyw jest
      // w export-decision.spec.ts.
      const id = item(c.w, 'acme-flat');
      const real = await call<Record<string, unknown>>(c.page, 'export', 'plan', {
        tool: 'codex',
        itemIds: [id],
      });
      const entries = (real['entries'] as Record<string, unknown>[]).map((e, i) =>
        i === 0
          ? {
              ...e,
              action: 'modify',
              warnings: [
                'Nadpisze zawartość istniejącego katalogu "acme-flat". Cała jego poprzednia zawartość trafi do kopii zapasowej. Znikną z katalogu pliki, których nie ma w nowej wersji: notatki.txt, references/a.md.',
              ],
            }
          : e,
      );
      await c.mock('export:plan', {
        kind: 'reply',
        result: {
          ok: true,
          value: {
            ...real,
            entries,
            applicable: false,
            conflicts: [
              {
                itemIds: [id],
                relPath: 'AGENTS.md',
                reason:
                  'Plik AGENTS.md zawiera treść zaimportowaną z niego do tego elementu (3 linii), ale bez znaczników aplikacji. Zamiana wstawi blok aplikacji w miejsce tego fragmentu, a resztę pliku zostawi bez zmian. Dopisanie bloku na końcu zostawi starą treść w pliku, więc treść będzie w nim dwa razy.',
                options: [
                  { id: 'replace-fragment', label: 'Zamień ten fragment na blok aplikacji' },
                  { id: 'append-block', label: 'Dopisz blok na końcu' },
                ],
              },
              {
                itemIds: [id, item(c.w, 'acme-deploy')],
                relPath: 'skills/acme-deploy/SKILL.md',
                reason: 'Komenda i skill o tej samej nazwie chcą zapisać ten sam plik.',
              },
            ],
          },
        },
      });
      await exportPlan(c, 'codex', ['acme-flat']);
      await t(c.page, 'export-decisions').waitFor();
    },
    assert: async ({ page }) => {
      const options = t(page, 'export-decision-option');
      await expect(options).toHaveCount(2);
      await expect(options.nth(0)).not.toBeChecked();
      await expect(options.nth(1)).not.toBeChecked();
      await expect(t(page, 'export-decision-overwrite')).toContainText('Nadpisze');
      await expect(t(page, 'export-overwrite-files')).toContainText('notatki.txt');
      await expect(t(page, 'export-conflict')).toHaveCount(1);
      await expect(t(page, 'export-apply')).toBeDisabled();
    },
  },
  {
    id: 'eksport/dialog-potwierdzenia',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await exportPlan(c, 'codex', ['acme-bare']);
      await t(c.page, 'export-apply').waitFor();
      await t(c.page, 'export-apply').click();
      await c.page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'export-confirm-overwrite')).toContainText('Nadpisze');
      await expect(page.getByRole('button', { name: 'Wróć do planu' })).toBeFocused();
    },
  },
  {
    id: 'eksport/zapis-ladowanie',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('export:apply', { kind: 'hold' });
      await exportPlan(c, 'codex', ['acme-flat']);
      await t(c.page, 'export-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'export-apply-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Zapisuję zmiany');
    },
  },
  {
    id: 'eksport/zapis-blad',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('export:apply', { kind: 'fail', message: 'Zapis został przerwany.' });
      await exportPlan(c, 'codex', ['acme-flat']);
      await t(c.page, 'export-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'export-apply-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'export-apply-error')).toContainText('Zapis został przerwany.');
      await expect(t(page, 'export-apply')).toBeDisabled();
      await expect(t(page, 'export-replan')).toBeVisible();
    },
  },

  // ======================= Diagnostyka =======================
  {
    id: 'diagnostyka/start-normalny',
    view: 'Diagnostyka',
    state: 'pusty',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'diagnostics-report').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText(
        'Indeks otworzył się bez zastrzeżeń i baza odpowiada.',
      );
      await expect(t(page, 'diagnostics-nothing')).toContainText('nie wymagał naprawy');
    },
  },
  {
    id: 'diagnostyka/ladowanie',
    view: 'Diagnostyka',
    state: 'ladowanie',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'diagnostics-report').waitFor();
      await c.mock('diagnostics:report', { kind: 'hold' });
      await c.page.getByRole('button', { name: 'Odśwież raport' }).click();
      await t(c.page, 'diagnostics-loading').waitFor();
      c.onCleanup(() => reloadDiagnostics(c.page));
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Odczytuję raport.');
    },
  },
  {
    id: 'diagnostyka/blad',
    view: 'Diagnostyka',
    state: 'blad',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'diagnostics-report').waitFor();
      // Ten kanal zwraca raport wprost, bez koperty `Result`, wiec blad to odrzucenie wywolania.
      await c.mock('diagnostics:report', { kind: 'throw', message: 'Raport jest niedostępny.' });
      await c.page.getByRole('button', { name: 'Odśwież raport' }).click();
      await t(c.page, 'diagnostics-error').waitFor();
      c.onCleanup(() => reloadDiagnostics(c.page));
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się odczytać raportu.');
      await expect(t(page, 'diagnostics-error')).toContainText(
        'Nie udało się odczytać raportu z procesu głównego.',
      );
    },
  },
  {
    id: 'diagnostyka/odbudowa-plan',
    view: 'Diagnostyka',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'rebuild-open').click();
      await t(c.page, 'rebuild-plan').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'rebuild-apply')).toBeDisabled();
      await t(page, 'rebuild-confirm').check();
      await expect(t(page, 'rebuild-apply')).toBeEnabled();
    },
  },
  {
    id: 'diagnostyka/odbudowa-potwierdzona',
    view: 'Diagnostyka',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'rebuild-open').click();
      await t(c.page, 'rebuild-plan').waitFor();
      await t(c.page, 'rebuild-confirm').check();
      await expect(t(c.page, 'rebuild-apply')).toBeEnabled();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'rebuild-apply')).toBeEnabled();
    },
  },
  {
    id: 'diagnostyka/odbudowa-planowanie',
    view: 'Diagnostyka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('diagnostics:rebuild-index-plan', { kind: 'hold' });
      await c.go('#/diagnostyka');
      await t(c.page, 'rebuild-open').click();
      await t(c.page, 'rebuild-planning').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'rebuild-planning')).toHaveText('Przygotowuję plan odbudowy.');
    },
  },
  {
    id: 'diagnostyka/odbudowa-blad-planu',
    view: 'Diagnostyka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('diagnostics:rebuild-index-plan', {
        kind: 'fail',
        message: 'Nie udało się policzyć planu.',
      });
      await c.go('#/diagnostyka');
      await t(c.page, 'rebuild-open').click();
      await t(c.page, 'rebuild-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'rebuild-error')).toContainText('Nie udało się policzyć planu.');
    },
  },
  {
    id: 'diagnostyka/odbudowa-zablokowana',
    view: 'Diagnostyka',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('diagnostics:rebuild-index-plan', {
        kind: 'reply',
        result: {
          ok: true,
          value: {
            planId: 'acme-plan',
            quarantineName: 'index.db.kwarantanna',
            itemsToRestore: 0,
            notRecoverable: [],
            currentOutcome: 'ready',
            currentReason: null,
            recoverability: 'blocked',
            blockedReason: 'Katalog danych aplikacji nie jest zapisywalny.',
          },
        },
      });
      await c.go('#/diagnostyka');
      await t(c.page, 'rebuild-open').click();
      await t(c.page, 'rebuild-blocked').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'rebuild-blocked')).toContainText('Zablokowane.');
    },
  },
  {
    id: 'diagnostyka/start-odbudowany',
    view: 'Diagnostyka',
    state: 'ostrzezenie',
    world: 'rebuilt',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'diagnostics-report').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Indeks był uszkodzony i został odbudowany od nowa.');
      await expect(t(page, 'startup-banner')).toContainText('Indeks odbudowany.');
    },
  },
  {
    id: 'diagnostyka/odmowa-startu',
    view: 'Diagnostyka',
    state: 'blad',
    world: 'refused',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'diagnostics-report').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Aplikacja nie otworzyła indeksu przy starcie.');
      await expect(t(page, 'rebuild-only-exit')).toBeVisible();
      await expect(t(page, 'startup-banner')).toContainText('Odmowa startu.');
    },
  },
  {
    id: 'diagnostyka/odbudowa-wynik',
    view: 'Diagnostyka',
    state: 'sukces',
    world: 'rebuilt',
    reach: async (c) => {
      await c.go('#/diagnostyka');
      await t(c.page, 'rebuild-open').click();
      await t(c.page, 'rebuild-plan').waitFor();
      await t(c.page, 'rebuild-confirm').check();
      await t(c.page, 'rebuild-apply').click();
      await t(c.page, 'rebuild-result').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'rebuild-result')).toHaveAttribute('data-outcome', 'complete');
      await expect(t(page, 'rebuild-restored')).toContainText('Odtworzono elementów');
    },
  },

  // ======================= Synchronizacja =======================
  {
    id: 'synchronizacja/stan',
    view: 'Synchronizacja',
    state: 'ostrzezenie',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-matrix').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('wymagają Twojej decyzji');
      const conflict = page.locator(
        '[data-testid="sync-row"][data-slug="acme-reviewer"] [data-label="Codex"]',
      );
      await expect(conflict).toContainText('Konflikt');
      await expect(
        page.locator('[data-testid="sync-row"][data-slug="acme-bare"] [data-label="Codex"]'),
      ).toContainText('Zmieniony w bibliotece');
      await expect(
        page.locator('[data-testid="sync-row"][data-slug="acme-extra"] [data-label="Codex"]'),
      ).toContainText('Zmieniony w narzędziu');
    },
  },
  {
    id: 'synchronizacja/ladowanie',
    view: 'Synchronizacja',
    state: 'ladowanie',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('sync:status', { kind: 'hold' });
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Wczytuję stan synchronizacji.');
    },
  },
  {
    id: 'synchronizacja/blad',
    view: 'Synchronizacja',
    state: 'blad',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('sync:status', {
        kind: 'fail',
        message: 'Nie udało się odczytać stanu narzędzi.',
      });
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się wczytać stanu synchronizacji.');
    },
  },
  {
    id: 'synchronizacja/pusta',
    view: 'Synchronizacja',
    state: 'pusty',
    world: 'empty',
    reach: async (c) => {
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-empty').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText(
        'Nie ma czego synchronizować, bo biblioteka jest pusta.',
      );
      await expect(t(page, 'sync-missing-tools')).toContainText('Zablokowane.');
    },
  },
  {
    id: 'synchronizacja/brak-wynikow',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-matrix').waitFor();
      await c.page.locator('#sync-query').fill('zzzniemaczegostakiego');
      await t(c.page, 'sync-no-match').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'sync-no-match')).toBeVisible();
    },
  },
  {
    id: 'synchronizacja/podglad-roznicy',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-matrix').waitFor();
      await c.page
        .locator('[data-testid="sync-row"][data-slug="acme-reviewer"] [data-testid="sync-preview"]')
        .click();
      await t(c.page, 'diff').first().waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'sync-preview-panel')).toBeVisible();
      await expect(t(page, 'diff').first()).toContainText('Dodano');
    },
  },
  {
    id: 'synchronizacja/decyzja',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/synchronizacja');
      await t(c.page, 'sync-matrix').waitFor();
      await c.page
        .locator(
          '[data-testid="sync-row"][data-slug="acme-reviewer"] [data-testid="sync-resolve-library-wins"]',
        )
        .check();
      await t(c.page, 'sync-overwrite').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'sync-overwrite')).toContainText('Nadpisze');
    },
  },
  {
    id: 'synchronizacja/plan-ladowanie',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('sync:plan', { kind: 'hold' });
      await syncSelect(c, ['acme-bare']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-plan-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Przygotowuję plan synchronizacji');
    },
  },
  {
    id: 'synchronizacja/plan-blad',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('sync:plan', { kind: 'fail', message: 'Nie udało się przygotować planu.' });
      await syncSelect(c, ['acme-bare']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-plan-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'sync-plan-error')).toContainText('Wybór został zachowany');
    },
  },
  {
    id: 'synchronizacja/plan',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await syncSelect(c, ['acme-bare', 'acme-flat']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-total').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Synchronizacja zmieni');
      await expect(t(page, 'sync-apply')).toBeEnabled();
    },
  },
  {
    id: 'synchronizacja/dialog-potwierdzenia',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await syncSelect(c, ['acme-bare']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-apply').click();
      await c.page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    },
    assert: async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Wróć do planu' })).toBeFocused();
    },
  },
  {
    id: 'synchronizacja/zapis-ladowanie',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('sync:apply', { kind: 'hold' });
      await syncSelect(c, ['acme-bare']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'sync-apply-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Synchronizuję.');
    },
  },
  {
    id: 'synchronizacja/zapis-blad',
    view: 'Synchronizacja',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('sync:apply', { kind: 'fail', message: 'Zapis został przerwany.' });
      await syncSelect(c, ['acme-bare']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'sync-apply-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'sync-apply-error')).toContainText('Zapis został przerwany.');
      await expect(t(page, 'sync-replan')).toBeVisible();
    },
  },

  // ======================= Historia =======================
  {
    id: 'historia/lista',
    view: 'Historia',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/historia');
      await t(c.page, 'history-list').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Pokazuję');
      await expect(
        page
          .locator('[data-testid="history-entry"][data-kind="export"] [data-testid="history-undo"]')
          .first(),
      ).toBeVisible();
    },
  },
  {
    id: 'historia/ladowanie',
    view: 'Historia',
    state: 'ladowanie',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('history:list', { kind: 'hold' });
      await c.go('#/historia');
      await t(c.page, 'history-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Wczytuję historię operacji.');
    },
  },
  {
    id: 'historia/blad',
    view: 'Historia',
    state: 'blad',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('history:list', { kind: 'fail', message: 'Log operacji jest niedostępny.' });
      await c.go('#/historia');
      await t(c.page, 'history-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toHaveText('Nie udało się wczytać historii.');
    },
  },
  {
    id: 'historia/pusta',
    view: 'Historia',
    state: 'pusty',
    world: 'empty',
    reach: async (c) => {
      await c.go('#/historia');
      await t(c.page, 'history-empty').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Historia jest pusta');
    },
  },
  {
    id: 'historia/plan-ladowanie',
    view: 'Historia',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('history:rollback', { kind: 'hold' });
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-plan-loading').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Przygotowuję plan cofnięcia');
    },
  },
  {
    id: 'historia/plan-blad',
    view: 'Historia',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('history:rollback', {
        kind: 'fail',
        message: 'Nie znaleziono kopii zapasowej.',
      });
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-plan-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'history-plan-error')).toContainText('Nic nie zostało zmienione');
    },
  },
  {
    id: 'historia/plan-cofniecia',
    view: 'Historia',
    state: 'ostrzezenie',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-total').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'history-total')).toBeVisible();
      await expect(heading(page)).toContainText(/Cofnięcie zmieni|Pliki są już|nie da się/);
    },
  },
  {
    id: 'historia/zapis-ladowanie',
    view: 'Historia',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('export:apply', { kind: 'hold' });
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await c.page.getByText('Przywracam pliki w').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Cofam operację.');
    },
  },
  {
    id: 'historia/zapis-blad',
    view: 'Historia',
    world: 'seeded',
    reach: async (c) => {
      await c.mock('export:apply', { kind: 'fail', message: 'Zapis został przerwany.' });
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'history-apply-error').waitFor();
    },
    assert: async ({ page }) => {
      await expect(t(page, 'history-apply-error')).toContainText('Zapis został przerwany.');
    },
  },
  {
    id: 'historia/dialog-potwierdzenia',
    view: 'Historia',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-apply').click();
      await c.page.locator('[data-testid="export-confirm-dialog"][open]').waitFor();
    },
    assert: async ({ page }) => {
      await expect(page.locator('#export-confirm-title')).toHaveText('Cofnąć tę operację?');
    },
  },
];

/** Sceny zapisujace dane: biegna w osobnym swiecie, zeby nie zmieniac stanu scen tylko do odczytu. */
export const MUTATING_SCENES: readonly Scene[] = [
  {
    id: 'import/wynik',
    view: 'Import',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await startScan(c);
      await t(c.page, 'import-apply').click();
      await t(c.page, 'import-result').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Zaimportowano');
      await expect(t(page, 'import-to-library')).toBeVisible();
    },
  },
  {
    id: 'eksport/wynik',
    view: 'Eksport',
    world: 'seeded',
    reach: async (c) => {
      await exportPlan(c, 'codex', ['acme-flat']);
      await t(c.page, 'export-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'export-result').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Zapisano');
      await expect(t(page, 'export-verified')).toContainText('zgadzają się z planem');
    },
  },
  {
    id: 'synchronizacja/wynik',
    view: 'Synchronizacja',
    state: 'sukces',
    world: 'seeded',
    reach: async (c) => {
      await syncSelect(c, ['acme-bare']);
      await t(c.page, 'sync-prepare').click();
      await t(c.page, 'sync-total').waitFor();
      await t(c.page, 'sync-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'sync-result').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText('Zapisano');
      await expect(t(page, 'sync-to-history')).toBeVisible();
    },
  },
  {
    id: 'historia/wynik',
    view: 'Historia',
    world: 'seeded',
    reach: async (c) => {
      await c.go('#/historia');
      await (await firstUndo(c.page)).click();
      await t(c.page, 'history-apply').waitFor();
      await t(c.page, 'history-apply').click();
      await t(c.page, 'export-confirm-apply').click();
      await t(c.page, 'history-done').waitFor();
    },
    assert: async ({ page }) => {
      await expect(heading(page)).toContainText(/Cofnięto operację|Cofnięcie się nie udało/);
    },
  },
];

/** Sceny podzielone na swiaty w kolejnosci rejestru; `mutating` laczy sie ze swiatem `seeded`. */
export function groupByWorld(scenes: readonly Scene[]): Map<WorldName, Scene[]> {
  const groups = new Map<WorldName, Scene[]>();
  for (const scene of scenes) {
    const list = groups.get(scene.world) ?? [];
    list.push(scene);
    groups.set(scene.world, list);
  }
  return groups;
}
