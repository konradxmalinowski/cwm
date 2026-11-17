import { resolve } from 'node:path';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import { createGeminiCliAdapter } from '../../src/adapters/gemini-cli';
import { describeAdapterContract } from './adapter-contract';

const fixtures = resolve(__dirname, '..', 'fixtures');
const claude = resolve(fixtures, 'claude-code', 'home', '.claude');
const codex = resolve(fixtures, 'codex', 'home', '.codex');
const agentsHome = resolve(fixtures, 'codex', 'home', '.agents');
const gemini = resolve(fixtures, 'gemini-cli', 'home', '.gemini');

describeAdapterContract({
  name: 'Claude Code',
  adapter: createClaudeCodeAdapter(),
  fixtureDir: resolve(fixtures, 'claude-code'),
  roots: [
    { kind: 'skills', dir: resolve(claude, 'skills') },
    { kind: 'agents', dir: resolve(claude, 'agents') },
    { kind: 'commands', dir: resolve(claude, 'commands') },
    { kind: 'global-instructions', dir: resolve(claude, 'CLAUDE.md') },
    { kind: 'hooks', dir: resolve(claude, 'settings.json') },
  ],
});

describeAdapterContract({
  name: 'Codex',
  adapter: createCodexAdapter(),
  fixtureDir: resolve(fixtures, 'codex'),
  roots: [
    { kind: 'skills', dir: resolve(codex, 'skills') },
    { kind: 'skills', dir: resolve(agentsHome, 'skills') },
    { kind: 'agents', dir: resolve(codex, 'agents') },
    { kind: 'agent-registry', dir: resolve(codex, 'config.toml') },
    { kind: 'global-instructions', dir: resolve(codex, 'AGENTS.md') },
    { kind: 'hooks', dir: resolve(codex, 'hooks.json') },
  ],
});

describeAdapterContract({
  name: 'Gemini CLI',
  adapter: createGeminiCliAdapter(),
  fixtureDir: resolve(fixtures, 'gemini-cli'),
  roots: [
    { kind: 'skills', dir: resolve(gemini, 'skills') },
    { kind: 'agents', dir: resolve(gemini, 'agents') },
    { kind: 'commands', dir: resolve(gemini, 'commands') },
    { kind: 'global-instructions', dir: resolve(gemini, 'GEMINI.md') },
    { kind: 'hooks', dir: resolve(gemini, 'settings.json') },
  ],
});
