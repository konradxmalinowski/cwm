import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';

import { parseFrontmatter } from '../../src/adapters/shared/frontmatter';
import { BLOCK_END, BLOCK_START } from '../../src/adapters/shared/marker-block';
import type { ItemDraft, LoadedItem, RootId } from '../../src/core/model/item';
import type { WritePlan } from '../../src/core/model/plan';
import type {
  DetectedRoot,
  ExportContext,
  RootKind,
  ToolAdapter,
  ToolExporter,
} from '../../src/core/ports/tool-adapter';
import { InstrumentedReader, FsSourceReader } from './support/fs-source-reader';
import {
  MemoryReader,
  candidatesToLoaded,
  detectedRoot,
  enc,
  entryFor,
  scanEverything,
  text,
  toLoaded,
} from './support/export-helpers';
import type { SourceReader } from '../../src/core/ports/source-reader';
import type { ContractRoot } from './adapter-contract';

export interface MemoryRootSpec {
  readonly kind: RootKind;
  /** Nazwa pliku dla rootu plikowego (`CLAUDE.md`, `config.toml`); brak oznacza katalog. */
  readonly fileName?: string;
  /** Poczatkowa zawartosc rootu plikowego. */
  readonly initial?: string;
}

export interface SharedFileCase {
  readonly rootKind: RootKind;
  readonly fileName: string;
  /** Plik realny: komentarze, sekcje obce, puste linie. Eksport go nie odrzuca (12.5). */
  readonly realistic: string;
  readonly item: () => LoadedItem;
  /** Czy po zastosowaniu plan ma te same wartosci poza zakresem zarzadzanym. */
  readonly parseOutside: (before: string, after: string) => void;
  readonly hostile: readonly {
    readonly name: string;
    readonly text: string;
    readonly message: RegExp;
  }[];
}

export interface ExportContractSpec {
  readonly name: string;
  readonly adapter: ToolAdapter & ToolExporter;
  /** Rooty fixture'a (jak w kontrakcie importu) i jego korzen. */
  readonly fixtureRoots: readonly ContractRoot[];
  readonly memoryRoots: readonly MemoryRootSpec[];
  readonly instructionFile: string;
  readonly shared: SharedFileCase;
}

const READ_METHODS = new Set(['list', 'read', 'resolveSymlink', 'mode']);

function synthetic(): Record<string, ItemDraft> {
  const base = {
    classification: { scope: 'private' as const, secretFindings: [] },
  };
  const content = (
    title: string,
    description: string,
    body: string,
    origin: 'source' | 'derived' = 'source',
  ) => ({
    title,
    description,
    descriptionOrigin: origin,
    body,
  });
  return {
    skill: {
      kind: 'skill',
      identity: { slug: 'acme-skill', declaredName: 'acme-skill', aliases: [] },
      content: content(
        'Acme skill',
        'Does acme things: carefully, "quoted" # not a comment',
        'Step one.\n\nStep two.\n',
      ),
      assets: [{ relPath: 'references/note.md', bytes: enc('note\n') }],
      ...base,
    },
    plainSkill: {
      kind: 'skill',
      identity: { slug: 'acme-plain-skill', declaredName: null, aliases: [] },
      content: content('Plain', 'Plain skill body', 'Plain skill body\n', 'derived'),
      ...base,
    },
    agent: {
      kind: 'agent',
      identity: { slug: 'acme-agent', declaredName: 'acme-agent', aliases: [] },
      content: content(
        'Acme agent',
        'Reviews acme changes: true or false?',
        'You review changes.\nPath C:\\acme\\x and """quotes""" and end"\n',
      ),
      attributes: {
        reasoningDepth: 'deep',
        presentation: { accentColor: 'blue' },
        memoryScope: 'user',
      },
      ...base,
    },
    command: {
      kind: 'command',
      identity: { slug: 'acme-cmd', declaredName: null, aliases: [] },
      content: content('Acme command', 'Runs the acme check', 'Run the check.\n'),
      ...base,
    },
    instruction: {
      kind: 'global-instruction',
      identity: { slug: 'instructions', declaredName: null, aliases: [] },
      content: content(
        'Instructions',
        'Acme rules',
        'Acme global rules.\n\nBe brief.\n',
        'derived',
      ),
      ...base,
    },
    hook: {
      kind: 'hook',
      identity: { slug: 'PostToolUse-1', declaredName: null, aliases: [] },
      content: content('PreToolUse (Bash)', '', '', 'derived'),
      attributes: {
        hook: {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: '/opt/acme/check.sh',
          pathStyle: 'absolute',
          timeoutSeconds: 5,
        },
      },
      ...base,
    },
    mcp: {
      kind: 'tool-setting',
      identity: { slug: 'mcp-acme', declaredName: null, aliases: [] },
      content: content('MCP acme', '', '', 'derived'),
      attributes: { toolSetting: { tool: 'claude-code', key: 'mcpServers.acme', value: {} } },
      ...base,
    },
    projectInstruction: {
      kind: 'project-instruction',
      identity: { slug: 'project-rules', declaredName: null, aliases: [] },
      content: content('Project', 'Project rules', 'Project rules.\n', 'derived'),
      ...base,
    },
  } as unknown as Record<string, ItemDraft>;
}

