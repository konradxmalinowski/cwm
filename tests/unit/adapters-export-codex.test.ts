import { resolve } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { createCodexAdapter } from '../../src/adapters/codex';
import type { ItemDraft, LoadedItem } from '../../src/core/model/item';
import type { ExportContext, ToolAdapter, ToolExporter } from '../../src/core/ports/tool-adapter';
import { FsSourceReader } from '../contract/support/fs-source-reader';
import {
  MemoryReader,
  candidatesToLoaded,
  detectedRoot,
  entryFor,
  scanEverything,
  text,
  toLoaded,
} from '../contract/support/export-helpers';

const adapter = createCodexAdapter() as ToolAdapter & ToolExporter;
const codex = resolve(__dirname, '..', 'fixtures', 'codex', 'home', '.codex');
const KINDS = ['skills', 'agents', 'agent-registry', 'global-instructions', 'hooks'] as const;
type Kind = (typeof KINDS)[number];
const roots = KINDS.map((k, i) => detectedRoot('codex', k, i));
const id = (kind: Kind): string => roots[KINDS.indexOf(kind)]!.rootId;
const FIXTURE_PATHS: Record<Kind, string> = {
  skills: resolve(codex, 'skills'),
  agents: resolve(codex, 'agents'),
  'agent-registry': resolve(codex, 'config.toml'),
  'global-instructions': resolve(codex, 'AGENTS.md'),
  hooks: resolve(codex, 'hooks.json'),
};
const fixtureReader = (): FsSourceReader =>
  new FsSourceReader(new Map(KINDS.map((k) => [id(k), FIXTURE_PATHS[k]])));

function draft(kind: ItemDraft['kind'], slug: string, extra: Partial<ItemDraft> = {}): ItemDraft {
  return {
    kind,
    identity: { slug, declaredName: slug, aliases: [] },
    content: { title: slug, description: 'Opis', descriptionOrigin: 'source', body: 'Tresc\n' },
    classification: { scope: 'private', secretFindings: [] },
    ...extra,
  };
}

function ctx(reader: MemoryReader | FsSourceReader, exists = true): ExportContext {
  return {
    roots: exists
      ? roots
      : roots.map((r, i) => (i === 2 ? { ...r, exists: false, active: false } : r)),
    reader,
    materialization: { directory: 'symlink', file: 'symlink' },
  };
}

function target(config: string | null = 'model = "acme"\n'): MemoryReader {
  const r = new MemoryReader();
  r.dir(id('skills')).dir(id('agents'));
  r.file(id('agent-registry'), 'config.toml', config);
  r.file(id('global-instructions'), 'AGENTS.md', '');
  r.file(id('hooks'), 'hooks.json', '{"hooks":{}}\n');
  return r;
}

describe('eksport Codeksa: skille i komendy', () => {
  it('skill z rozjechanym declaredName jest lossy z powodem (ADR 0026)', () => {
    const d = draft('skill', 'acme-dir', {
      identity: { slug: 'acme-dir', declaredName: 'Inna', aliases: [] },
    });
    const v = adapter.capabilities(toLoaded(d).item);
    expect(v.level).toBe('lossy');
    expect(v.reasons.join(' ')).toMatch(/Inna/);
  });

  it('skill bez frontmattera: name i description dopisane, werdykt lossy z addedAttributes', async () => {
    const d = draft('skill', 'acme-flat', {
      identity: { slug: 'acme-flat', declaredName: null, aliases: [] },
      content: {
        title: 't',
        description: 'Pierwszy akapit',
        descriptionOrigin: 'derived',
        body: 'Pierwszy akapit\n',
      },
    });
    const plan = await adapter.plan([toLoaded(d)], ctx(target()));
    const v = plan.verdicts[0]!.verdict;
    expect([v.level, v.addedAttributes]).toEqual(['lossy', ['name', 'description']]);
    const e = entryFor(plan, id('skills'), 'acme-flat')!;
    expect(text(e.files![0]!.bytes)).toBe(
      '---\nname: acme-flat\ndescription: Pierwszy akapit\n---\nPierwszy akapit\n',
    );
  });

  it('komenda staje sie skillem z lossy, a komenda i skill o tej samej nazwie to konflikt bez zapisu', async () => {
    const cmd = toLoaded(
      draft('command', 'acme-same', {
        identity: { slug: 'acme-same', declaredName: null, aliases: [] },
      }),
    );
    expect(adapter.capabilities(cmd.item).level).toBe('lossy');
    const solo = await adapter.plan([cmd], ctx(target()));
    expect(entryFor(solo, id('skills'), 'acme-same')?.action).toBe('link');

    const skill = toLoaded(draft('skill', 'acme-same'));
    const plan = await adapter.plan([cmd, skill], ctx(target()));
    expect(plan.entries).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.itemIds).toHaveLength(2);
    expect(plan.conflicts[0]?.reason).toMatch(/komenda/i);
    expect(plan.applicable).toBe(false);
  });

  it('dwa rozne skille z ta sama nazwa z frontmattera to konflikt (ADR 0026)', async () => {
    const a = toLoaded(
      draft('skill', 'dir-a', {
        identity: { slug: 'dir-a', declaredName: 'wspolna', aliases: [] },
      }),
    );
    const b = toLoaded(
      draft('skill', 'dir-b', {
        identity: { slug: 'dir-b', declaredName: 'wspolna', aliases: [] },
      }),
    );
    const plan = await adapter.plan([a, b], ctx(target()));
    expect(plan.entries).toEqual([]);
    expect(plan.conflicts[0]?.reason).toMatch(/wspolna/);
  });
});

