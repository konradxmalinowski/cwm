import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, test, type CDPSession, type Page } from '@playwright/test';

import { removeTempTrees } from '../harness/isolation';
import { runGroup, sceneGroups } from './scene-runner';
import type { ViewName } from './scenes';

/**
 * Kryterium 1 Etapu 8: kazda widoczna kontrolka cos robi, lista kontrolek bez dzialania jest pusta.
 *
 * Inwentaryzacja jest mechaniczna, nie z pamieci: na kazdej scenie z rejestru (`scenes.ts`)
 * test zbiera kontrolki i pyta przegladarke przez CDP (`DOMDebugger.getEventListeners`), jakie
 * nasluchiwacze maja. Kontrolka jest martwa, gdy:
 *
 * - przycisk (poza `type=submit`) nie ma nasluchiwacza `click`;
 * - przycisk `type=submit` nie lezy w formularzu z nasluchiwaczem `submit`;
 * - link `href` nie prowadzi do trasy, ktora aplikacja zna (nie `not-found`) albo do kotwicy
 *   istniejacej na stronie;
 * - pole wyboru, przelacznik albo lista nie ma nasluchiwacza `change`/`input`/`click`;
 * - pole tekstowe nie ma nasluchiwacza `input`/`change` i nie jest tylko do odczytu.
 *
 * `details > summary` dziala natywnie. Wynik trafia do `test-results/controls-inventory.json`,
 * skad powstaje tabela "widok, kontrolki, dzialanie" w raporcie.
 */

interface ControlRow {
  readonly view: ViewName;
  readonly scene: string;
  readonly key: string;
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly testid: string;
  readonly disabled: boolean;
  readonly action: string;
  readonly dead: string | null;
}

const rows: ControlRow[] = [];

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/controls-inventory.json', JSON.stringify(rows, null, 2), 'utf8');
  removeTempTrees();
});

const SELECTOR =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [tabindex="0"]';

interface Raw {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly testid: string;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly href: string;
  readonly inForm: boolean;
  readonly visible: boolean;
  readonly inertScroller: boolean;
}

async function collect(page: Page): Promise<Raw[]> {
  return page.evaluate((selector) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
    (window as unknown as { __ctl: HTMLElement[] }).__ctl = all;
    return all.map((el) => {
      const rect = el.getBoundingClientRect();
      const labelled = el.getAttribute('aria-labelledby');
      const fromLabelled =
        labelled === null
          ? ''
          : labelled
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' ');
      const name = (
        el.getAttribute('aria-label') ??
        (fromLabelled !== '' ? fromLabelled : null) ??
        (el as HTMLInputElement).labels?.[0]?.textContent ??
        el.textContent ??
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
      return {
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? '',
        name,
        testid: el.getAttribute('data-testid') ?? '',
        disabled: (el as HTMLInputElement).disabled === true,
        readOnly: (el as HTMLInputElement).readOnly === true,
        href: el.getAttribute('href') ?? '',
        inForm: el.closest('form') !== null,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden',
        // Region przewijany (tabindex=0 bez roli kontrolki) nie jest kontrolka z akcja.
        inertScroller:
          el.getAttribute('tabindex') === '0' &&
          !['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(el.tagName),
      };
    });
  }, SELECTOR);
}

async function listeners(cdp: CDPSession, index: number): Promise<string[]> {
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression: `window.__ctl[${index}]`,
  });
  const objectId = evaluated.result.objectId;
  if (objectId === undefined) return [];
  const { listeners: found } = await cdp.send('DOMDebugger.getEventListeners', { objectId });
  return found.map((l) => l.type);
}

async function formHasSubmit(cdp: CDPSession, index: number): Promise<boolean> {
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression: `window.__ctl[${index}].closest('form')`,
  });
  const objectId = evaluated.result.objectId;
  if (objectId === undefined) return false;
  const { listeners: found } = await cdp.send('DOMDebugger.getEventListeners', { objectId });
  return found.some((l) => l.type === 'submit');
}

const KNOWN_ROUTES = /^#\/(biblioteka|import|eksport|diagnostyka|synchronizacja|historia)(\/|$)/;

async function anchorExists(page: Page, href: string): Promise<boolean> {
  return page.evaluate((h) => document.getElementById(h.slice(1)) !== null, href);
}

