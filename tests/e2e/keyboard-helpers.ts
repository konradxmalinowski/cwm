import { expect, type Page } from '@playwright/test';

/**
 * Pomocniki testow klawiatury (kryterium 3 Etapu 8). Test przechodzi przeplyw wylacznie przez
 * `keyboard.press`; asercje stoja na `document.activeElement`, nie na tym, co udalo sie kliknac.
 */

export interface FocusInfo {
  readonly tag: string;
  readonly id: string;
  readonly testid: string;
  readonly name: string;
  readonly inDialog: boolean;
  readonly visibleRing: boolean;
  readonly focusVisible: boolean;
  readonly afterPrevious: boolean;
}

/** Opis elementu z fokusem. Stan poprzedniego fokusu trzyma strona, zeby sprawdzic kolejnosc w DOM. */
export async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const w = window as unknown as { __kbPrev?: Element | null };
    const el = document.activeElement;
    if (el === null || el === document.body) {
      return {
        tag: 'body',
        id: '',
        testid: '',
        name: '',
        inDialog: false,
        visibleRing: false,
        focusVisible: false,
        afterPrevious: true,
      };
    }
    const hasOutline = (node: Element | null): boolean => {
      if (node === null) return false;
      const s = getComputedStyle(node);
      return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    };
    // Pole wyboru bywa niewidoczne albo male, a pierscien nosi otaczajaca etykieta
    // (`label:has(input:focus-visible)`) albo sasiedni span (wybor motywu).
    const ring =
      hasOutline(el) ||
      (el instanceof HTMLInputElement && hasOutline(el.closest('label'))) ||
      (el.closest('.theme__option') !== null && hasOutline(el.nextElementSibling));
    const prev = w.__kbPrev;
    const afterPrevious =
      prev === undefined ||
      prev === null ||
      !document.contains(prev) ||
      prev === el ||
      (prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    w.__kbPrev = el;
    const labelledBy = el.getAttribute('aria-labelledby');
    const labelText =
      labelledBy === null
        ? ''
        : labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
    const name = (
      el.getAttribute('aria-label') ??
      (labelText !== '' ? labelText : null) ??
      (el as HTMLInputElement).labels?.[0]?.textContent ??
      el.textContent ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      testid: el.getAttribute('data-testid') ?? '',
      name: name.slice(0, 80),
      inDialog: el.closest('dialog') !== null,
      visibleRing: ring,
      focusVisible: el.matches(':focus-visible'),
      afterPrevious,
    };
  });
}

export async function resetFocusOrder(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __kbPrev?: Element | null }).__kbPrev = null;
  });
}

export interface TabWalk {
  readonly stops: FocusInfo[];
}

/**
 * Naciska Tab (albo Shift+Tab), az fokus trafi na element pasujacy do `selector`. Kazdy postoj
 * po drodze ma widoczny pierscien fokusu, a kolejnosc jest zgodna z kolejnoscia w dokumencie
 * (poza `reverse`). Zwraca postoje, zeby test mogl asercje o kolejnosci.
 */
export async function tabTo(
  page: Page,
  selector: string,
  options: { reverse?: boolean; max?: number; allowOutOfOrder?: boolean } = {},
): Promise<TabWalk> {
  const max = options.max ?? 80;
  const stops: FocusInfo[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(options.reverse === true ? 'Shift+Tab' : 'Tab');
    const info = await focusInfo(page);
    stops.push(info);
    const hit = await page.evaluate(
      (sel) => document.activeElement?.matches(sel) ?? false,
      selector,
    );
    if (hit) {
      expectStopsSane(stops, options);
      return { stops };
    }
  }
  throw new Error(
    `Tab nie doszedl do ${selector} w ${max} krokach: ${stops.map((s) => s.name || s.tag).join(' > ')}`,
  );
}

function expectStopsSane(
  stops: readonly FocusInfo[],
  options: { reverse?: boolean; allowOutOfOrder?: boolean },
): void {
  const bad = stops.filter((s) => !s.visibleRing || !s.focusVisible);
  expect(
    bad.map((s) => `${s.tag}#${s.id} "${s.name}"`),
    'kazdy postoj Tab ma widoczny pierscien fokusu',
  ).toEqual([]);
  if (options.reverse !== true && options.allowOutOfOrder !== true) {
    const disorder = stops.filter((s) => !s.afterPrevious);
    expect(
      disorder.map((s) => `${s.tag}#${s.id} "${s.name}"`),
      'kolejnosc fokusu zgodna z kolejnoscia w dokumencie',
    ).toEqual([]);
  }
}

export async function pressTimes(page: Page, key: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

export async function expectFocus(page: Page, selector: string, message?: string): Promise<void> {
  const ok = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
  if (!ok) {
    const info = await focusInfo(page);
    throw new Error(
      `${message ?? 'fokus'}: oczekiwano ${selector}, jest ${info.tag}#${info.id} [${info.testid}] "${info.name}"`,
    );
  }
}

/**
 * Pulapka fokusu: `count` kolejnych Tab (i tyle samo Shift+Tab) nie wyprowadza fokusu poza dialog.
 */
export async function expectFocusTrapped(page: Page, count = 6): Promise<void> {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < count; i++) {
      await page.keyboard.press(key);
      const info = await focusInfo(page);
      expect(
        info.inDialog,
        `${key} nr ${i + 1}: fokus zostaje w oknie dialogowym (${info.tag} "${info.name}")`,
      ).toBe(true);
    }
  }
}

/** Wejscie do widoku przez spis tresci, klawiatura: Tab do linku o danej nazwie, Enter. */
export async function openViaNav(page: Page, linkText: string, headingId: string): Promise<void> {
  await resetFocusOrder(page);
  await tabTo(page, `a.toc__link[href="#${hrefOf(linkText)}"]`);
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => document.activeElement?.id === id, headingId);
}

function hrefOf(linkText: string): string {
  const map: Record<string, string> = {
    Biblioteka: '/biblioteka',
    Import: '/import',
    Eksport: '/eksport',
    Diagnostyka: '/diagnostyka',
    Synchronizacja: '/synchronizacja',
    Historia: '/historia',
  };
  const href = map[linkText];
  if (href === undefined) throw new Error(`nieznany widok ${linkText}`);
  return href;
}
