import { expect, test } from '@playwright/test';

import { removeTempTrees } from '../harness/isolation';
import { runGroup, sceneGroups } from './scene-runner';
import { MUTATING_SCENES, SCENES, VIEWS, VIEW_STATES } from './scenes';

/**
 * Kryterium 2 Etapu 8: kazdy z szesciu widokow ma stan pusty, ladowania, sukcesu, ostrzezenia i
 * bledu, i kazdy da sie wywolac w tescie. Rejestr scen (`scenes.ts`) wie, jak dojsc do kazdego
 * stanu; ten plik sprawdza, co w nim widac. Ladowanie i blad powstaja przez podmiane handlera IPC
 * w procesie glownym (`ui-helpers.ts`), nigdy przez kod aplikacji.
 */

test.afterAll(() => {
  removeTempTrees();
});

test('rejestr scen pokrywa piec stanow w kazdym z szesciu widokow', () => {
  const all = [...SCENES, ...MUTATING_SCENES];
  const missing: string[] = [];
  for (const view of VIEWS) {
    for (const state of VIEW_STATES) {
      if (!all.some((scene) => scene.view === view && scene.state === state)) {
        missing.push(`${view}: ${state}`);
      }
    }
  }
  expect(missing, 'widok bez sceny dla stanu').toEqual([]);
  const ids = all.map((scene) => scene.id);
  expect(new Set(ids).size, 'identyfikatory scen sa unikalne').toBe(ids.length);
});

for (const group of sceneGroups()) {
  test(`stany widokow: ${group.title} (${group.scenes.length} scen)`, async () => {
    test.setTimeout(300_000);
    await runGroup(group, async (scene, ctx) => {
      await scene.assert(ctx);
    });
  });
}