describe('eksport Codeksa: agent w dwoch miejscach', () => {
  const agent = (): LoadedItem =>
    toLoaded(
      draft('agent', 'acme-a', {
        attributes: {
          reasoningDepth: 'deepest',
          presentation: { accentColor: 'red' },
          memoryScope: 'user',
        },
      }),
    );

  it('tworzy plik agenta w calosci i segment w config.toml, werdykt partial z utrata color i memory', async () => {
    const config = '# komentarz\nmodel = "acme"\n\n[features]\nx = true\n';
    const plan = await adapter.plan([agent()], ctx(target(config)));
    const file = entryFor(plan, id('agents'), 'acme-a.toml')!;
    expect(file.scope).toBe('whole-file');
    const tree = parse(text(file.content)) as Record<string, unknown>;
    expect(tree).toEqual({
      name: 'acme-a',
      description: 'Opis',
      model_reasoning_effort: 'xhigh',
      developer_instructions: 'Tresc\n',
    });
    const cfg = entryFor(plan, id('agent-registry'), 'config.toml')!;
    expect(cfg.scope).toBe('toml-segment');
    expect(text(cfg.content).startsWith(config)).toBe(true);
    expect((parse(text(cfg.content)) as { agents: unknown }).agents).toEqual({
      'acme-a': { description: 'Opis', config_file: 'agents/acme-a.toml' },
    });
    const v = plan.verdicts[0]!.verdict;
    expect(v.level).toBe('partial');
    expect(v.lostAttributes).toEqual(['color', 'memory']);
  });

  it('config.toml poza zakresem segmentera: odmowa i zaden plik agenta', async () => {
    const plan = await adapter.plan([agent()], ctx(target('[[agents]]\nname = "x"\n')));
    expect(plan.entries).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.reason).toMatch(/tablica tabel/);
  });

  it('brak config.toml: powstaje plik z samym segmentem agenta, parsowalny przez smol-toml', async () => {
    const plan = await adapter.plan([agent()], ctx(target(null), false));
    expect(plan.refusals).toEqual([]);
    const cfg = entryFor(plan, id('agent-registry'), 'config.toml')!;
    expect([cfg.action, cfg.scope, cfg.previous]).toEqual(['create', 'toml-segment', null]);
    expect(text(cfg.content)).toBe(
      '[agents.acme-a]\ndescription = "Opis"\nconfig_file = "agents/acme-a.toml"\n',
    );
    expect(parse(text(cfg.content))).toEqual({
      agents: { 'acme-a': { description: 'Opis', config_file: 'agents/acme-a.toml' } },
    });
    expect(entryFor(plan, id('agents'), 'acme-a.toml')?.action).toBe('create');
  });

  it('swiezy ~/.codex: skill, komenda, AGENTS.md i hooks.json powstaja z samej tresci zarzadzanej', async () => {
    const fresh = new MemoryReader();
    fresh.dir(id('skills')).dir(id('agents'));
    fresh.file(id('agent-registry'), 'config.toml', null);
    fresh.file(id('global-instructions'), 'AGENTS.md', null);
    fresh.file(id('hooks'), 'hooks.json', null);
    const absent = roots.map((r) => ({ ...r, exists: false, active: false }));
    const hook = toLoaded(
      draft('hook', 'Stop-1', {
        identity: { slug: 'Stop-1', declaredName: null, aliases: [] },
        attributes: {
          hook: {
            event: 'Stop',
            matcher: null,
            command: '/x.sh',
            pathStyle: 'absolute',
            timeoutSeconds: null,
          },
        },
      }),
    );
    const items = [
      toLoaded(draft('skill', 'acme-s')),
      toLoaded(draft('command', 'acme-c')),
      toLoaded(draft('global-instruction', 'instructions')),
      hook,
    ];
    const plan = await adapter.plan(items, {
      roots: absent,
      reader: fresh,
      materialization: { directory: 'symlink', file: 'symlink' },
    });
    expect(plan.refusals).toEqual([]);
    expect(entryFor(plan, id('skills'), 'acme-s')?.action).toBe('link');
    expect(entryFor(plan, id('skills'), 'acme-c')?.action).toBe('link');
    const md = entryFor(plan, id('global-instructions'), 'AGENTS.md')!;
    expect(md.action).toBe('create');
    expect(text(md.content)).toMatch(/^<!-- cwm:start -->\nTresc\n<!-- cwm:end -->\n$/);
    const hooks = entryFor(plan, id('hooks'), 'hooks.json')!;
    expect(hooks.action).toBe('create');
    expect(JSON.parse(text(hooks.content))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x.sh' }] }] },
    });
  });

  it('agent z fixture bez zmian jest unchanged w obu miejscach', async () => {
    const reader = fixtureReader();
    const items = candidatesToLoaded(await scanEverything(adapter, roots, reader)).filter(
      (i) => i.item.kind === 'agent' && i.item.identity.slug === 'acme-reviewer',
    );
    expect(items).toHaveLength(1);
    const plan = await adapter.plan(items, ctx(reader));
    expect(plan.refusals).toEqual([]);
    expect(plan.entries.map((e) => [e.relPath, e.action])).toEqual([
      ['acme-reviewer.toml', 'unchanged'],
      ['config.toml', 'unchanged'],
    ]);
  });
});

