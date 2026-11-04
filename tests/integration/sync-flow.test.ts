import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { removeTempTrees } from '../harness/isolation';
import { draft } from '../unit/library-fakes';

import { makeSyncStack } from './sync-fixture';

afterAll(() => {
  removeTempTrees();
});

const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);
const TOOL = ['claude-code'] as const;

async function exported() {
  const stack = makeSyncStack();
  const { item } = await stack.lib.service.create(draft());
  const plan = await stack.sync.plan([...TOOL], [item.id]);
  expect(plan.applicable).toBe(true);
  const applied = await stack.sync.apply(plan.syncId, true);
  expect(applied.results[0]?.verified).toBe(true);
  return { ...stack, item, skillFile: join(stack.skills, 'acme-review', 'SKILL.md') };
}

const statusOf = async (s: Awaited<ReturnType<typeof exported>>) =>
  (await s.sync.status([...TOOL])).items.find((i) => i.itemId === s.item.id)?.status;

describe('synchronizacja na plikach', () => {
  it('eksport, in-sync i idempotencja: ponowny plan jest pusty i bez kopii', async () => {
    const s = await exported();
    expect(await statusOf(s)).toBe('in-sync');
    const backups = readdirSync(join(s.userData, 'backups')).length;

    const again = await s.sync.plan([...TOOL], [s.item.id]);
    expect(again.plans).toEqual([]);
    expect(again.adoptions).toEqual([]);
    expect(again.applicable).toBe(false);
    expect(readdirSync(join(s.userData, 'backups')).length).toBe(backups);
    s.index.close();
  });

  it('reczna zmiana pliku daje tool-changed, a tool-wins aktualizuje biblioteke', async () => {
    const s = await exported();
    const original = readFileSync(s.skillFile, 'utf8');
    writeFileSync(s.skillFile, original.replace('Sprawdz zmiany.', 'Sprawdz zmiany recznie.'));
    expect(await statusOf(s)).toBe('tool-changed');

    const undecided = await s.sync.plan([...TOOL], [s.item.id]);
    expect(undecided.skipped).toHaveLength(1);
    expect(undecided.applicable).toBe(false);

    const plan = await s.sync.plan(
      [...TOOL],
      [s.item.id],
      [{ itemId: s.item.id, tool: 'claude-code', resolution: 'tool-wins' }],
    );
    expect(plan.adoptions[0]?.after).toContain('recznie');
    const applied = await s.sync.apply(plan.syncId, true);
    expect(applied.adopted[0]?.ok).toBe(true);

    const loaded = await s.lib.service.get(s.item.id);
    expect(loaded.item.content.body).toContain('recznie');
    expect(loaded.item.version.revision).toBe(2);
    expect(await statusOf(s)).toBe('in-sync');
    s.index.close();
  });

  it('zmiana w bibliotece to library-changed, a po obu stronach conflict z library-wins', async () => {
    const s = await exported();
    await s.lib.service.update(s.item.id, draft({ body: '# Acme review\n\nNowa tresc.\n' }));
    expect(await statusOf(s)).toBe('library-changed');

    writeFileSync(s.skillFile, 'reczna zmiana\n');
    expect(await statusOf(s)).toBe('conflict');

    const plan = await s.sync.plan(
      [...TOOL],
      [s.item.id],
      [{ itemId: s.item.id, tool: 'claude-code', resolution: 'library-wins' }],
    );
    expect(plan.applicable).toBe(true);
    await s.sync.apply(plan.syncId, true);
    expect(readFileSync(s.skillFile, 'utf8')).toContain('Nowa tresc.');
    expect(await statusOf(s)).toBe('in-sync');
    s.index.close();
  });

  it('usuniety plik to missing-in-tool', async () => {
    const s = await exported();
    const { rmSync } = await import('node:fs');
    rmSync(join(s.skills, 'acme-review'), { recursive: true });
    expect(await statusOf(s)).toBe('missing-in-tool');
    s.index.close();
  });

  it('rollback przywraca stan sprzed eksportu bajt w bajt, a cofniecie rollbacku eksport', async () => {
    const s = await exported();
    const written = readFileSync(s.skillFile, 'utf8');

    const entries = await s.history.list();
    const op = entries.find((e) => e.kind === 'sync');
    expect(op?.revertible).toBe(true);

    const plan = await s.history.rollback(op?.operationId ?? '');
    expect(plan.plan.applicable).toBe(true);
    expect(plan.plan.entries.every((e) => e.action === 'delete')).toBe(true);
    const done = await s.exports.apply(plan.planId, true);
    expect(done.verified).toBe(true);
    expect(existsSync(join(s.skills, 'acme-review'))).toBe(false);
    expect(readdirSync(s.skills)).toEqual([]);

    const after = await s.history.list();
    expect(after[0]?.kind).toBe('rollback');
    expect(after.find((e) => e.operationId === op?.operationId)?.revertible).toBe(false);
    await expect(s.history.rollback(op?.operationId ?? '')).rejects.toMatchObject({
      code: 'already-reverted',
    });

    const undo = await s.history.rollback(after[0]?.operationId ?? '');
    await s.exports.apply(undo.planId, true);
    expect(readFileSync(s.skillFile, 'utf8')).toBe(written);
    s.index.close();
  });

  it('rollback nadpisanego pliku wraca do poprzedniej tresci', async () => {
    const s = await exported();
    const first = readFileSync(s.skillFile, 'utf8');
    await s.lib.service.update(s.item.id, draft({ body: '# Acme review\n\nDruga wersja.\n' }));
    const plan = await s.sync.plan([...TOOL], [s.item.id]);
    await s.sync.apply(plan.syncId, true);
    expect(readFileSync(s.skillFile, 'utf8')).not.toBe(first);

    const op = (await s.history.list()).find((e) => e.kind === 'sync');
    const back = await s.history.rollback(op?.operationId ?? '');
    await s.exports.apply(back.planId, true);
    expect(readFileSync(s.skillFile, 'utf8')).toBe(first);
    s.index.close();
  });

  it('rollback eksportu przez dowiazanie usuwa dowiazanie', async () => {
    if (process.platform === 'win32') return;
    const s = makeSyncStack({ links: true });
    const { item } = await s.lib.service.create(draft());
    const plan = await s.sync.plan([...TOOL], [item.id]);
    await s.sync.apply(plan.syncId, true);
    const link = join(s.skills, 'acme-review');
    expect(existsSync(link)).toBe(true);

    const op = (await s.history.list()).find((e) => e.kind === 'sync');
    const back = await s.history.rollback(op?.operationId ?? '');
    expect(back.plan.entries[0]?.action).toBe('delete');
    await s.exports.apply(back.planId, true);
    expect(readdirSync(s.skills)).toEqual([]);
    s.index.close();
  });

  posixNonRoot(
    'blad w polowie zapisu zostawia stan jak przed, a ponowny przebieg domyka',
    async () => {
      const s = makeSyncStack();
      const a = (await s.lib.service.create(draft({ slug: 'acme-aaa' }))).item;
      const b = (await s.lib.service.create(draft({ slug: 'acme-bbb' }))).item;
      const plan = await s.sync.plan([...TOOL], [a.id, b.id]);
      expect(plan.applicable).toBe(true);

      chmodSync(s.skills, 0o500);
      try {
        let outcome: 'refused' | 'applied' = 'applied';
        try {
          const result = await s.sync.apply(plan.syncId, true);
          expect(result.results.every((r) => !r.verified || r.rolledBack === false)).toBe(true);
        } catch {
          outcome = 'refused';
        }
        void outcome;
      } finally {
        chmodSync(s.skills, 0o700);
      }
      expect(readdirSync(s.skills)).toEqual([]);

      const retry = await s.sync.plan([...TOOL], [a.id, b.id]);
      const done = await s.sync.apply(retry.syncId, true);
      expect(done.results[0]?.verified).toBe(true);
      expect(readdirSync(s.skills).sort()).toEqual(['acme-aaa', 'acme-bbb']);
      s.index.close();
    },
  );
});
