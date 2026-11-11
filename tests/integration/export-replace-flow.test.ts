import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { BLOCK_END, BLOCK_START } from '../../src/adapters/shared/marker-block';
import { scanEverything } from '../contract/support/export-helpers';
import { removeTempTrees } from '../harness/isolation';

import { makeSyncStack } from './sync-fixture';
import { treeHash } from './write-gate-fixture';

/** Pliki i ich tresc oraz tryb; bez trybow katalogow, bo cofniecie z historii tworzy je z 0700. */
function filesHash(root: string): string {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const info = lstatSync(abs);
      if (info.isDirectory()) walk(abs, `${rel}/${name}`);
      else
        out.push(`${rel}/${name} ${(info.mode & 0o777).toString(8)} ${readFileSync(abs, 'hex')}`);
    }
  };
  walk(root, '');
  return out.join('\n');
}

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');
const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

/** Import z prawdziwego katalogu narzedzia: skan adaptera, potem zapis do biblioteki. */
async function importFrom(
  stack: ReturnType<typeof makeSyncStack>,
  kind: string,
  slug: string | null,
) {
  const adapter = createClaudeCodeAdapter();
  const roots = (await stack.catalog.detect()).filter((r) => r.tool === 'claude-code');
  const candidates = await scanEverything(adapter, roots, stack.reader);
  const found = candidates.find(
    (c) => c.draft.kind === kind && (slug === null || c.draft.identity.slug === slug),
  );
  expect(found).toBeDefined();
  const created = await stack.lib.service.create(found!.draft);
  return { id: created.item.id, draft: found!.draft };
}

function seedSkill(stack: ReturnType<typeof makeSyncStack>): string {
  const dir = join(stack.skills, 'acme-x');
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: acme-x\ndescription: Skill testowy\n---\n\nStara tresc.\n',
  );
  writeFileSync(join(dir, 'references', 'a.md'), 'a\n');
  return dir;
}

describe('eksport skilla zaimportowanego ze zwyklego katalogu', () => {
  for (const links of [true, false]) {
    posixOnly(
      `zastepuje katalog, kopia ma stare pliki, rollback bajt w bajt (links=${links})`,
      async () => {
        const s = makeSyncStack({ links });
        const dir = seedSkill(s);
        const { id, draft } = await importFrom(s, 'skill', 'acme-x');
        // Plik dodany po imporcie nie jest w bibliotece, wiec nie ma go w planie.
        writeFileSync(join(dir, 'notatki.txt'), 'plik spoza planu\n');
        const original = filesHash(s.skills);
        await s.lib.service.update(id, {
          ...draft,
          content: { ...draft.content, body: 'Nowa tresc.\n' },
        });

        const plan = await s.exports.plan('claude-code', [id]);
        expect(plan.plan.applicable).toBe(true);
        const e = plan.plan.entries[0];
        expect(e?.action).toBe(links ? 'link' : 'modify');
        expect(e?.recoverability?.status).toBe('recoverable');
        expect(e?.warnings.join(' ')).toMatch(/Nadpisze/);
        expect(e?.warnings.join(' ')).toContain('notatki.txt');

        const applied = await s.exports.apply(plan.planId, true);
        expect(applied.verified).toBe(true);
        expect(lstatSync(dir).isSymbolicLink()).toBe(links);
        expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Nowa tresc.');
        expect(readdirSync(dir).sort()).toEqual(['SKILL.md', 'references']);

        const backup = JSON.parse(
          readFileSync(join(s.userData, 'backups', applied.backupId, 'MANIFEST'), 'utf8'),
        ) as { entries: { before: { files: { relPath: string; backupFile: string }[] } }[] };
        const saved = backup.entries[0]?.before.files ?? [];
        expect(saved.map((f) => f.relPath).sort()).toEqual([
          'SKILL.md',
          'notatki.txt',
          'references/a.md',
        ]);
        const notes = saved.find((f) => f.relPath === 'notatki.txt');
        expect(
          readFileSync(
            join(s.userData, 'backups', applied.backupId, notes?.backupFile ?? ''),
            'utf8',
          ),
        ).toBe('plik spoza planu\n');

        const again = await s.exports.plan('claude-code', [id]);
        expect(again.plan.entries.map((x) => x.action)).toEqual(['unchanged']);

        // Cofniecie z historii przywraca katalog w calosci.
        const op = (await s.history.list()).find((x) => x.revertible);
        const rollback = await s.history.rollback(op?.operationId ?? '');
        expect(rollback.plan.applicable).toBe(true);
        const done = await s.exports.apply(rollback.planId, true);
        expect(done.verified).toBe(true);
        expect(lstatSync(dir).isSymbolicLink()).toBe(false);
        expect(filesHash(s.skills)).toBe(original);
        s.index.close();
      },
    );
  }

  posixNonRoot('katalog z nieczytelnym plikiem daje wpis blocked i nic nie zmienia', async () => {
    const s = makeSyncStack({ links: true });
    const dir = seedSkill(s);
    const { id, draft } = await importFrom(s, 'skill', 'acme-x');
    writeFileSync(join(dir, 'notatki.txt'), 'plik spoza planu\n');
    await s.lib.service.update(id, { ...draft, content: { ...draft.content, body: 'Inna.\n' } });
    chmodSync(join(dir, 'notatki.txt'), 0o000);
    try {
      const before = treeHash(s.skills);
      const plan = await s.exports.plan('claude-code', [id]);
      expect(plan.plan.entries[0]?.recoverability?.status).toBe('blocked');
      expect(plan.plan.applicable).toBe(false);
      expect(treeHash(s.skills)).toBe(before);
    } finally {
      chmodSync(join(dir, 'notatki.txt'), 0o644);
    }
    s.index.close();
  });
});