describe('eksport Codeksa: hooki i serwery MCP', () => {
  it('hook ze zdarzeniem nieznanym Codeksowi dostaje ostrzezenie, hook znany tylko partial', async () => {
    const mk = (event: string): LoadedItem =>
      toLoaded(
        draft('hook', `${event}-1`, {
          identity: { slug: `${event}-1`, declaredName: null, aliases: [] },
          attributes: {
            hook: {
              event,
              matcher: null,
              command: '/x.sh',
              pathStyle: 'absolute',
              timeoutSeconds: null,
            },
          },
        }),
      );
    const plan = await adapter.plan([mk('Stop'), mk('FooBar')], ctx(target()));
    expect(plan.verdicts.map((v) => v.verdict.level)).toEqual(['partial', 'partial']);
    const e = entryFor(plan, id('hooks'), 'hooks.json')!;
    expect(e.warnings.join(' ')).toMatch(/FooBar/);
    expect(Object.keys((JSON.parse(text(e.content)) as { hooks: object }).hooks).sort()).toEqual([
      'FooBar',
      'Stop',
    ]);
  });

  it('MCP: odmowa i zaden plik', async () => {
    const mcp = toLoaded(
      draft('tool-setting', 'mcp-x', {
        attributes: { toolSetting: { tool: 'codex', key: 'mcp_servers.x', value: {} } },
      }),
    );
    const plan = await adapter.plan([mcp], ctx(target()));
    expect(plan.entries).toEqual([]);
    expect(plan.refusals[0]?.reason).toMatch(/MCP/);
  });
});

/** Regresja z testu property-based: dopisane pola agenta Codeksa sa w werdykcie. */
describe('eksport Codeksa: werdykt agenta zapowiada dopisane pola', () => {
  it('agent bez name jest lossy z addedAttributes, a plik TOML ma name rowne slugowi', async () => {
    const item = toLoaded(
      draft('agent', 'acme-bez-nazwy', {
        identity: { slug: 'acme-bez-nazwy', declaredName: null, aliases: [] },
      }),
    );
    const verdict = adapter.capabilities(item.item);
    expect(verdict.level).toBe('lossy');
    expect(verdict.addedAttributes).toEqual(['name']);
    const reader = new MemoryReader();
    for (const k of KINDS) {
      if (k === 'agent-registry') reader.file(id(k), 'config.toml', '');
      else if (k === 'global-instructions') reader.file(id(k), 'AGENTS.md', '');
      else if (k === 'hooks') reader.file(id(k), 'hooks.json', '{}\n');
      else reader.dir(id(k));
    }
    const plan = await adapter.plan([item], {
      roots,
      reader,
      materialization: { directory: 'copy', file: 'copy' },
    });
    const file = entryFor(plan, id('agents'), 'acme-bez-nazwy.toml');
    expect((parse(text(file!.content)) as Record<string, unknown>)['name']).toBe('acme-bez-nazwy');
  });

  it('agent z name i opisem ze zrodla zostaje partial, bez addedAttributes', () => {
    const verdict = adapter.capabilities(toLoaded(draft('agent', 'acme-pelny')).item);
    expect(verdict.level).toBe('partial');
    expect(verdict.addedAttributes).toEqual([]);
  });
});
