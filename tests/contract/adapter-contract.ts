import { isAbsolute } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ITEM_KINDS, type RootId } from '../../src/core/model/item';
import type {
  DetectedRoot,
  RootKind,
  ScanResult,
  ToolAdapter,
} from '../../src/core/ports/tool-adapter';
import { validateSlug } from '../../src/core/services/library/validate';
import { removeTempTrees } from '../harness/isolation';
import { FsSourceReader, InstrumentedReader, hashTree, plain } from './support/fs-source-reader';

export interface ContractRoot {
  readonly kind: RootKind;
  /** Katalog roota na dysku. */
  readonly dir: string;
  readonly active?: boolean;
}

export interface ContractSpec {
  readonly name: string;
  readonly adapter: ToolAdapter;
  /** Korzen fixture'a, ktory test hashuje przed i po skanie. */
  readonly fixtureDir: string;
  readonly roots: readonly ContractRoot[];
}

const READ_METHODS = new Set(['list', 'read', 'resolveSymlink', 'mode']);

/**
 * Zestaw kontraktowy z ARCHITECTURE 5 i ROADMAP (Etap 3): ten sam dla kazdego adaptera, takze
 * przyszlego. Zna tylko `ToolAdapter` i `SourceReader`, nic o formatach konkretnego narzedzia.
 */
