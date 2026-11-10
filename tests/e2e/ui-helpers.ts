import { readFileSync } from 'node:fs';

import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Wspolne pomocniki testow interfejsu (Etap 8): podmiana handlerow IPC w procesie glownym,
 * audyt axe, pomiar dopasowania do okna.
 *
 * Podmiana dzieje sie wylacznie tutaj, w kodzie testowym. W aplikacji nie ma ani jednej galezi,
 * ktora istnieje tylko po to, zeby test mogl wywolac stan.
 */

export async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

/**
 * Wchodzi na trase od zera: najpierw na adres, ktory jest 'nie ma takiego widoku', potem na
 * docelowy. Dzieki temu komponent powstaje na nowo i jego pierwsze wywolania IPC ida przez
 * zamockowany handler, nawet gdy test jest juz na tej trasie.
 */
export async function freshRoute(page: Page, hash: string): Promise<void> {
  await openRoute(page, '#/pusty-adres-testowy');
  await page.getByRole('heading', { name: 'Nie ma takiego widoku.' }).waitFor();
  await openRoute(page, hash);
}

export type ChannelMode =
  /**
   * Handler nie odpowiada, dopoki test nie przywroci kanalu. Daje stan ladowania. Przywrocenie
   * konczy zawieszone wywolania odmowa w formie `Result`, a NIE wykonuje oryginalnej operacji:
   * zawieszone `export:apply` czy `history:rollback` zapisaloby na dysk po fakcie i zmienilo
   * swiat kolejnych scen.
   */
  | { readonly kind: 'hold' }
  /** Handler rzuca wyjatek, tak jak kanal bez handlera. Dla kanalow, ktore nie zwracaja `Result`. */
  | { readonly kind: 'throw'; readonly message: string }
  /** Handler odpowiada bledem w formie `Result`. Daje stan bledu. */
  | { readonly kind: 'fail'; readonly code?: string; readonly message: string }
  /** Handler zwraca zadany `Result`, bez dotykania prawdziwego backendu. */
  | { readonly kind: 'reply'; readonly result: unknown };

export interface ChannelMock {
  /** Przywraca prawdziwy handler. Zawieszone wywolania dostaja wtedy odpowiedz prawdziwego. */
  readonly restore: () => Promise<void>;
}

interface InvokeHandlers {
  get(channel: string): ((...args: unknown[]) => unknown) | undefined;
  set(channel: string, handler: (...args: unknown[]) => unknown): void;
}

/**
 * Podmienia handler kanalu IPC. Oryginal jest zachowany w mapie handlerow Electrona i wraca
 * przez `restore()`. Mapa `_invokeHandlers` nie jest publicznym API; jesli Electron ja zmieni,
 * test padnie glosno na tym jednym miejscu, a nie zacznie cicho przechodzic.
 */
export async function mockChannel(
  app: ElectronApplication,
  channel: string,
  mode: ChannelMode,
): Promise<ChannelMock> {
  await app.evaluate(
    ({ ipcMain }, args) => {
      const g = globalThis as unknown as {
        __uasmOriginals?: Map<string, unknown>;
        __uasmHolds?: Map<string, (() => void)[]>;
      };
      const handlers = (ipcMain as unknown as { _invokeHandlers: InvokeHandlers })._invokeHandlers;
      if (handlers === undefined || typeof handlers.get !== 'function') {
        throw new Error('Electron nie udostepnia _invokeHandlers: popraw ui-helpers.ts');
      }
      g.__uasmOriginals ??= new Map();
      g.__uasmHolds ??= new Map();
      const original = handlers.get(args.channel);
      if (original === undefined) throw new Error(`brak handlera kanalu ${args.channel}`);
      if (!g.__uasmOriginals.has(args.channel)) g.__uasmOriginals.set(args.channel, original);

      const mode = args.mode;
      if (mode.kind === 'hold') {
        const waiting: (() => void)[] = [];
        g.__uasmHolds.set(args.channel, waiting);
        handlers.set(
          args.channel,
          () =>
            new Promise<unknown>((resolve) =>
              waiting.push(() =>
                resolve({
                  ok: false,
                  error: { code: 'test-released', message: 'Wywołanie przerwane przez test.' },
                }),
              ),
            ),
        );
      } else if (mode.kind === 'throw') {
        handlers.set(args.channel, () => {
          throw new Error(mode.message);
        });
      } else if (mode.kind === 'fail') {
        handlers.set(args.channel, () => ({
          ok: false,
          error: { code: mode.code ?? 'test-failure', message: mode.message },
        }));
      } else {
        handlers.set(args.channel, () => mode.result);
      }
    },
    { channel, mode },
  );

  return {
    restore: async () => {
      await app.evaluate(({ ipcMain }, name) => {
        const g = globalThis as unknown as {
          __uasmOriginals?: Map<string, (...a: unknown[]) => unknown>;
          __uasmHolds?: Map<string, (() => void)[]>;
        };
        const handlers = (ipcMain as unknown as { _invokeHandlers: InvokeHandlers })
          ._invokeHandlers;
        const original = g.__uasmOriginals?.get(name);
        if (original !== undefined) handlers.set(name, original);
        const waiting = g.__uasmHolds?.get(name) ?? [];
        g.__uasmHolds?.delete(name);
        for (const resolve of waiting) resolve();
      }, channel);
    },
  };
}

/** Ustawia rozmiar okna aplikacji (nie viewport Playwrighta) i czeka, az renderer go zobaczy. */
export async function setWindowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win === undefined) throw new Error('brak okna');
      // Okno z ramka ma obszar roboczy mniejszy od rozmiaru zewnetrznego; setContentSize
      // ustawia dokladnie to, co widzi renderer.
      win.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    { width, height },
  );
}

export async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
}

