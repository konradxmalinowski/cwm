import { resolve } from 'node:path';
import { parse } from 'smol-toml';
import { expect } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import type { ItemDraft } from '../../src/core/model/item';
import type { ToolAdapter, ToolExporter } from '../../src/core/ports/tool-adapter';
import { describeExportContract } from './export-contract';
import { toLoaded } from './support/export-helpers';

const fixtures = resolve(__dirname, '..', 'fixtures');
const claude = resolve(fixtures, 'claude-code', 'home', '.claude');
const codex = resolve(fixtures, 'codex', 'home', '.codex');
const agentsHome = resolve(fixtures, 'codex', 'home', '.agents');

const exporter = <T extends ToolAdapter>(adapter: T): T & ToolExporter => {
  const candidate = adapter as Partial<ToolExporter>;
  if (typeof candidate.plan !== 'function' || typeof candidate.capabilities !== 'function') {
    throw new Error('Adapter nie implementuje ToolExporter.');
  }
  return adapter as T & ToolExporter;
};

const classification = { scope: 'private' as const, secretFindings: [] };

const hookDraft: ItemDraft = {
  kind: 'hook',
  identity: { slug: 'Stop-9', declaredName: null, aliases: [] },
  content: { title: 'Stop', description: '', descriptionOrigin: 'derived', body: '' },
  attributes: {
    hook: {
      event: 'Stop',
      matcher: null,
      command: '/opt/acme/new-stop.sh',
      pathStyle: 'absolute',
      timeoutSeconds: null,
    },
  },
  classification,
};

const agentDraft: ItemDraft = {
  kind: 'agent',
  identity: { slug: 'acme-agent', declaredName: 'acme-agent', aliases: [] },
  content: {
    title: 'Acme agent',
    description: 'Reviews acme changes',
    descriptionOrigin: 'source',
    body: 'You review changes.\n',
  },
  classification,
};

const REALISTIC_SETTINGS = `{
  // komentarz nie jest JSON-em, ale narzedzie go nie widzi
}`;

const settings = `{
  "env": { "ACME_API_TOKEN": "acme-fake-token-0000" },
  "permissions": { "allow": ["Bash(echo:*)"], "deny": [] },

  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "prompt", "prompt": "hello" }] }]
  },
  "model": "acme"
}
`;
void REALISTIC_SETTINGS;

const REALISTIC_CONFIG = `# Synthetic Codex configuration
# Komentarz w preambule.

model = "acme-model"
approval_policy = "never"

[features]
acme_flag = true

# Zarejestrowany agent
[agents.acme-existing]
description = "Existing agent"
config_file = "agents/acme-existing.toml"

# Sekcja obca z wielolinijkowym napisem
[notice]
text = """
multi
[agents.not-a-table]
"""

[mcp_servers.acme-server]
command = "acme-mcp"
args = [
  "--serve",
  "--port", "0",
]

[mcp_servers.acme-server.env]
ACME_TOKEN = "acme-fake-token-0000"

[projects."/tmp/acme-project"]
trust_level = "trusted"

[[acme_tables]]
note = "a"

[[acme_tables]]
note = "b"
`;

function withoutKey(tree: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = tree;
  void _omitted;
  return rest;
}