export function describeAdapterContract(spec: ContractSpec): void {
  const { adapter } = spec;

  function detected(root: ContractRoot, index: number, exists = true): DetectedRoot {
    return {
      rootId: rootId(index),
      tool: adapter.id,
      kind: root.kind,
      label: `~/${root.kind}`,
      exists,
      active: root.active ?? true,
    };
  }
  const rootId = (index: number): RootId => `${adapter.id}:${index}`;
  const readerFor = (): FsSourceReader =>
    new FsSourceReader(new Map(spec.roots.map((r, i) => [rootId(i), r.dir])));

  async function scanAll(
    reader: InstrumentedReader,
  ): Promise<{ root: DetectedRoot; result: ScanResult }[]> {
    const out: { root: DetectedRoot; result: ScanResult }[] = [];
    for (const [i, root] of spec.roots.entries()) {
      const d = detected(root, i);
      out.push({ root: d, result: await adapter.scan(d, reader) });
    }
    return out;
  }

  describe(`kontrakt adaptera: ${spec.name}`, () => {
    afterAll(() => {
      removeTempTrees();
    });

    it('deklaruje tozsamosc i rodzaje rootow', () => {
      expect(adapter.displayName.length).toBeGreaterThan(0);
      expect(adapter.rootKinds.length).toBeGreaterThan(0);
      expect(new Set(adapter.rootKinds).size).toBe(adapter.rootKinds.length);
      for (const r of spec.roots) expect(adapter.rootKinds).toContain(r.kind);
    });

    it('root nieistniejacy daje pusty wynik bez dotykania zrodla', async () => {
      const reader = new InstrumentedReader(readerFor());
      const result = await adapter.scan(detected(spec.roots[0]!, 0, false), reader);
      expect(result.candidates).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(reader.calls).toEqual([]);
    });

    it('rodzaj roota spoza rootKinds nie wywala skanu', async () => {
      const reader = new InstrumentedReader(readerFor());
      const unknownKind = 'rules' as const;
      expect(adapter.rootKinds).not.toContain(unknownKind);
      const result = await adapter.scan(
        { ...detected(spec.roots[0]!, 0), kind: unknownKind },
        reader,
      );
      expect(result.candidates).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.reason).toBe('unsupported');
    });

    it('kazdy kandydat ma poprawny szkic, slug i sciezki wzgledne', async () => {
      const scans = await scanAll(new InstrumentedReader(readerFor()));
      const all = scans.flatMap((s) => s.result.candidates);
      expect(all.length).toBeGreaterThan(0);
      for (const { root, result } of scans) {
        for (const c of result.candidates) {
          expect(c.tool).toBe(adapter.id);
          expect(c.rootId).toBe(root.rootId);
          expect(isRelative(c.relPath)).toBe(true);
          expect(ITEM_KINDS).toContain(c.kind);
          expect(c.draft.kind).toBe(c.kind);
          expect(validateSlug(c.draft.identity.slug)).toBeNull();
          expect(c.draft.content.title.length).toBeGreaterThan(0);
          expect(c.draft.content.body).not.toContain('\r');
          const snaps = c.draft.source?.snapshots ?? [];
          expect(snaps).toHaveLength(1);
          expect(snaps[0]?.tool).toBe(adapter.id);
          const files = snaps[0]?.files ?? [];
          expect(files.length).toBeGreaterThan(0);
          expect(new Set(files.map((f) => f.relPath)).size).toBe(files.length);
          for (const f of files) expect(isRelative(f.relPath)).toBe(true);
          for (const w of c.warnings) {
            expect(w.code.length).toBeGreaterThan(0);
            expect(w.message.length).toBeGreaterThan(0);
          }
        }
        for (const s of result.skipped) {
          expect(s.tool).toBe(adapter.id);
          expect(s.rootId).toBe(root.rootId);
          expect(s.message.length).toBeGreaterThan(0);
        }
      }
    });

    it('wynik nie niesie sciezek bezwzglednych', async () => {
      const scans = await scanAll(new InstrumentedReader(readerFor()));
      const json = JSON.stringify(plain(scans.map((s) => s.result)));
      for (const r of spec.roots) expect(json).not.toContain(r.dir);
      expect(json).not.toContain(spec.fixtureDir);
    });

    it('skan jest deterministyczny', async () => {
      const a = await scanAll(new InstrumentedReader(readerFor()));
      const b = await scanAll(new InstrumentedReader(readerFor()));
      expect(plain(a.map((s) => s.result))).toEqual(plain(b.map((s) => s.result)));
    });

    it('nie modyfikuje zrodla: tylko metody odczytu i identyczne odciski plikow (kryterium 1)', async () => {
      const before = hashTree(spec.fixtureDir);
      const reader = new InstrumentedReader(readerFor());
      await scanAll(reader);
      expect(reader.calls.length).toBeGreaterThan(0);
      for (const call of reader.calls) expect(READ_METHODS.has(call)).toBe(true);
      expect(hashTree(spec.fixtureDir)).toEqual(before);
    });

    it('blad odczytu kazdego pliku daje ImportSkip i nie przerywa skanu (kryterium 8)', async () => {
      for (const failure of ['permission-denied', 'too-large', 'not-found', 'unknown'] as const) {
        const reader = new InstrumentedReader(readerFor(), () => ({ failure }));
        const scans = await scanAll(reader);
        const skipped = scans.flatMap((s) => s.result.skipped);
        expect(skipped.length).toBeGreaterThan(0);
        if (failure === 'too-large') {
          expect(skipped.some((s) => s.reason === 'too-large')).toBe(true);
        }
        for (const s of skipped) expect(s.message.length).toBeGreaterThan(0);
        // Gdy nic nie da sie przeczytac, zaden element nie powstaje.
        expect(scans.flatMap((s) => s.result.candidates)).toEqual([]);
      }
    });

    it('nieczytelny plik wylacza tylko swoj element, z nazwa pliku w komunikacie', async () => {
      const base = await scanAll(new InstrumentedReader(readerFor()));
      const victim = base
        .flatMap((s) => s.result.candidates.map((c) => ({ root: s.root, c })))
        .find(({ c }) => c.kind !== 'hook' && !c.relPath.includes('#'));
      expect(victim).toBeDefined();
      const file = victim!.c.draft.source!.snapshots[0]!.files[0]!.relPath;
      const baseName = file.slice(file.lastIndexOf('/') + 1);
      const prefix = victim!.c.relPath;

      const reader = new InstrumentedReader(readerFor(), (rel) =>
        rel.startsWith(prefix) && rel.endsWith(baseName) ? { failure: 'permission-denied' } : null,
      );
      const scans = await scanAll(reader);
      const after = scans.find((s) => s.root.rootId === victim!.root.rootId)!.result;
      const before = base.find((s) => s.root.rootId === victim!.root.rootId)!.result;

      expect(after.candidates.some((c) => c.relPath === prefix)).toBe(false);
      expect(after.candidates.length).toBe(before.candidates.length - 1);
      const skip = after.skipped.find(
        (s) => s.relPath.startsWith(prefix) && s.message.includes(baseName),
      );
      expect(skip?.reason).toBe('unreadable');
    });
  });
}

function isRelative(relPath: string): boolean {
  return (
    relPath !== '' &&
    !isAbsolute(relPath) &&
    !relPath.startsWith('/') &&
    !relPath.includes('\\') &&
    !relPath.split('/').includes('..')
  );
}