// ---- axe ----

let axeSource: string | null = null;

function loadAxe(): string {
  axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

export interface AxeFinding {
  readonly rule: string;
  readonly impact: string | null;
  readonly target: string;
  readonly summary: string;
}

export interface AxeScan {
  readonly violations: readonly AxeFinding[];
  readonly incomplete: readonly AxeFinding[];
  readonly counts: Readonly<Record<'critical' | 'serious' | 'moderate' | 'minor', number>>;
}

interface RawNode {
  readonly target: unknown[];
  readonly failureSummary?: string;
}
interface RawResult {
  readonly id: string;
  readonly impact?: string | null;
  readonly nodes: readonly RawNode[];
}

/**
 * Uruchamia axe-core na biezacym stanie strony. Zrodlo axe idzie przez CDP (`page.evaluate`),
 * nie przez znacznik script, wiec CSP `script-src 'self'` zostaje nietkniete.
 * Reguly: WCAG 2.0, 2.1 i 2.2 poziomu A i AA oraz najlepsze praktyki.
 */
export async function runAxe(page: Page): Promise<AxeScan> {
  await page.evaluate(loadAxe());
  const raw = await page.evaluate(async () => {
    const axe = (
      globalThis as unknown as {
        axe: { run: (context: unknown, options: unknown) => Promise<unknown> };
      }
    ).axe;
    return axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
      resultTypes: ['violations', 'incomplete'],
    });
  });
  const result = raw as { violations: RawResult[]; incomplete: RawResult[] };
  const flatten = (list: readonly RawResult[]): AxeFinding[] =>
    list.flatMap((rule) =>
      rule.nodes.map((node) => ({
        rule: rule.id,
        impact: rule.impact ?? null,
        target: node.target.map(String).join(' '),
        summary: (node.failureSummary ?? '').replace(/\s+/g, ' ').trim(),
      })),
    );
  const violations = flatten(result.violations);
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const finding of violations) {
    if (finding.impact !== null && finding.impact in counts) {
      counts[finding.impact as keyof typeof counts]++;
    }
  }
  return { violations, incomplete: flatten(result.incomplete), counts };
}

/**
 * Wyjatki od bramki axe. Kazdy wymaga reguly i powodu; bramka pada na kazdym innym znalezisku
 * poziomu critical albo serious. Pusta lista jest stanem docelowym.
 */
export interface AxeException {
  readonly rule: string;
  readonly reason: string;
}

export const AXE_EXCEPTIONS: readonly AxeException[] = [];

export function gatingViolations(scan: AxeScan): AxeFinding[] {
  return scan.violations.filter(
    (finding) =>
      (finding.impact === 'critical' || finding.impact === 'serious') &&
      !AXE_EXCEPTIONS.some((exception) => exception.rule === finding.rule),
  );
}

// ---- dopasowanie do okna ----

export interface FitReport {
  readonly pageOverflow: number;
  readonly scrollers: readonly string[];
  readonly clipped: readonly string[];
}

/**
 * Sprawdza, czy tresc miesci sie w oknie.
 *
 * - `pageOverflow`: o ile `scrollWidth` dokumentu przekracza `clientWidth` (0 = brak).
 * - `scrollers`: elementy, ktore same przewijaja sie poziomo (`overflow-x` auto lub scroll
 *   i `scrollWidth > clientWidth`). Poziome przewijanie w srodku widoku jest tym samym
 *   problemem dla uzytkownika, co przewijanie strony.
 * - `clipped`: elementy z tekstem, ktory jest przyciety (`overflow` hidden lub clip i
 *   `scrollWidth > clientWidth`) i nie ma pelnej wartosci w `title`. Element z `title`
 *   rownym przycietemu tekstowi jest uznany za skrot z dostepna pelna wartoscia.
 */
export async function measureFit(page: Page): Promise<FitReport> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const describe = (el: Element): string => {
      const id = el.id === '' ? '' : `#${el.id}`;
      const cls =
        typeof el.className === 'string' && el.className.trim() !== ''
          ? `.${el.className.trim().split(/\s+/).join('.')}`
          : '';
      const testid = el.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${id}${cls}${testid === null ? '' : `[data-testid=${testid}]`}`;
    };
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };

    const scrollers: string[] = [];
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!visible(el)) continue;
      const style = getComputedStyle(el);
      if (style.position === 'absolute' && el.classList.contains('sr-only')) continue;
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      if (!overflowing) continue;
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
        scrollers.push(`${describe(el)} (${el.scrollWidth} > ${el.clientWidth})`);
      } else if (style.overflowX === 'hidden' || style.overflowX === 'clip') {
        const text = (el.textContent ?? '').trim();
        const title = el.getAttribute('title') ?? el.closest('[title]')?.getAttribute('title');
        if (title === null || title === undefined || !title.includes(text)) {
          clipped.push(`${describe(el)} (${el.scrollWidth} > ${el.clientWidth})`);
        }
      }
    }
    return {
      pageOverflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
      scrollers,
      clipped,
    };
  });
}

/** Elementy, ktorych prostokat wystaje poza prawa lub dolna krawedz okna dialogowego/okna. */
export async function measureDialogFit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const dialog of Array.from(document.querySelectorAll('dialog[open]'))) {
      const rect = dialog.getBoundingClientRect();
      if (rect.right > window.innerWidth + 1) out.push(`prawa krawedz ${rect.right}`);
      if (rect.bottom > window.innerHeight + 1) {
        out.push(`dolna krawedz ${rect.bottom} > ${window.innerHeight}`);
      }
      if (rect.top < 0) out.push(`gorna krawedz ${rect.top}`);
      if (rect.left < 0) out.push(`lewa krawedz ${rect.left}`);
    }
    return out;
  });
}
