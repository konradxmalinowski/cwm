import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { systemClock } from '../../src/core/ports/clock';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type { SourceReader } from '../../src/core/ports/source-reader';
import type {
  DetectedRoot,
  ImportCandidate,
  ImportSkip,
  ToolAdapter,
} from '../../src/core/ports/tool-adapter';
import { ImportService } from '../../src/core/services/import/import-service';
import { LibraryService } from '../../src/core/services/library/library-service';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsLocationCatalog } from '../../src/infra/platform/locations';
import { FsSourceReader } from '../../src/infra/source/fs-source-reader';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { MemoryOperationLog, deterministicRandom, FakeClock } from '../unit/library-fakes';

afterAll(() => {
  removeTempTrees();
});

const posix = process.platform !== 'win32';

/**
 * Adapter testowy: czyta wylacznie przez `SourceReader`, tak jak prawdziwe. Tu sprawdzamy serwis
 * i czytnik razem (kryterium 1 i 4), a nie format Claude Code, ktorym zajmuja sie testy adapterow.
 */
class TestSkillsAdapter implements ToolAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Test';
  readonly rootKinds = ['skills' as const];

  async scan(root: DetectedRoot, reader: SourceReader) {
    const candidates: ImportCandidate[] = [];
    const skipped: ImportSkip[] = [];
    for (const entry of await reader.list(root.rootId, '')) {
      let dir = entry.name;
      if (entry.type === 'symlink') {
        const target = await reader.resolveSymlink(root.rootId, entry.name);
        if (target.relPath === null) {
          skipped.push({
            tool: this.id,
            rootId: root.rootId,
            relPath: entry.name,
            reason: 'symlink-outside',
            message: 'Dowiązanie wychodzi poza lokalizację.',
          });
          continue;
        }
        dir = target.relPath;
      } else if (entry.type !== 'directory') {
        skipped.push({
          tool: this.id,
          rootId: root.rootId,
          relPath: entry.name,
          reason: 'not-an-element',
          message: 'To nie jest skill.',
        });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await reader.read(root.rootId, `${dir}/SKILL.md`, 1024 * 1024);
      } catch {
        skipped.push({
          tool: this.id,
          rootId: root.rootId,
          relPath: entry.name,
          reason: 'not-an-element',
          message: 'Brak SKILL.md.',
        });
        continue;
      }
      const body = new TextDecoder().decode(bytes);
      candidates.push({
        tool: this.id,
        rootId: root.rootId,
        relPath: `${entry.name}/SKILL.md`,
        kind: 'skill',
        draft: {
          kind: 'skill',
          identity: { slug: entry.name, declaredName: null, aliases: [] },
          content: { title: entry.name, description: 'Opis.', descriptionOrigin: 'source', body },
          source: {
            snapshots: [
              {
                tool: this.id,
                files: [{ relPath: `${dir}/SKILL.md`, bytes, mode: null }],
                unmappedKeys: [],
              },
            ],
            importedFrom: null,
          },
        },
        warnings: [],
        // Katalog docelowy to ten sam plik niezaleznie od nazwy, pod ktora go widac.
        aliasKey: `${root.rootId}\0${dir}`,
      });
    }
    return { candidates, skipped };
  }
}

/** Odcisk calego drzewa: nazwy, typy, tresc plikow, cel dowiazan i czas modyfikacji. */
function fingerprint(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const key = relative(dir, full);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        result[key] = `link:${info.mtimeMs}`;
      } else if (info.isDirectory()) {
        result[key] = `dir:${info.mtimeMs}`;
        walk(full);
      } else {
        const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        result[key] = `file:${hash}:${info.mtimeMs}:${info.mode}`;
      }
    }
  };
  walk(dir);
  return result;
}

function build() {
  const base = createTempTree('acme-import-');
  const home = join(base, 'home');
  const skills = join(home, '.claude', 'skills');
  const outside = join(base, 'outside');
  mkdirSync(join(skills, 'acme-review'), { recursive: true });
  mkdirSync(join(skills, 'acme-notes'), { recursive: true });
  mkdirSync(join(skills, 'bez-skill-md'), { recursive: true });
  mkdirSync(join(outside, 'zewnetrzny'), { recursive: true });
  writeFileSync(join(skills, 'acme-review', 'SKILL.md'), '# Review\r\n\r\nSprawdz zmiany.\r\n');
  writeFileSync(join(skills, 'acme-notes', 'SKILL.md'), '# Notatki\n');
  writeFileSync(join(skills, 'plaski.md'), 'plaski plik\n');
  writeFileSync(join(outside, 'zewnetrzny', 'SKILL.md'), 'POZA-ROOTEM-NIE-IMPORTOWAC\n');
  if (posix) {
    symlinkSync('acme-notes', join(skills, 'acme-notes-alias'));
    symlinkSync(join(outside, 'zewnetrzny'), join(skills, 'wyjscie'));
  }

  const library = new LibraryService({
    store: new FsLibraryStore(join(base, 'userdata', 'library')),
    objects: new FsObjectStore(join(base, 'userdata', 'objects')),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(systemClock, deterministicRandom()),
    clock: new FakeClock(),
  });
  const catalog = new FsLocationCatalog({ platform: process.platform, homeDir: home, env: {} });
  const reader = new FsSourceReader((id) => catalog.resolvePath(id));
  const service = new ImportService({
    catalog,
    adapters: [new TestSkillsAdapter()],
    reader,
    library,
    clock: systemClock,
  });
  return { base, home, skills, outside, library, catalog, service };
}