describeExportContract({
  name: 'Claude Code',
  adapter: exporter(createClaudeCodeAdapter()),
  fixtureRoots: [
    { kind: 'skills', dir: resolve(claude, 'skills') },
    { kind: 'agents', dir: resolve(claude, 'agents') },
    { kind: 'commands', dir: resolve(claude, 'commands') },
    { kind: 'global-instructions', dir: resolve(claude, 'CLAUDE.md') },
    { kind: 'hooks', dir: resolve(claude, 'settings.json') },
  ],
  memoryRoots: [
    { kind: 'skills' },
    { kind: 'agents' },
    { kind: 'commands' },
    { kind: 'global-instructions', fileName: 'CLAUDE.md', initial: '' },
    { kind: 'hooks', fileName: 'settings.json', initial: '{\n  "model": "acme"\n}\n' },
  ],
  instructionFile: 'CLAUDE.md',
  shared: {
    rootKind: 'hooks',
    fileName: 'settings.json',
    realistic: settings,
    item: () => toLoaded(hookDraft),
    parseOutside: (before, after) => {
      const a = JSON.parse(before) as Record<string, unknown>;
      const b = JSON.parse(after) as Record<string, unknown>;
      expect(withoutKey(b, 'hooks')).toEqual(withoutKey(a, 'hooks'));
      // Hook obcy (typ prompt) zostaje, nowy dochodzi.
      const hooks = b['hooks'] as Record<string, unknown[]>;
      expect(hooks['SessionStart']).toEqual(
        (a['hooks'] as Record<string, unknown[]>)['SessionStart'],
      );
      expect(JSON.stringify(hooks['Stop'])).toContain('/opt/acme/new-stop.sh');
      // Kolejnosc i wciecia poza kluczem hooks bez zmian: tekst przed nim jest identyczny.
      const cut = before.indexOf('"hooks"');
      expect(after.slice(0, cut)).toBe(before.slice(0, cut));
      expect(after.endsWith('  "model": "acme"\n}\n')).toBe(true);
    },
    hostile: [
      { name: 'plik nie jest poprawnym JSON-em', text: '{ "hooks": ', message: /JSON/ },
      { name: 'klucz hooks nie jest obiektem', text: '{ "hooks": [] }\n', message: /hooks/ },
    ],
  },
});

describeExportContract({
  name: 'Codex',
  adapter: exporter(createCodexAdapter()),
  fixtureRoots: [
    { kind: 'skills', dir: resolve(codex, 'skills') },
    { kind: 'skills', dir: resolve(agentsHome, 'skills') },
    { kind: 'agents', dir: resolve(codex, 'agents') },
    { kind: 'agent-registry', dir: resolve(codex, 'config.toml') },
    { kind: 'global-instructions', dir: resolve(codex, 'AGENTS.md') },
    { kind: 'hooks', dir: resolve(codex, 'hooks.json') },
  ],
  memoryRoots: [
    { kind: 'skills' },
    { kind: 'agents' },
    { kind: 'agent-registry', fileName: 'config.toml', initial: 'model = "acme"\n' },
    { kind: 'global-instructions', fileName: 'AGENTS.md', initial: '' },
    {
      kind: 'hooks',
      fileName: 'hooks.json',
      initial: '{\n  "description": "acme",\n  "hooks": {}\n}\n',
    },
  ],
  instructionFile: 'AGENTS.md',
  shared: {
    rootKind: 'agent-registry',
    fileName: 'config.toml',
    realistic: REALISTIC_CONFIG,
    item: () => toLoaded(agentDraft),
    parseOutside: (before, after) => {
      const a = parse(before) as Record<string, unknown>;
      const b = parse(after) as Record<string, unknown>;
      expect(withoutKey(b, 'agents')).toEqual(withoutKey(a, 'agents'));
      const agents = b['agents'] as Record<string, unknown>;
      expect(agents['acme-existing']).toEqual(
        (a['agents'] as Record<string, unknown>)['acme-existing'],
      );
      expect(agents['acme-agent']).toEqual({
        description: 'Reviews acme changes',
        config_file: 'agents/acme-agent.toml',
      });
      // Poza dopisanymi liniami tekst jest bajt w bajt ten sam.
      expect(after.startsWith(before)).toBe(true);
    },
    hostile: [
      {
        name: 'klucz z kropka poza tabela',
        text: 'model = "x"\nagents.legacy.description = "x"\n',
        message: /klucz z kropką/,
      },
      {
        name: 'tablica tabel w obszarze agentow',
        text: '[[agents]]\nname = "x"\n',
        message: /tablica tabel/,
      },
      {
        name: 'komentarz oddzielony pusta linia w zarzadzanym bloku',
        text: '[agents.acme-agent]\ndescription = "old"\n\n# osierocony\nconfig_file = "agents/acme-agent.toml"\n',
        message: /komentarz oddzielony/,
      },
      { name: 'plik nie jest poprawnym TOML-em', text: '[agents\nx = 1\n', message: /TOML/ },
    ],
  },
});
