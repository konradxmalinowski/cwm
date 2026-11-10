import { expect } from '@playwright/test';

import {
  MUTATING_SCENES,
  SCENES,
  createContext,
  groupByWorld,
  type Scene,
  type SceneContext,
} from './scenes';
import { startWorld, type World, type WorldName } from './ui-world';

/** Jedna grupa: swiat i sceny, ktore w nim biegna. `mutating` zapisuje dane, wiec dostaje wlasny swiat. */
export interface SceneGroup {
  readonly title: string;
  readonly world: WorldName;
  readonly scenes: readonly Scene[];
}

/**
 * Zmienna `UI_SCENES` (wyrazenie regularne na identyfikator sceny) zaweza przebieg do wybranych
 * scen, zeby poprawiac jedna scene bez przechodzenia calego rejestru. Bez niej biegna wszystkie.
 */
export function sceneGroups(): SceneGroup[] {
  const filter = process.env['UI_SCENES'];
  const keep = (scene: Scene): boolean => filter === undefined || new RegExp(filter).test(scene.id);
  const groups: SceneGroup[] = [];
  for (const [world, scenes] of groupByWorld(SCENES)) {
    const picked = scenes.filter(keep);
    if (picked.length > 0) groups.push({ title: `swiat ${world}`, world, scenes: picked });
  }
  const mutating = MUTATING_SCENES.filter(keep);
  if (mutating.length > 0) {
    groups.push({ title: 'swiat seeded, sceny zapisujace', world: 'seeded', scenes: mutating });
  }
  return groups;
}

/**
 * Prowadzi kazda scene grupy w jednej instancji aplikacji. Blad sceny nie przerywa grupy:
 * zbieramy je wszystkie i zglaszamy razem, zeby jeden przebieg pokazywal pelny obraz.
 */
export async function runGroup(
  group: SceneGroup,
  body: (scene: Scene, ctx: SceneContext, world: World) => Promise<void>,
  prepare?: (world: World) => Promise<void>,
): Promise<void> {
  const world = await startWorld(group.world);
  const failures: string[] = [];
  // Bez limitu oczekiwanie na element, ktorego scena nie wywola, trwa do konca testu i jedna
  // zepsuta scena pochlania caly przebieg grupy.
  world.page.setDefaultTimeout(8_000);
  try {
    if (prepare !== undefined) await prepare(world);
    for (const scene of group.scenes) {
      const { ctx, cleanup } = createContext(world);
      try {
        await scene.reach(ctx);
        await body(scene, ctx, world);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`[${scene.id}] ${message.split('\n').slice(0, 6).join('\n    ')}`);
      } finally {
        await cleanup().catch(() => undefined);
      }
    }
  } finally {
    await world.app.close();
  }
  expect(failures, failures.join('\n')).toEqual([]);
}
