import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { parseFrontmatter } from '../../src/adapters/shared/frontmatter';
import type { ItemDraft, LoadedItem } from '../../src/core/model/item';
import type { ExportContext, ToolAdapter, ToolExporter } from '../../src/core/ports/tool-adapter';
import { FsSourceReader } from '../contract/support/fs-source-reader';
import {
  MemoryReader,
  candidatesToLoaded,
  detectedRoot,
  enc,
  entryFor,
  scanEverything,
  text,
  toLoaded,
} from '../contract/support/export-helpers';

const adapter = createClaudeCodeAdapter() as ToolAdapter & ToolExporter;
const claude = resolve(__dirname, '..', 'fixtures', 'claude-code', 'home', '.claude');
const KINDS = ['skills', 'agents', 'commands', 'global-instructions', 'hooks'] as const;
type Kind = (typeof KINDS)[number];
const roots = KINDS.map((k, i) => detectedRoot('claude-code', k, i));
const id = (kind: Kind): string => roots[KINDS.indexOf(kind)]!.rootId;
const FIXTURE_PATHS: Record<Kind, string> = {
  skills: resolve(claude, 'skills'),
  agents: resolve(claude, 'agents'),
  commands: resolve(claude, 'commands'),
  'global-instructions': resolve(claude, 'CLAUDE.md'),
  hooks: resolve(claude, 'settings.json'),
};
const fixtureReader = (): FsSourceReader =>
  new FsSourceReader(new Map(KINDS.map((k) => [id(k), FIXTURE_PATHS[k]])));

function draft(kind: ItemDraft['kind'], slug: string, extra: Partial<ItemDraft> = {}): ItemDraft {
  return {
    kind,
    identity: { slug, declaredName: null, aliases: [] },
    content: { title: slug, description: 'Opis', descriptionOrigin: 'source', body: 'Tresc\n' },
    classification: { scope: 'private', secretFindings: [] },
    ...extra,
  };
}

function ctx(
  reader: MemoryReader | FsSourceReader,
  mode: 'symlink' | 'copy' = 'symlink',
): ExportContext {
  return { roots, reader, materialization: { directory: mode, file: mode } };
}

function target(files: Partial<Record<Kind, string | null>> = {}): MemoryReader {
  const r = new MemoryReader();
  for (const k of KINDS) {
    if (k === 'global-instructions') r.file(id(k), 'CLAUDE.md', files[k] ?? '');
    else if (k === 'hooks')
      r.file(id(k), 'settings.json', files[k] === undefined ? '{}\n' : files[k]);
    else r.dir(id(k));
  }
  return r;
}

async function fixtureLoaded(): Promise<LoadedItem[]> {
  return candidatesToLoaded(await scanEverything(adapter, roots, fixtureReader()));
}