describe('import nie modyfikuje zrodla (kryterium 1) i nie wychodzi poza root (kryterium 4)', () => {
  it('hash kazdego pliku drzewa zrodlowego jest ten sam przed i po scan oraz apply', async () => {
    const t = build();
    const before = fingerprint(t.home);
    const beforeOutside = fingerprint(t.outside);

    const roots = await t.service.detect();
    const skillsRoot = roots.find((r) => r.label === '~/.claude/skills');
    expect(skillsRoot?.exists).toBe(true);

    const scan = await t.service.scan([skillsRoot?.rootId ?? '']);
    const all = scan.candidates.map((c) => c.candidateId);
    const report = await t.service.apply({ scanToken: scan.scanToken, candidateIds: all });
    expect(report.failed).toEqual([]);
    expect(report.imported.length).toBeGreaterThan(0);

    // Powtorny skan i apply tez nic nie ruszaja.
    const again = await t.service.scan([skillsRoot?.rootId ?? '']);
    await t.service.apply({
      scanToken: again.scanToken,
      candidateIds: again.candidates.map((c) => c.candidateId),
    });

    expect(fingerprint(t.home)).toEqual(before);
    expect(fingerprint(t.outside)).toEqual(beforeOutside);
  });

  it.runIf(posix)(
    'alias to duplikat, dowiazanie poza root jest pominiete, a jego tresc nie wchodzi do biblioteki',
    async () => {
      const t = build();
      const [skillsRoot] = (await t.service.detect()).filter((r) => r.label === '~/.claude/skills');
      const scan = await t.service.scan([skillsRoot?.rootId ?? '']);

      const bySlug = new Map(scan.candidates.map((c) => [c.candidate.draft.identity.slug, c]));
      expect(bySlug.get('acme-notes')?.status).toBe('new');
      expect(bySlug.get('acme-notes-alias')?.status).toBe('duplicate');
      expect(bySlug.get('acme-notes-alias')?.duplicateOf).toBe(
        bySlug.get('acme-notes')?.candidateId,
      );
      expect(bySlug.has('wyjscie')).toBe(false);
      expect(scan.skipped.map((s) => [s.relPath, s.reason])).toEqual(
        expect.arrayContaining([
          ['wyjscie', 'symlink-outside'],
          ['plaski.md', 'not-an-element'],
          ['bez-skill-md', 'not-an-element'],
        ]),
      );

      await t.service.apply({
        scanToken: scan.scanToken,
        candidateIds: scan.candidates.map((c) => c.candidateId),
      });
      const stored = (await t.library.list()).items.map((i) => i.content.body).join('\n');
      expect(stored).not.toContain('POZA-ROOTEM');
      expect((await t.library.list()).items).toHaveLength(2);
    },
  );

  it('powtorny import tego samego drzewa nie tworzy duplikatow (kryterium 5)', async () => {
    const t = build();
    const [skillsRoot] = (await t.service.detect()).filter((r) => r.label === '~/.claude/skills');
    const first = await t.service.scan([skillsRoot?.rootId ?? '']);
    await t.service.apply({
      scanToken: first.scanToken,
      candidateIds: first.candidates.filter((c) => c.selectedByDefault).map((c) => c.candidateId),
    });
    const count = (await t.library.list()).items.length;

    const second = await t.service.scan([skillsRoot?.rootId ?? '']);
    const selected = second.candidates.filter((c) => c.selectedByDefault);
    expect(selected).toEqual([]);
    expect(second.candidates.filter((c) => c.status === 'unchanged').length).toBe(count);
    expect((await t.library.list()).items).toHaveLength(count);
  });

  it('pochodzenie w bibliotece to rootId i sciezka wzgledna, bez katalogu domowego', async () => {
    const t = build();
    const [skillsRoot] = (await t.service.detect()).filter((r) => r.label === '~/.claude/skills');
    const scan = await t.service.scan([skillsRoot?.rootId ?? '']);
    await t.service.apply({
      scanToken: scan.scanToken,
      candidateIds: scan.candidates.filter((c) => c.selectedByDefault).map((c) => c.candidateId),
    });
    for (const item of (await t.library.list()).items) {
      const origin = item.source.importedFrom;
      expect(origin?.rootId).toBe(skillsRoot?.rootId);
      expect(origin?.path).toMatch(/^acme-[a-z-]+\/SKILL\.md$/);
      expect(JSON.stringify(item)).not.toContain(t.home);
    }
  });
});