/**
 * Zestaw kontraktowy eksportu (ROADMAP Etap 4, kryterium 6): ten sam dla kazdego adaptera,
 * takze przyszlego. Zna tylko `ToolExporter` i `SourceReader`, nic o formatach narzedzia.
 */
export function describeExportContract(spec: ExportContractSpec): void {
  const { adapter } = spec;
  const tool = adapter.id;
  const drafts = synthetic();
  const d = (name: string): ItemDraft => {
    const draft = drafts[name];
    if (draft === undefined) throw new Error(`Brak szkicu ${name}`);
    return draft;
  };

  const rootsFor = (exists = true): DetectedRoot[] =>
    spec.memoryRoots.map((r, i) => detectedRoot(tool, r.kind, i, exists));

  function memoryTarget(): { reader: MemoryReader; roots: DetectedRoot[] } {
    const roots = rootsFor();
    const reader = new MemoryReader();
    spec.memoryRoots.forEach((r, i) => {
      const id = roots[i]?.rootId as RootId;
      if (r.fileName === undefined) reader.dir(id);
      else reader.file(id, r.fileName, r.initial ?? '');
    });
    return { reader, roots };
  }

  const ctxOf = (roots: readonly DetectedRoot[], reader: SourceReader): ExportContext => ({
    roots,
    reader,
    materialization: { directory: 'symlink', file: 'symlink' },
  });

  /** Fixture'owe elementy bez snapshotow (jak elementy utworzone w aplikacji), bez duplikatow. */
  async function fixtureItems(): Promise<LoadedItem[]> {
    const roots = spec.fixtureRoots.map((r, i) => detectedRoot(tool, r.kind, i));
    const reader = new FsSourceReader(
      new Map(spec.fixtureRoots.map((r, i) => [`${tool}:${i}`, r.dir])),
    );
    const candidates = await scanEverything(adapter, roots, reader);
    const seen = new Set<string>();
    const unique = candidates.filter((c) => {
      const key = `${c.kind}:${c.draft.identity.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return candidatesToLoaded(unique, { keepSnapshots: false });
  }

  function referencedIds(plan: WritePlan): Set<string> {
    return new Set(plan.entries.flatMap((e) => e.itemIds));
  }

  describe(`kontrakt eksportu: ${spec.name}`, () => {
    it('capabilities jest czysta i kazdy poziom ponizej full ma powody', () => {
      for (const draft of Object.values(drafts)) {
        const item = toLoaded(draft).item;
        const a = adapter.capabilities(item);
        const b = adapter.capabilities(item);
        expect(b).toEqual(a);
        if (a.level !== 'full') expect(a.reasons.length).toBeGreaterThan(0);
        for (const reason of a.reasons) expect(reason.length).toBeGreaterThan(10);
      }
      expect(adapter.capabilities(toLoaded(d('mcp')).item).level).toBe('unsupported');
    });

    it('element nieobslugiwany jest w refusals z powodem i nie daje zadnego wpisu', async () => {
      const { reader, roots } = memoryTarget();
      const items = [toLoaded(d('mcp')), toLoaded(d('projectInstruction'))];
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      expect(plan.entries).toEqual([]);
      expect(plan.refusals).toHaveLength(2);
      for (const r of plan.refusals) expect(r.reason.length).toBeGreaterThan(10);
      for (const v of plan.verdicts) expect(v.verdict.level).toBe('unsupported');
      expect(plan.conflicts).toEqual([]);
    });

    it('root nieistniejacy daje odmowe z powodem, bez wpisow i bez dotykania celu', async () => {
      const roots = rootsFor(false);
      const reader = new InstrumentedReader(new MemoryReader());
      const items = [
        toLoaded(d('skill')),
        toLoaded(d('agent')),
        toLoaded(d('command')),
        toLoaded(d('instruction')),
        toLoaded(d('hook')),
      ];
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      expect(plan.entries).toEqual([]);
      expect(plan.refusals).toHaveLength(items.length);
      for (const r of plan.refusals) expect(r.reason).toMatch(/nie istnieje|Nie wykryto/);
      expect(reader.calls).toEqual([]);
    });

    it('plan ma spojne metadane i nie uzywa niczego poza odczytem', async () => {
      const { reader: inner, roots } = memoryTarget();
      const reader = new InstrumentedReader(inner);
      const items = [
        toLoaded(d('skill')),
        toLoaded(d('plainSkill')),
        toLoaded(d('agent')),
        toLoaded(d('command')),
        toLoaded(d('instruction')),
        toLoaded(d('hook')),
        toLoaded(d('mcp')),
      ];
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      expect(plan.tool).toBe(tool);
      expect(plan.planId.length).toBeGreaterThan(0);
      expect(plan.verdicts.map((v) => v.itemId).sort()).toEqual(items.map((i) => i.item.id).sort());
      for (const call of reader.calls) expect(READ_METHODS.has(call)).toBe(true);
      const ids = new Set(roots.map((r) => r.rootId));
      for (const e of plan.entries) {
        expect(ids.has(e.rootId)).toBe(true);
        expect(e.relPath.startsWith('/')).toBe(false);
        expect(e.relPath.includes('..')).toBe(false);
        expect(e.relPath.includes('\\')).toBe(false);
        expect(e.recoverability).toBeNull();
        expect(e.itemIds.length).toBeGreaterThan(0);
        // Jeden z dwoch ksztaltow: plik albo katalog.
        expect((e.content !== null) !== (e.files !== null)).toBe(true);
      }
      expect(plan.applicable).toBe(plan.conflicts.length === 0);
    });

    it('wynik frontmattera YAML parsuje sie ponownie z tymi samymi wartosciami', async () => {
      const { reader, roots } = memoryTarget();
      const items = [toLoaded(d('skill')), toLoaded(d('agent')), toLoaded(d('command'))];
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      let checked = 0;
      for (const e of plan.entries) {
        const files =
          e.files ?? (e.content !== null ? [{ relPath: e.relPath, bytes: e.content }] : []);
        for (const f of files) {
          if (!f.relPath.endsWith('.md')) continue;
          const owner = items.find((i) => i.item.id === e.itemIds[0])!.item;
          if (owner.kind === 'skill' && f.relPath !== 'SKILL.md' && e.files !== null) continue;
          if (!text(f.bytes).startsWith('---')) continue;
          const fm = parseFrontmatter(text(f.bytes));
          expect(fm.present).toBe(true);
          expect(fm.issues).toEqual([]);
          expect(fm.unsupported).toEqual([]);
          const description = fm.data.get('description');
          if (description !== undefined) expect(description).toBe(owner.content.description);
          const name = fm.data.get('name');
          if (name !== undefined)
            expect(name).toBe(owner.identity.declaredName ?? owner.identity.slug);
          expect(fm.body).toBe(owner.content.body);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('wynik TOML parsuje sie niezaleznym parserem', async () => {
      const { reader, roots } = memoryTarget();
      const items = [toLoaded(d('agent')), toLoaded(d('skill')), toLoaded(d('hook'))];
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      for (const e of plan.entries) {
        if (e.content === null || !e.relPath.endsWith('.toml')) continue;
        const tree = parse(text(e.content)) as Record<string, unknown>;
        if (e.scope === 'whole-file') {
          expect(tree['description']).toBe(d('agent').content.description);
          expect(tree['developer_instructions']).toBe(d('agent').content.body);
        }
      }
    });

    it('idempotencja: plan na stanie po zastosowaniu ma same unchanged', async () => {
      const { reader, roots } = memoryTarget();
      const fixtures = await fixtureItems();
      const items = [
        ...fixtures,
        toLoaded(d('skill')),
        toLoaded(d('plainSkill')),
        toLoaded(d('agent')),
        toLoaded(d('command')),
        toLoaded(d('hook')),
        toLoaded(d('instruction')),
      ];
      // Fixture'owa instrukcja i syntetyczna celuja w ten sam plik: zostaje jedna.
      const unique = items.filter(
        (i, idx) =>
          i.item.kind !== 'global-instruction' ||
          items.findIndex((j) => j.item.kind === 'global-instruction') === idx,
      );
      const first = await adapter.plan(unique, ctxOf(roots, reader));
      expect(first.entries.length).toBeGreaterThan(0);
      reader.apply(first);
      const second = await adapter.plan(unique, ctxOf(roots, reader));
      expect(second.entries.length).toBe(first.entries.length);
      for (const e of second.entries)
        expect([e.relPath, e.action]).toEqual([e.relPath, 'unchanged']);
      expect(second.refusals.map((r) => [r.itemId, r.reason])).toEqual(
        first.refusals.map((r) => [r.itemId, r.reason]),
      );
      expect(second.conflicts.length).toBe(first.conflicts.length);
    });

    it('round-trip: import, eksport, import daje ten sam szkic tam, gdzie zgodnosc jest full', async () => {
      const fixtures = await fixtureItems();
      const items = [
        ...fixtures,
        toLoaded(d('skill')),
        toLoaded(d('agent')),
        toLoaded(d('command')),
        toLoaded(d('hook')),
      ].filter((i) => adapter.capabilities(i.item).level === 'full');
      expect(items.length).toBeGreaterThan(1);
      const { reader, roots } = memoryTarget();
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      expect(plan.refusals).toEqual([]);
      reader.apply(plan);
      const again = await scanEverything(adapter, roots, reader);
      for (const loaded of items) {
        const { item } = loaded;
        if (item.kind === 'global-instruction') continue;
        const found = again.find(
          (c) => c.kind === item.kind && c.draft.identity.slug === item.identity.slug,
        );
        expect(found, `${item.kind}:${item.identity.slug}`).toBeDefined();
        const back = found!.draft;
        expect(back.content.body).toBe(item.content.body);
        if (item.kind !== 'hook') {
          expect(back.content.description).toBe(item.content.description);
          expect(back.identity.declaredName ?? back.identity.slug).toBe(
            item.identity.declaredName ?? item.identity.slug,
          );
        }
        expect(back.attributes ?? {}).toEqual(item.attributes);
        expect((back.assets ?? []).map((a) => [a.relPath, text(a.bytes)])).toEqual(
          loaded.assets.map((a) => [a.relPath, text(a.bytes)]),
        );
      }
    });

    it('element z tego samego narzedzia i bez zmian odtwarza oryginalne bajty (unchanged)', async () => {
      const roots = spec.fixtureRoots.map((r, i) => detectedRoot(tool, r.kind, i));
      const reader = new FsSourceReader(
        new Map(spec.fixtureRoots.map((r, i) => [`${tool}:${i}`, r.dir])),
      );
      const candidates = await scanEverything(adapter, roots, reader);
      const seen = new Set<string>();
      const unique = candidates.filter((c) => {
        const key = `${c.kind}:${c.draft.identity.slug}`;
        return seen.has(key) ? false : (seen.add(key), true);
      });
      const items = candidatesToLoaded(unique).filter(
        (i) => adapter.capabilities(i.item).level !== 'unsupported',
      );
      const plan = await adapter.plan(items, ctxOf(roots, reader));
      const full = new Set(
        items
          .filter((i) => adapter.capabilities(i.item).level === 'full')
          .map((i) => i.item.id as string),
      );
      const touched = plan.entries.filter(
        (e) =>
          e.itemIds.some((id) => full.has(id)) && e.action !== 'unchanged' && e.action !== 'link',
      );
      expect(touched.map((e) => e.relPath)).toEqual([]);
    });

    describe('plik wspolny', () => {
      const sc = spec.shared;
      function sharedTarget(content: string | null): {
        reader: MemoryReader;
        roots: DetectedRoot[];
      } {
        const { reader, roots } = memoryTarget();
        const idx = spec.memoryRoots.findIndex((r) => r.kind === sc.rootKind);
        reader.file(roots[idx]!.rootId, sc.fileName, content);
        return { reader, roots };
      }
      const rootIdOf = (roots: readonly DetectedRoot[]): RootId =>
        roots[spec.memoryRoots.findIndex((r) => r.kind === sc.rootKind)]!.rootId;

      it('plik realny z komentarzami, sekcjami obcymi i pustymi liniami przechodzi preflight', async () => {
        const { reader, roots } = sharedTarget(sc.realistic);
        const item = sc.item();
        const plan = await adapter.plan([item], ctxOf(roots, reader));
        expect(plan.refusals).toEqual([]);
        const entry = plan.entries.find(
          (e) => e.rootId === rootIdOf(roots) && e.relPath === sc.fileName,
        );
        expect(entry).toBeDefined();
        expect(entry!.action).toBe('modify');
        expect(['toml-segment', 'json-key']).toContain(entry!.scope);
        sc.parseOutside(sc.realistic, text(entry!.content));
        // Zastosowany plan jest stanem docelowym: kolejny plan nic nie zmienia.
        reader.apply(plan);
        const again = await adapter.plan([item], ctxOf(roots, reader));
        expect(entryFor(again, rootIdOf(roots), sc.fileName)?.action).toBe('unchanged');
      });

      for (const hostile of sc.hostile) {
        it(`odmowa edycji: ${hostile.name}`, async () => {
          const { reader, roots } = sharedTarget(hostile.text);
          const item = sc.item();
          const plan = await adapter.plan([item], ctxOf(roots, reader));
          expect(plan.refusals).toHaveLength(1);
          expect(plan.refusals[0]?.reason).toMatch(hostile.message);
          expect(plan.entries.filter((e) => e.itemIds.includes(item.item.id))).toEqual([]);
        });
      }
    });

    describe('blok miedzy markerami (kryterium 7)', () => {
      const rootIdx = spec.memoryRoots.findIndex((r) => r.kind === 'global-instructions');
      const instruction = (): LoadedItem => toLoaded(d('instruction'));

      async function planWith(
        content: string | null,
      ): Promise<{ plan: WritePlan; rootId: RootId }> {
        const { reader, roots } = memoryTarget();
        const rootId = roots[rootIdx]!.rootId;
        reader.file(rootId, spec.instructionFile, content);
        return { plan: await adapter.plan([instruction()], ctxOf(roots, reader)), rootId };
      }

      it('blok istnieje: podmieniana jest tylko jego tresc, reszta pliku bajt w bajt', async () => {
        const before = `Wstep\n\n\n${BLOCK_START}\nstara tresc\n${BLOCK_END}\n\n  Koniec  \n`;
        const { plan, rootId } = await planWith(before);
        const e = entryFor(plan, rootId, spec.instructionFile)!;
        expect(e.scope).toBe('marker-block');
        expect(e.action).toBe('modify');
        const after = text(e.content);
        const head = `Wstep\n\n\n${BLOCK_START}\n`;
        const tail = `${BLOCK_END}\n\n  Koniec  \n`;
        expect(after.startsWith(head)).toBe(true);
        expect(after.endsWith(tail)).toBe(true);
        expect(after.slice(head.length, after.length - tail.length)).toBe(
          'Acme global rules.\n\nBe brief.\n',
        );
        expect(text(e.previous)).toBe(before);
      });

      it('plik bez markerow dostaje blok na koncu, a istniejaca tresc zostaje bajt w bajt', async () => {
        const before = 'Moje notatki.\r\n\r\nBez markerow.';
        const { plan, rootId } = await planWith(before);
        const e = entryFor(plan, rootId, spec.instructionFile)!;
        expect(e.action).toBe('modify');
        const after = text(e.content);
        expect(after.startsWith(before)).toBe(true);
        expect(after).toContain(BLOCK_START);
        expect(after.indexOf(BLOCK_START)).toBeGreaterThanOrEqual(before.length);
        expect(after.endsWith(`${BLOCK_END}\r\n`)).toBe(true);
        expect(e.warnings.length).toBeGreaterThan(0);
      });

      it('tresc zarzadzana bez markerow wymaga decyzji uzytkownika: konflikt, brak wpisu', async () => {
        const before = 'Cos na poczatku.\n\nAcme global rules.\n\nBe brief.\n\nI cos na koncu.\n';
        const { plan } = await planWith(before);
        expect(plan.entries).toEqual([]);
        expect(plan.conflicts).toHaveLength(1);
        expect(plan.conflicts[0]?.reason).toMatch(/znacznik/);
        expect(plan.applicable).toBe(false);
      });

      it('brak pliku daje plik z samym blokiem', async () => {
        const { plan, rootId } = await planWith(null);
        const e = entryFor(plan, rootId, spec.instructionFile)!;
        expect(e.action).toBe('create');
        expect(text(e.content)).toBe(
          `${BLOCK_START}\nAcme global rules.\n\nBe brief.\n${BLOCK_END}\n`,
        );
        expect(e.previous).toBeNull();
      });

      it('blok bez instrukcji w zbiorze jest sierota, nigdy usunieciem', async () => {
        const { reader, roots } = memoryTarget();
        const rootId = roots[rootIdx]!.rootId;
        reader.file(rootId, spec.instructionFile, `a\n${BLOCK_START}\nx\n${BLOCK_END}\n`);
        const plan = await adapter.plan([toLoaded(d('skill'))], ctxOf(roots, reader));
        expect(plan.orphans.map((o) => o.relPath)).toEqual([spec.instructionFile]);
        expect(plan.entries.every((e) => e.relPath !== spec.instructionFile)).toBe(true);
        expect(referencedIds(plan).size).toBeGreaterThan(0);
      });
    });
  });
}