describe('eksport Claude Code: wpisy i zakresy', () => {
  it('skill: katalog z SKILL.md i assetami jako wpis katalogowy link z trybem z kontekstu', async () => {
    const item = toLoaded(
      draft('skill', 'acme-s', { assets: [{ relPath: 'scripts/run.sh', bytes: enc('echo\n') }] }),
    );
    const plan = await adapter.plan([item], ctx(target()));
    const e = entryFor(plan, id('skills'), 'acme-s')!;
    expect(e.action).toBe('link');
    expect(e.scope).toBe('whole-file');
    expect(e.materialization).toBe('symlink');
    expect(e.content).toBeNull();
    expect(e.files?.map((f) => f.relPath)).toEqual(['SKILL.md', 'scripts/run.sh']);
    const copy = await adapter.plan([item], ctx(target(), 'copy'));
    const c = entryFor(copy, id('skills'), 'acme-s')!;
    expect([c.action, c.materialization]).toEqual(['create', 'copy']);
  });

  it('slug jest nazwa katalogu, a declaredName zostaje we frontmatterze (ADR 0026)', async () => {
    const item = toLoaded(
      draft('skill', 'acme-dir', {
        identity: { slug: 'acme-dir', declaredName: 'Inna Nazwa', aliases: [] },
      }),
    );
    const plan = await adapter.plan([item], ctx(target()));
    const e = entryFor(plan, id('skills'), 'acme-dir')!;
    expect(parseFrontmatter(text(e.files![0]!.bytes)).data.get('name')).toBe('Inna Nazwa');
    expect(plan.verdicts[0]?.verdict.level).toBe('full');
  });

  it('agent: frontmatter z pieciu kluczy w stalej kolejnosci, model z glebokosci rozumowania', async () => {
    const item = toLoaded(
      draft('agent', 'acme-a', {
        attributes: {
          reasoningDepth: 'deepest',
          presentation: { accentColor: 'red' },
          memoryScope: 'user',
        },
      }),
    );
    const plan = await adapter.plan([item], ctx(target()));
    const e = entryFor(plan, id('agents'), 'acme-a.md')!;
    expect(text(e.content)).toBe(
      '---\nname: acme-a\ndescription: Opis\nmodel: opus\ncolor: red\nmemory: user\n---\nTresc\n',
    );
    expect(e.action).toBe('create');
  });

  it('komenda: commands/<slug>.md', async () => {
    const plan = await adapter.plan([toLoaded(draft('command', 'acme-c'))], ctx(target()));
    expect(text(entryFor(plan, id('commands'), 'acme-c.md')!.content)).toBe(
      '---\ndescription: Opis\n---\nTresc\n',
    );
  });

  it('tresc zaczynajaca sie od --- nie jest brana za frontmatter', async () => {
    const item = toLoaded(
      draft('command', 'acme-c', {
        content: {
          title: 't',
          description: 'x',
          descriptionOrigin: 'derived',
          body: '---\nlinia\n',
        },
      }),
    );
    const plan = await adapter.plan([item], ctx(target()));
    const out = text(entryFor(plan, id('commands'), 'acme-c.md')!.content);
    expect(parseFrontmatter(out).body).toBe('---\nlinia\n');
  });

  it('serwer MCP: odmowa z powodem i zaden plik', async () => {
    const mcp = toLoaded(
      draft('tool-setting', 'mcp-x', {
        attributes: { toolSetting: { tool: 'claude-code', key: 'mcpServers.x', value: {} } },
      }),
    );
    const plan = await adapter.plan([mcp], ctx(target()));
    expect(plan.entries).toEqual([]);
    expect(plan.refusals[0]?.reason).toMatch(/MCP/);
  });
});

describe('eksport Claude Code: wiernosc formatu na fixture', () => {
  it('skill plaski zostaje plaskim plikiem i jest unchanged', async () => {
    const flat = (await fixtureLoaded()).find((i) => i.item.identity.slug === 'acme-flat')!;
    const plan = await adapter.plan([flat], ctx(fixtureReader()));
    expect(plan.entries.map((e) => [e.relPath, e.action])).toEqual([['acme-flat.md', 'unchanged']]);
  });

  it('zmieniony agent z Claude zachowuje klucze frontmattera w kolejnosci zrodla', async () => {
    const items = await fixtureLoaded();
    const agent = items.find(
      (i) => i.item.kind === 'agent' && i.item.identity.slug === 'acme-reviewer',
    )!;
    const changed: LoadedItem = {
      ...agent,
      item: {
        ...agent.item,
        content: { ...agent.item.content, body: `${agent.item.content.body}Dodane.\n` },
      },
    };
    const original = text(agent.snapshotFiles.find((f) => f.tool === 'claude-code')!.bytes);
    const plan = await adapter.plan([changed], ctx(target()));
    const out = text(entryFor(plan, id('agents'), 'acme-reviewer.md')!.content);
    const before = parseFrontmatter(original);
    const after = parseFrontmatter(out);
    expect([...after.data.keys()]).toEqual([...before.data.keys()]);
    expect(after.body).toBe(`${before.body}Dodane.\n`);
  });

  it('CRLF zrodla zostaje CRLF przy przepisaniu zmienionego pliku', async () => {
    const source = '---\r\nname: acme-crlf\r\ndescription: Stary\r\n---\r\nTresc\r\n';
    const d = draft('command', 'acme-crlf', {
      identity: { slug: 'acme-crlf', declaredName: 'acme-crlf', aliases: [] },
      content: { title: 't', description: 'Nowy', descriptionOrigin: 'source', body: 'Tresc\n' },
      source: {
        importedFrom: null,
        snapshots: [
          {
            tool: 'claude-code',
            unmappedKeys: [],
            files: [{ relPath: 'acme-crlf.md', bytes: enc(source), mode: null }],
          },
        ],
      },
    });
    const plan = await adapter.plan([toLoaded(d)], ctx(target()));
    expect(text(entryFor(plan, id('commands'), 'acme-crlf.md')!.content)).toBe(
      '---\r\nname: acme-crlf\r\ndescription: Nowy\r\n---\r\nTresc\r\n',
    );
  });
});

