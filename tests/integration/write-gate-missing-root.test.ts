import { rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { removeTempTrees } from '../harness/isolation';
import { entry, makeFixture, makePlan, text } from './write-gate-fixture';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');

describe('WriteGate: root, ktorego nie ma, a jego rodzic istnieje (ADR 0033)', () => {
  posixOnly(
    'probe daje recoverable, a apply tworzy root z trybem 0700 i plik w srodku',
    async () => {
      const f = makeFixture();
      const plan = makePlan([entry({ rootId: 'r-missing', relPath: 'acme/SKILL.md' })]);
      const probed = await f.gate.probe(plan);
      expect(probed.applicable).toBe(true);
      expect(probed.entries[0]?.recoverability?.status).toBe('recoverable');

      await f.gate.apply(probed, { planId: probed.planId });
      const root = join(f.tree, 'tool', 'nowy-root');
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(root, 'acme', 'SKILL.md'), 'utf8')).toBe('tresc\n');
    },
  );

  it('wpis katalogowy w nieistniejacym roocie tworzy root i katalog skilla', async () => {
    const f = makeFixture();
    const plan = makePlan([
      entry({
        rootId: 'r-missing',
        relPath: 'acme',
        content: null,
        files: [
          { relPath: 'SKILL.md', bytes: text('a\n') },
          { relPath: 'references/n.md', bytes: text('b\n') },
        ],
        materialization: 'copy',
      }),
    ]);
    const probed = await f.gate.probe(plan);
    expect(probed.applicable).toBe(true);
    await f.gate.apply(probed, { planId: probed.planId });
    expect(
      readFileSync(join(f.tree, 'tool', 'nowy-root', 'acme', 'references', 'n.md'), 'utf8'),
    ).toBe('b\n');
  });

  it('root, ktorego rodzica nie ma, nadal jest blokowany i nic nie powstaje', async () => {
    const f = makeFixture();
    rmSync(join(f.tree, 'tool'), { recursive: true, force: true });
    const plan = makePlan([entry({ rootId: 'r-missing', relPath: 'acme/SKILL.md' })]);
    const probed = await f.gate.probe(plan);
    expect(probed.entries[0]?.recoverability?.status).toBe('blocked');
    expect(probed.applicable).toBe(false);
    expect(existsSync(join(f.tree, 'tool'))).toBe(false);
  });
});