describe('eksport instrukcji globalnej zaimportowanej w calosci (ADR 0025, regula 3)', () => {
  const IMPORTED = '# Moje zasady\n\nBadz zwiezly.\n';

  async function prepared() {
    const s = makeSyncStack();
    const file = join(s.home, '.claude', 'CLAUDE.md');
    writeFileSync(file, IMPORTED);
    const { id, draft } = await importFrom(s, 'global-instruction', null);
    await s.lib.service.update(id, {
      ...draft,
      content: { ...draft.content, body: '# Moje zasady\n\nBadz bardzo zwiezly.\n' },
    });
    return { s, file, id };
  }

  it('bez decyzji plan ma konflikt z opcjami i nie jest wykonywalny', async () => {
    const { s, file, id } = await prepared();
    const plan = await s.exports.plan('claude-code', [id]);
    expect(plan.plan.conflicts).toHaveLength(1);
    expect(plan.plan.conflicts[0]?.options?.map((o) => o.id)).toEqual([
      'replace-fragment',
      'append-block',
    ]);
    expect(plan.plan.applicable).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(IMPORTED);
    s.index.close();
  });

  it('zamien: plik ma tresc raz, w bloku aplikacji, a drugi plan jest pusty', async () => {
    const { s, file, id } = await prepared();
    const plan = await s.exports.plan(
      'claude-code',
      [id],
      [{ itemId: id, relPath: 'CLAUDE.md', resolution: 'replace-fragment' }],
    );
    expect(plan.plan.applicable).toBe(true);
    const applied = await s.exports.apply(plan.planId, true);
    expect(applied.verified).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(
      `${BLOCK_START}\n# Moje zasady\n\nBadz bardzo zwiezly.\n${BLOCK_END}\n`,
    );
    const again = await s.exports.plan('claude-code', [id]);
    expect(again.plan.conflicts).toEqual([]);
    expect(again.plan.entries.map((x) => x.action)).toEqual(['unchanged']);
    s.index.close();
  });

  it('dopisz: stary tekst zostaje, blok na koncu', async () => {
    const { s, file, id } = await prepared();
    const plan = await s.exports.plan(
      'claude-code',
      [id],
      [{ itemId: id, relPath: 'CLAUDE.md', resolution: 'append-block' }],
    );
    expect(plan.plan.applicable).toBe(true);
    await s.exports.apply(plan.planId, true);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(IMPORTED)).toBe(true);
    expect(after.endsWith(`${BLOCK_END}\n`)).toBe(true);
    expect(after.match(/Badz/g)).toHaveLength(2);
    s.index.close();
  });
});
