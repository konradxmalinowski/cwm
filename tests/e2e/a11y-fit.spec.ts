import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { removeTempTrees } from '../harness/isolation';
import { runGroup, sceneGroups } from './scene-runner';
import {
  gatingViolations,
  measureDialogFit,
  measureFit,
  readContrast,
  runAxe,
  setTheme,
  setWindowSize,
  AXE_EXCEPTIONS,
  type AxeFinding,
} from './ui-helpers';

/**
 * Kryteria 4 i 5 Etapu 8.
 *
 * Kryterium 4: axe-core (WCAG 2.0, 2.1, 2.2 A i AA oraz najlepsze praktyki) na kazdej scenie z
 * rejestru, czyli na kazdym widoku, kroku i oknie dialogowym, w ciemnym i jasnym motywie. Test
 * pada na bledach poziomu critical i serious. Wyjatki sa w `AXE_EXCEPTIONS` z regula i powodem.
 * Poziomy moderate i minor sa liczone i zapisywane do `test-results/axe-summary.json`, ale nie
 * blokuja: dotycza zalecen, nie bledow dostepnosci.
 *
 * Kryterium 5: okno 1024 x 700 (`BrowserWindow.setContentSize`), na kazdej scenie: brak
 * poziomego przewijania strony i elementow, brak przycietego tekstu bez pelnej wartosci w
 * `title`, okno dialogowe miesci sie w calosci.
 */

const WIDTH = 1024;
const HEIGHT = 700;

interface SceneAxe {
  readonly scene: string;
  readonly theme: 'dark' | 'light';
  readonly counts: Readonly<Record<string, number>>;
  readonly moderate: readonly AxeFinding[];
  readonly incomplete: readonly AxeFinding[];
}

const summary: SceneAxe[] = [];
let contrastReadings = 0;

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/axe-summary.json',
    JSON.stringify({ exceptions: AXE_EXCEPTIONS, contrastReadings, scenes: summary }, null, 2),
    'utf8',
  );
  removeTempTrees();
});

for (const group of sceneGroups()) {
  test(`axe w obu motywach i okno ${WIDTH} x ${HEIGHT}: ${group.title}`, async () => {
    test.setTimeout(420_000);
    await runGroup(
      group,
      async (scene, ctx) => {
        const problems: string[] = [];

        for (const theme of ['dark', 'light'] as const) {
          await setTheme(ctx.page, theme);
          const scan = await runAxe(ctx.page);
          summary.push({
            scene: scene.id,
            theme,
            counts: scan.counts,
            moderate: scan.violations.filter(
              (v) => v.impact === 'moderate' || v.impact === 'minor',
            ),
            incomplete: scan.incomplete,
          });
          // Drugi poziom: elementy, ktorych axe nie rozstrzygnal, liczymy sami.
          const undecided = [
            ...new Set(
              scan.incomplete.filter((f) => f.rule === 'color-contrast').map((f) => f.target),
            ),
          ];
          const readings = await readContrast(ctx.page, undecided);
          contrastReadings += readings.length;
          for (const reading of readings) {
            if (reading.ratio < reading.required) {
              problems.push(
                `kontrast ${theme} ${reading.ratio}:1 < ${reading.required}:1 (${reading.foreground} na ${reading.background}): ${reading.target}`,
              );
            }
          }
          for (const finding of gatingViolations(scan)) {
            problems.push(
              `axe ${theme} ${finding.impact} ${finding.rule}: ${finding.target} | ${finding.summary.slice(0, 160)}`,
            );
          }
        }
        await setTheme(ctx.page, 'dark');

        const fit = await measureFit(ctx.page);
        if (fit.pageOverflow > 0)
          problems.push(`okno: strona przewija sie poziomo o ${fit.pageOverflow} px`);
        for (const s of fit.scrollers) problems.push(`okno: element przewija sie poziomo ${s}`);
        for (const c of fit.clipped)
          problems.push(`okno: przyciety tekst bez pelnej wartosci ${c}`);
        for (const d of await measureDialogFit(ctx.page))
          problems.push(`okno: dialog wystaje ${d}`);

        expect(problems, problems.join('\n')).toEqual([]);
      },
      async (world) => {
        // DESIGN.md, Motion: przy `prefers-reduced-motion` wiersze po prostu sa. Audyt mierzy stan
        // koncowy, a nie klatke animacji wejscia (axe liczy kontrast z biezacej przezroczystosci).
        await world.page.emulateMedia({ reducedMotion: 'reduce' });
        await setWindowSize(world.app, world.page, WIDTH, HEIGHT);
      },
    );
  });
}