describe('eksport Claude Code: hooki w settings.json', () => {
  const hook = (event: string, command: string): LoadedItem =>
    toLoaded(
      draft('hook', `${event}-1`, {
        attributes: {
          hook: { event, matcher: null, command, pathStyle: 'absolute', timeoutSeconds: null },
        },
      }),
    );

  it('zmienia tylko klucz hooks: wciecia tabulatorem i kolejnosc kluczy poza nim bez zmian', async () => {
    const before =
      '{\n\t"z_last": 1,\n\t"env": {"A": "b"},\n\t"hooks": {\n\t\t"Stop": []\n\t},\n\t"a_first": [1,\n 2]\n}\n';
    const plan = await adapter.plan(
      [hook('SessionStart', '/opt/x.sh')],
      ctx(target({ hooks: before })),
    );
    const e = entryFor(plan, id('hooks'), 'settings.json')!;
    expect(e.scope).toBe('json-key');
    expect(e.action).toBe('modify');
    const after = text(e.content);
    expect(after.slice(0, after.indexOf('"hooks"'))).toBe(
      before.slice(0, before.indexOf('"hooks"')),
    );
    expect(after.slice(after.indexOf('\t"a_first"'))).toBe(
      before.slice(before.indexOf('\t"a_first"')),
    );
    expect((JSON.parse(after) as Record<string, unknown>)['hooks']).toEqual({
      Stop: [],
      SessionStart: [{ hooks: [{ type: 'command', command: '/opt/x.sh' }] }],
    });
  });

  it('plik bez klucza hooks dostaje go na koncu obiektu', async () => {
    const plan = await adapter.plan(
      [hook('Stop', '/s.sh')],
      ctx(target({ hooks: '{\n  "env": {}\n}\n' })),
    );
    const after = text(entryFor(plan, id('hooks'), 'settings.json')!.content);
    expect(after.startsWith('{\n  "env": {},\n  "hooks": {')).toBe(true);
    expect(JSON.parse(after)).toEqual({
      env: {},
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/s.sh' }] }] },
    });
  });

  it('hook obcy zostaje, a istniejacy hook jest rozpoznany i niezmieniany', async () => {
    const before = JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [{ type: 'prompt', prompt: 'p' }] },
            { hooks: [{ type: 'command', command: '/s.sh' }] },
          ],
        },
      },
      null,
      2,
    );
    const plan = await adapter.plan([hook('Stop', '/s.sh')], ctx(target({ hooks: before })));
    expect(entryFor(plan, id('hooks'), 'settings.json')!.action).toBe('unchanged');
  });

  it('brak settings.json: powstaje plik z samym kluczem hooks', async () => {
    const plan = await adapter.plan([hook('Stop', '/s.sh')], ctx(target({ hooks: null })));
    expect(plan.refusals).toEqual([]);
    const e = entryFor(plan, id('hooks'), 'settings.json')!;
    expect([e.action, e.scope, e.previous]).toEqual(['create', 'json-key', null]);
    expect(JSON.parse(text(e.content))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/s.sh' }] }] },
    });
  });
});

