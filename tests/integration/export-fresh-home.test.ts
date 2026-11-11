import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { afterAll, describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import type { ItemDraft, LoadedItem, ToolId } from '../../src/core/model/item';
import type {
  DetectedRoot,
  RootKind,
  ToolAdapter,
  ToolExporter,
} from '../../src/core/ports/tool-adapter';
import { FsWriteGate } from '../../src/infra/fs/write-gate';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { FsSourceReader } from '../../src/infra/source/fs-source-reader';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { enc, toLoaded } from '../contract/support/export-helpers';

afterAll(() => {
  removeTempTrees();
});

const posixOnly = it.skipIf(process.platform === 'win32');

interface Layout {
  readonly tool: ToolId;
  readonly adapter: ToolAdapter & ToolExporter;
  readonly home: string;
  readonly roots: readonly { kind: RootKind; segments: string[] }[];
}

const draft = (
  kind: ItemDraft['kind'],
  slug: string,
  extra: Partial<ItemDraft> = {},
): ItemDraft => ({
  kind,
  identity: { slug, declaredName: kind === 'agent' || kind === 'skill' ? slug : null, aliases: [] },
  content: { title: slug, description: 'Opis', descriptionOrigin: 'source', body: 'Tresc\n' },
  classification: { scope: 'private', secretFindings: [] },
  ...extra,
});

const hookDraft = draft('hook', 'Stop-1', {
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
});

function items(): LoadedItem[] {
  return [
    toLoaded(
      draft('skill', 'acme-s', { assets: [{ relPath: 'references/n.md', bytes: enc('n\n') }] }),
    ),
    toLoaded(draft('agent', 'acme-a')),
    toLoaded(draft('command', 'acme-c')),
    toLoaded(draft('global-instruction', 'instructions')),
    toLoaded(hookDraft),
  ];
}

async function exportFresh(layout: Layout): Promise<void> {
  const tree = createTempTree('acme-fresh-');
  const home = join(tree, layout.home);
  mkdirSync(home);
  const userData = join(tree, 'userData');
  mkdirSync(userData);

  const paths = new Map<string, string>();
  const roots: DetectedRoot[] = layout.roots.map((r, i) => {
    const rootId = `${layout.tool}:${i}`;
    paths.set(rootId, join(home, ...r.segments));
    return { rootId, tool: layout.tool, kind: r.kind, label: r.kind, exists: false, active: false };
  });
  const reader = new FsSourceReader((id) => paths.get(id) ?? null);
  const gate = new FsWriteGate({
    resolveRoot: (id) => paths.get(id) ?? null,
    userDataDir: userData,
    objects: new FsObjectStore(join(userData, 'objects')),
    linkMode: {
      capability: () =>
        Promise.resolve({ fileSymlink: false, directorySymlink: false, junction: false }),
    },
  });
  const ctx = {
    roots,
    reader,
    materialization: { directory: 'copy', file: 'copy' } as const,
  };
  const set = items();

  const plan = await layout.adapter.plan(set, ctx);
  expect(plan.refusals).toEqual([]);
  expect(plan.entries.length).toBeGreaterThanOrEqual(5);
  const probed = await gate.probe(plan);
  for (const e of probed.entries) expect(e.recoverability?.status).toBe('recoverable');
  expect(probed.applicable).toBe(true);
  const report = await gate.apply(probed, { planId: probed.planId });
  expect(report.entries.map((e) => e.outcome)).not.toContain('failed');

  // Pliki i katalogi powstaly pod istniejacym katalogiem glownym.
  const instructionFile = layout.tool === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
  expect(readFileSync(join(home, instructionFile), 'utf8')).toBe(
    '<!-- cwm:start -->\nTresc\n<!-- cwm:end -->\n',
  );
  expect(readFileSync(join(home, 'skills', 'acme-s', 'references', 'n.md'), 'utf8')).toBe('n\n');
  const hooksFile = layout.tool === 'claude-code' ? 'settings.json' : 'hooks.json';
  expect(Object.keys(JSON.parse(readFileSync(join(home, hooksFile), 'utf8')) as object)).toEqual([
    'hooks',
  ]);
  if (layout.tool === 'codex') {
    const cfg = parse(readFileSync(join(home, 'config.toml'), 'utf8')) as { agents: object };
    expect(Object.keys(cfg)).toEqual(['agents']);
    expect(cfg.agents).toEqual({
      'acme-a': { description: 'Opis', config_file: 'agents/acme-a.toml' },
    });
    expect(existsSync(join(home, 'agents', 'acme-a.toml'))).toBe(true);
  } else {
    expect(existsSync(join(home, 'agents', 'acme-a.md'))).toBe(true);
    expect(existsSync(join(home, 'commands', 'acme-c.md'))).toBe(true);
  }
  if (process.platform !== 'win32') {
    expect(statSync(join(home, 'skills')).mode & 0o777).toBe(0o700);
  }

  // Drugi plan, tym razem z rootami wykrytymi jako istniejace, ma same unchanged.
  const detected = roots.map((r) => ({ ...r, exists: true, active: true }));
  const again = await layout.adapter.plan(set, { ...ctx, roots: detected });
  expect(again.entries.length).toBe(plan.entries.length);
  expect(again.entries.map((e) => e.action)).toEqual(again.entries.map(() => 'unchanged'));
}

describe('eksport do swiezego katalogu glownego przez prawdziwy WriteGate (ADR 0033)', () => {
  posixOnly('Claude Code: ~/.claude bez podkatalogow i plikow', async () => {
    await exportFresh({
      tool: 'claude-code',
      adapter: createClaudeCodeAdapter() as ToolAdapter & ToolExporter,
      home: '.claude',
      roots: [
        { kind: 'skills', segments: ['skills'] },
        { kind: 'agents', segments: ['agents'] },
        { kind: 'commands', segments: ['commands'] },
        { kind: 'global-instructions', segments: ['CLAUDE.md'] },
        { kind: 'hooks', segments: ['settings.json'] },
      ],
    });
  });

  posixOnly(
    'Codex: ~/.codex bez podkatalogow i plikow, z config.toml tylko z segmentem',
    async () => {
      await exportFresh({
        tool: 'codex',
        adapter: createCodexAdapter() as ToolAdapter & ToolExporter,
        home: '.codex',
        roots: [
          { kind: 'skills', segments: ['skills'] },
          { kind: 'agents', segments: ['agents'] },
          { kind: 'agent-registry', segments: ['config.toml'] },
          { kind: 'global-instructions', segments: ['AGENTS.md'] },
          { kind: 'hooks', segments: ['hooks.json'] },
        ],
      });
    },
  );
});