for (const group of sceneGroups()) {
  test(`inwentaryzacja kontrolek: ${group.title}`, async () => {
    test.setTimeout(420_000);
    await runGroup(group, async (scene, ctx) => {
      const cdp = await ctx.page.context().newCDPSession(ctx.page);
      await cdp.send('Runtime.enable');
      try {
        // Wszystkie otwarte `details` sa juz w stanie sceny; nie rozwijamy dodatkowych.
        const raw = await collect(ctx.page);
        for (let i = 0; i < raw.length; i++) {
          const el = raw[i];
          if (el === undefined || !el.visible || el.inertScroller) continue;
          const types = await listeners(cdp, i);
          let action = types
            .filter((t) => ['click', 'change', 'input', 'submit', 'keydown'].includes(t))
            .join('+');
          let dead: string | null = null;

          if (el.tag === 'a') {
            action = `przejscie do ${el.href}`;
            const ok =
              KNOWN_ROUTES.test(el.href) ||
              (el.href.startsWith('#') && (await anchorExists(ctx.page, el.href)));
            if (!ok) dead = `link prowadzi donikad: ${el.href}`;
          } else if (el.tag === 'summary') {
            action = 'rozwija element details (natywnie)';
          } else if (el.tag === 'button') {
            if (el.type === 'submit') {
              action = 'wysyla formularz';
              if (!el.inForm || !(await formHasSubmit(cdp, i)))
                dead = 'przycisk submit bez formularza z obsluga';
            } else if (!types.includes('click')) {
              dead = 'przycisk bez nasluchiwacza click';
            }
          } else if (el.tag === 'input' && ['checkbox', 'radio'].includes(el.type)) {
            if (!types.some((t) => ['change', 'input', 'click'].includes(t)))
              dead = 'pole wyboru bez obslugi zmiany';
          } else if (el.tag === 'select') {
            if (!types.some((t) => ['change', 'input'].includes(t)))
              dead = 'lista bez obslugi zmiany';
          } else if (el.tag === 'input' || el.tag === 'textarea') {
            if (
              !el.readOnly &&
              !el.disabled &&
              !types.some((t) => ['change', 'input'].includes(t))
            ) {
              dead = 'pole tekstowe bez obslugi zmiany';
            }
          }
          if (action === '') action = '(brak)';

          rows.push({
            view: scene.view,
            scene: scene.id,
            key: `${el.tag}|${el.testid !== '' ? el.testid : el.name}`,
            tag: el.tag,
            type: el.type,
            name: el.name,
            testid: el.testid,
            disabled: el.disabled,
            action,
            dead,
          });
        }
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    });
  });
}

test('lista kontrolek bez dzialania jest pusta', () => {
  const dead = rows.filter((row) => row.dead !== null);
  expect(
    dead.map((row) => `[${row.scene}] ${row.tag} "${row.name}" (${row.testid}): ${row.dead}`),
    'martwe kontrolki',
  ).toEqual([]);
  expect(rows.length, 'inwentaryzacja zebrala kontrolki').toBeGreaterThan(100);
});

test('kazda kontrolka, ktora pojawia sie w widoku, jest gdzies wlaczona', () => {
  // Kontrolka zawsze zablokowana we wszystkich scenach, w ktorych sie pojawia, jest podejrzana:
  // albo jest atrapa, albo scena nie pokazuje jej w stanie aktywnym. Lista idzie do raportu.
  const byKey = new Map<string, { enabled: boolean; scenes: Set<string>; name: string }>();
  for (const row of rows) {
    const k = `${row.view}|${row.key}`;
    const entry = byKey.get(k) ?? { enabled: false, scenes: new Set<string>(), name: row.name };
    if (!row.disabled) entry.enabled = true;
    entry.scenes.add(row.scene);
    byKey.set(k, entry);
  }
  const neverEnabled = [...byKey.entries()]
    .filter(([, v]) => !v.enabled)
    .map(([k, v]) => `${k} (${[...v.scenes].join(', ')})`);
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/controls-never-enabled.json',
    JSON.stringify(neverEnabled, null, 2),
    'utf8',
  );
  expect(neverEnabled, 'kontrolki zawsze zablokowane').toEqual([]);
});