describe('eksport Claude Code: swiezy ~/.claude bez podkatalogow i plikow', () => {
  it('skill, agent, komenda i CLAUDE.md sa tworzone pod rootami, ktorych jeszcze nie ma', async () => {
    const fresh = new MemoryReader();
    fresh.dir(id('skills')).dir(id('agents')).dir(id('commands'));
    fresh.file(id('global-instructions'), 'CLAUDE.md', null);
    fresh.file(id('hooks'), 'settings.json', null);
    const absent = roots.map((r) => ({ ...r, exists: false, active: false }));
    const items = [
      toLoaded(draft('skill', 'acme-s')),
      toLoaded(draft('agent', 'acme-a')),
      toLoaded(draft('command', 'acme-c')),
      toLoaded(draft('global-instruction', 'instructions')),
    ];
    const plan = await adapter.plan(items, {
      roots: absent,
      reader: fresh,
      materialization: { directory: 'copy', file: 'copy' },
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.entries.map((e) => [e.rootId, e.relPath, e.action])).toEqual([
      [id('skills'), 'acme-s', 'create'],
      [id('agents'), 'acme-a.md', 'create'],
      [id('commands'), 'acme-c.md', 'create'],
      [id('global-instructions'), 'CLAUDE.md', 'create'],
    ]);
    expect(text(entryFor(plan, id('global-instructions'), 'CLAUDE.md')!.content)).toBe(
      '<!-- ai-skills-manager:start -->\nTresc\n<!-- ai-skills-manager:end -->\n',
    );
  });
});

describe('eksport Claude Code: instrukcja globalna', () => {
  it('tresc ze znacznikami aplikacji jest odrzucana', async () => {
    const item = toLoaded(
      draft('global-instruction', 'instructions', {
        content: {
          title: 't',
          description: 'x',
          descriptionOrigin: 'derived',
          body: '<!-- ai-skills-manager:start -->\nx\n<!-- ai-skills-manager:end -->\n',
        },
      }),
    );
    const plan = await adapter.plan([item], ctx(target()));
    expect(plan.entries).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
  });

  it('dwie instrukcje globalne to konflikt', async () => {
    const plan = await adapter.plan(
      [toLoaded(draft('global-instruction', 'a')), toLoaded(draft('global-instruction', 'b'))],
      ctx(target()),
    );
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.applicable).toBe(false);
  });

  it('instrukcja z fixture, niezmieniona, nie wymaga zapisu', async () => {
    const items = (await fixtureLoaded()).filter((i) => i.item.kind === 'global-instruction');
    const plan = await adapter.plan(items, ctx(fixtureReader()));
    expect(plan.entries.map((e) => e.action)).toEqual(['unchanged']);
  });
});

/**
 * Regresja z testu property-based (tests/property/round-trip.test.ts): agent bez `name` albo
 * z opisem wyliczonym dostawal w pliku oba pola, a werdykt mowil full i nie wymienial dopisanych.
 */
describe('eksport Claude Code: werdykt agenta zapowiada dopisane pola', () => {
  it('agent bez name i z opisem wyliczonym jest lossy z addedAttributes, a plik ma oba pola', async () => {
    const item = toLoaded(
      draft('agent', 'acme-bez-nazwy', {
        content: {
          title: 'acme-bez-nazwy',
          description: 'Pierwszy akapit',
          descriptionOrigin: 'derived',
          body: 'Pierwszy akapit\n',
        },
      }),
    );
    const plan = await adapter.plan([item], ctx(target()));
    const verdict = plan.verdicts[0]!.verdict;
    expect(verdict.level).toBe('lossy');
    expect(verdict.addedAttributes).toEqual(['name', 'description']);
    expect(verdict.reasons.join(' ')).toMatch(/dopisze: name, description/);
    const fm = parseFrontmatter(text(entryFor(plan, id('agents'), 'acme-bez-nazwy.md')!.content));
    expect(fm.data.get('name')).toBe('acme-bez-nazwy');
    expect(fm.data.get('description')).toBe('Pierwszy akapit');
  });

  it('agent z name i opisem ze zrodla zostaje full, bez addedAttributes', () => {
    const item = toLoaded(
      draft('agent', 'acme-pelny', {
        identity: { slug: 'acme-pelny', declaredName: 'acme-pelny', aliases: [] },
      }),
    );
    const verdict = adapter.capabilities(item.item);
    expect(verdict).toEqual({
      level: 'full',
      reasons: [],
      lostAttributes: [],
      addedAttributes: [],
    });
  });
});
