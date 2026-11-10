import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { STALE_TEMP_AGE_MS } from '../../src/infra/fs/atomic';
import { removeTempTrees } from '../harness/isolation';
import { draft } from '../unit/library-fakes';

import { makeSyncStack } from './sync-fixture';

/**
 * Korpus 12.3, "przerwana synchronizacja", i klasa atomowosci z 12.4: przerwanie w polowie
 * `apply`, po zapisie pierwszego elementu, a przed drugim. Dwa warianty, bo zostawiaja rozny
 * stan: blad (WriteGate cofa zapis) i proces, ktory przestal istniec (nikt nic nie cofa).
 * W obu ponowny przebieg ma domknac operacje, a kolejny plan ma byc pusty (idempotencja).
 */

afterAll(() => {
  removeTempTrees();
});

const TOOL = ['claude-code'] as const;
const SECOND = `${sep}acme-bbb${sep}`;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function twoSkills(stack: ReturnType<typeof makeSyncStack>) {
  const a = (await stack.lib.service.create(draft({ slug: 'acme-aaa', body: 'Pierwszy.\n' }))).item;
  const b = (await stack.lib.service.create(draft({ slug: 'acme-bbb', body: 'Drugi.\n' }))).item;
  return [a.id, b.id] as const;
}

/** Wszystko, co lezy w drzewie skilli, z trescia: stan, ktory widzi narzedzie. */
function toolTree(skills: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of readdirSync(skills)) {
    for (const file of readdirSync(join(skills, dir))) {
      out[`${dir}/${file}`] = readFileSync(join(skills, dir, file), 'utf8');
    }
  }
  return out;
}

async function finishAndCheck(stack: ReturnType<typeof makeSyncStack>, ids: readonly string[]) {
  const retry = await stack.sync.plan([...TOOL], ids);
  expect(retry.applicable).toBe(true);
  const done = await stack.sync.apply(retry.syncId, true);
  expect(done.results.every((r) => r.verified)).toBe(true);

  const tree = toolTree(stack.skills);
  expect(Object.keys(tree).sort()).toEqual(['acme-aaa/SKILL.md', 'acme-bbb/SKILL.md']);
  expect(tree['acme-aaa/SKILL.md']).toContain('Pierwszy.');
  expect(tree['acme-bbb/SKILL.md']).toContain('Drugi.');

  const status = await stack.sync.status([...TOOL]);
  expect(status.items.map((i) => i.status)).toEqual(['in-sync', 'in-sync']);
  const again = await stack.sync.plan([...TOOL], ids);
  expect(again.plans).toEqual([]);
  expect(again.applicable).toBe(false);
}

describe('przerwana synchronizacja w polowie apply (ARCHITECTURE 12.3, 12.4)', () => {
  it('blad przy drugim elemencie: zapis cofniety, kopia istnieje, ponowny przebieg domyka', async () => {
    const broken = makeSyncStack({
      atomicOps: {
        rename: async (from, to) => {
          if (to.includes(SECOND)) throw errno('EIO');
          await rename(from, to);
        },
      },
    });
    const ids = await twoSkills(broken);
    const plan = await broken.sync.plan([...TOOL], ids);
    expect(plan.applicable).toBe(true);

    const failed = await broken.sync.apply(plan.syncId, true);
    expect(failed.results.some((r) => r.rolledBack)).toBe(true);
    expect(failed.results.some((r) => r.verified)).toBe(false);
    // Atomowosc: pierwszy element, juz zapisany, zostal cofniety razem z drugim.
    expect(toolTree(broken.skills)).toEqual({});
    const backups = readdirSync(join(broken.userData, 'backups'));
    expect(backups.length).toBeGreaterThan(0);
    for (const id of backups) {
      expect(existsSync(join(broken.userData, 'backups', id, 'MANIFEST'))).toBe(true);
    }
    // Stan synchronizacji nie udaje sukcesu.
    const status = await broken.sync.status([...TOOL]);
    expect(status.items.map((i) => i.status)).toEqual(['never', 'never']);
    broken.index.close();

    const healed = makeSyncStack({ reuse: { tree: broken.tree, lib: broken.lib } });
    await finishAndCheck(healed, ids);
    healed.index.close();
  });

  it('proces znika po pierwszym elemencie: nic nie cofa, a ponowny start domyka bez smieci', async () => {
    let reached: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const dying = makeSyncStack({
      atomicOps: {
        rename: async (from, to) => {
          if (to.includes(SECOND)) {
            reached();
            // Zawieszenie na zawsze to model zabitego procesu: zadna linia po nim sie nie wykona.
            return new Promise<void>(() => undefined);
          }
          await rename(from, to);
        },
      },
    });
    const ids = await twoSkills(dying);
    const plan = await dying.sync.plan([...TOOL], ids);
    void dying.sync.apply(plan.syncId, true);
    await stalled;

    // Stan po "smierci": pierwszy skill zapisany, drugi nie ma SKILL.md.
    const left = toolTree(dying.skills);
    expect(left['acme-aaa/SKILL.md']).toContain('Pierwszy.');
    expect(left['acme-bbb/SKILL.md']).toBeUndefined();
    // Zapis drugiego pliku doszedl do pliku tymczasowego z pelna trescia i tam stanal.
    expect(Object.keys(left).filter((k) => k.startsWith('acme-bbb/.SKILL.md.'))).toHaveLength(1);
    // Kopia zapasowa powstaje przed pierwszym zapisem, wiec jest takze po przerwaniu.
    expect(readdirSync(join(dying.userData, 'backups')).length).toBeGreaterThan(0);
    dying.index.close();

    // Ten sam proces udaje zabity, wiec jego pid zyje: plik tymczasowy rozpoznaje sie po wieku.
    // Sciezke "pid nie zyje" sprawdza tests/integration/atomic.test.ts.
    const later = new Date(Date.now() + STALE_TEMP_AGE_MS + 60_000);
    const restarted = makeSyncStack({
      reuse: { tree: dying.tree, lib: dying.lib },
      gateClock: { now: () => later },
    });
    const status = await restarted.sync.status([...TOOL]);
    // Brak rekordu synchronizacji: aplikacja nie twierdzi, ze cokolwiek jest zsynchronizowane.
    expect(status.items.every((i) => i.status !== 'in-sync')).toBe(true);
    await finishAndCheck(restarted, ids);
    restarted.index.close();
  });
});
