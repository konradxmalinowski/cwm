import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CodexAdapter, createCodexAdapter } from '../../src/adapters/codex';
import { registryTarget } from '../../src/adapters/codex/agents';
import type { DetectedRoot } from '../../src/core/ports/tool-adapter';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import { FsSourceReader, plain, writeTreeFile } from '../contract/support/fs-source-reader';
import {
  candidate,
  scanRoot,
  skipFor,
  unmapped,
  warningCodes,
} from '../contract/support/scan-helpers';

const fixtures = resolve(__dirname, '..', 'fixtures', 'codex');
const home = join(fixtures, 'home', '.codex');
const agentsHome = join(fixtures, 'home', '.agents');
const adapter = createCodexAdapter();

function rootOf(kind: 'agents' | 'agent-registry', exists: boolean): DetectedRoot {
  return { rootId: `r-${kind}`, tool: 'codex', kind, label: kind, exists, active: true };
}

function readerFor(roots: Map<string, string>): FsSourceReader {
  return new FsSourceReader(roots);
}

/** Skan katalogu agentow i rejestru, potem finalize: tak robi serwis importu. */
async function scanAndFinalize(agentsDir: string, config: string) {
  const a = new CodexAdapter();
  const reader = readerFor(
    new Map([
      ['r-agents', agentsDir],
      ['r-agent-registry', config],
    ]),
  );
  const scans = [];
  for (const kind of ['agents', 'agent-registry'] as const) {
    const root = rootOf(kind, true);
    scans.push({ root, result: await a.scan(root, reader) });
  }
  return { scans, done: await a.finalize(scans, reader) };
}

afterAll(() => {
  removeTempTrees();
});

describe('Codex: skille w obu rootach (ADR 0024)', () => {
  it('katalog ze SKILL.md, katalog bez SKILL.md, plik bez rozszerzenia i plik luzem', async () => {
    const r = await scanRoot(adapter, 'skills', join(home, 'skills'));
    const plainSkill = candidate(r, 'acme-plain');
    expect(plainSkill.draft.assets?.map((a) => a.relPath)).toEqual(['references/notes.md']);
    expect(plainSkill.warnings).toEqual([]);
    expect(skipFor(r, 'acme-notes')?.reason).toBe('not-an-element');
    expect(skipFor(r, 'acme-install-cert')?.reason).toBe('not-an-element');
    // Codex nie czyta luznych plikow, wiec plaski .md nie jest skillem.
    expect(skipFor(r, 'acme-loose.md')?.reason).toBe('not-an-element');
    expect(r.candidates.some((c) => c.relPath === 'acme-loose.md')).toBe(false);
  });

  it('skill bez frontmattera dostaje ostrzezenie, ze Codex go nie zaladuje', async () => {
    const c = candidate(await scanRoot(adapter, 'skills', join(home, 'skills')), 'acme-nofm');
    expect(c.draft.content.descriptionOrigin).toBe('derived');
    expect(warningCodes(c)).toContain('codex-frontmatter-missing');
  });

  it('drugi root skilli: ten sam slug w dwoch rootach, rozna tresc', async () => {
    const first = candidate(await scanRoot(adapter, 'skills', join(home, 'skills')), 'acme-plain');
    const second = await scanRoot(adapter, 'skills', join(agentsHome, 'skills'));
    const dup = candidate(second, 'acme-plain');
    expect(dup.draft.identity.slug).toBe(first.draft.identity.slug);
    expect(dup.draft.content.body).not.toBe(first.draft.content.body);
    expect(candidate(second, 'acme-second').draft.content.description).toBe(
      'Exists only in the second root.',
    );
  });

  it('root, ktorego Codex nie czyta, oznacza kazdy element ostrzezeniem', async () => {
    const r = await scanRoot(adapter, 'skills', join(agentsHome, 'skills'), { active: false });
    for (const c of r.candidates) expect(warningCodes(c)).toContain('root-inactive');
  });
});

describe('Codex: agenci i rejestr', () => {
  const agentsDir = join(home, 'agents');
  const config = join(home, 'config.toml');

  it('agent z pliku .toml: pola znane mapuja sie, reszta idzie do unmappedKeys', async () => {
    const r = await scanRoot(adapter, 'agents', agentsDir);
    const c = candidate(r, 'acme-reviewer.toml');
    expect(c.kind).toBe('agent');
    expect(c.draft.identity).toEqual({
      slug: 'acme-reviewer',
      declaredName: 'acme-reviewer',
      aliases: [],
    });
    expect(c.draft.content.body).toBe('You review changes.\nBe brief.\n');
    expect(c.draft.content.descriptionOrigin).toBe('source');
    expect(c.draft.attributes).toEqual({ reasoningDepth: 'deep' });
    expect(unmapped(c)).toEqual({ 'toml.sandbox_mode': 'read-only' });
    const bytes = c.draft.source!.snapshots[0]!.files[0]!.bytes;
    expect(Buffer.from(bytes).equals(readFileSync(join(agentsDir, 'acme-reviewer.toml')))).toBe(
      true,
    );
    expect(skipFor(r, 'README.txt')?.reason).toBe('not-an-element');
  });

  it('root agents nie widzi rejestru i mowi to wprost', async () => {
    const r = await scanRoot(adapter, 'agents', agentsDir);
    expect(warningCodes(candidate(r, 'acme-unregistered.toml'))).toContain(
      'agent-registration-unchecked',
    );
  });

  it('wpis rejestracyjny bez pliku i plik bez wpisu (finalize)', async () => {
    const { scans, done } = await scanAndFinalize(agentsDir, config);
    const agents = done[0]!;
    const reg = done[1]!;

    const ghost = skipFor(reg, 'config.toml#agents.acme-ghost');
    expect(ghost?.reason).toBe('malformed');
    expect(ghost?.message).toContain('agents/acme-ghost.toml');
    expect(reg.skipped.some((s) => s.relPath.includes('acme-reviewer'))).toBe(false);

    const paired = candidate(agents, 'acme-reviewer.toml');
    expect(warningCodes(paired)).toEqual([]);
    expect(unmapped(paired)['registry.entry']).toBe('acme-reviewer');

    // Agent bez wpisu jest kandydatem z ostrzezeniem, nie wpisem w skipped.
    const lone = candidate(agents, 'acme-unregistered.toml');
    expect(warningCodes(lone)).toEqual(['agent-not-registered']);
    expect(agents.skipped.some((s) => s.relPath.includes('unregistered'))).toBe(false);
    expect(reg.skipped.some((s) => s.relPath.includes('unregistered'))).toBe(false);
    expect(done).toHaveLength(scans.length);
  });

  it('bez roota agentow w skanie wyniki zostaja bez zmian', async () => {
    const a = new CodexAdapter();
    const reg = await scanRoot(a, 'agent-registry', config);
    const scans = [{ root: rootOf('agent-registry', true), result: reg }];
    const done = await a.finalize(scans, readerFor(new Map([['r-agent-registry', config]])));
    expect(done[0]).toEqual(reg);
  });

  it('config.toml: z pliku nic poza sekcjami agentow nie trafia do wyniku (sekrety)', async () => {
    const a = new CodexAdapter();
    const out = [
      await scanRoot(a, 'agents', agentsDir),
      await scanRoot(a, 'agent-registry', config),
    ];
    const dump = JSON.stringify(plain(out));
    for (const forbidden of [
      'acme-fake-token',
      'ACME_TOKEN',
      'acme-server',
      'trusted',
      'acme-model',
      'not-a-table',
      'acme_tables',
    ]) {
      expect(dump).not.toContain(forbidden);
    }
    const configBytes = readFileSync(config);
    for (const r of out) {
      for (const c of r.candidates) {
        for (const f of c.draft.source!.snapshots[0]!.files) {
          expect(Buffer.from(f.bytes).equals(configBytes)).toBe(false);
        }
      }
    }
  });

  it('config.toml z nieznana skladnia: rejestr nadal czytany, problem zgloszony', async () => {
    const tree = createTempTree('acme-cfg-');
    writeTreeFile(tree, 'agents/a.toml', 'name = "a"\ndeveloper_instructions = "x"\n');
    writeTreeFile(
      tree,
      'config.toml',
      '[weird]\nx = @@@\n[agents.a]\ndescription = "d"\nconfig_file = "./agents/a.toml"\n[agents.b]\ndescription = "d"\n',
    );
    const reg = (await scanAndFinalize(join(tree, 'agents'), join(tree, 'config.toml'))).done[1]!;
    expect(skipFor(reg, 'config.toml')?.reason).toBe('malformed');
    expect(skipFor(reg, 'config.toml#agents.b')?.message).toContain('config_file');
    expect(reg.skipped.some((s) => s.relPath === 'config.toml#agents.a')).toBe(false);
  });

  it('agent z blednym TOML-em jest pominiety, a inne zostaja', async () => {
    const tree = createTempTree('acme-badtoml-');
    writeTreeFile(tree, 'good.toml', 'name = "good"\ndeveloper_instructions = "x"\n');
    writeTreeFile(tree, 'bad.toml', '@@@ not toml\n');
    const r = await scanRoot(adapter, 'agents', tree);
    expect(skipFor(r, 'bad.toml')?.reason).toBe('malformed');
    expect(r.candidates.map((c) => c.relPath)).toEqual(['good.toml']);
  });

  it('registryTarget zna zapisy config_file z audytu', () => {
    expect(registryTarget('agents/x.toml')).toBe('agents/x.toml');
    expect(registryTarget('./agents/x.toml')).toBe('agents/x.toml');
    expect(registryTarget('~/.codex/agents/x.toml')).toBe('agents/x.toml');
    expect(registryTarget('/home/acme/.codex/agents/x.toml')).toBe('agents/x.toml');
    expect(registryTarget('/opt/other/x.toml')).toBeNull();
    expect(registryTarget('../x.toml')).toBeNull();
    expect(registryTarget('')).toBeNull();
  });
});

describe('Codex: instrukcja globalna i hooki', () => {
  it('AGENTS.md jest cala trescia', async () => {
    const c = candidate(
      await scanRoot(adapter, 'global-instructions', join(home, 'AGENTS.md')),
      'AGENTS.md',
    );
    expect(c.draft.content.body).toBe(readFileSync(join(home, 'AGENTS.md'), 'utf8'));
  });

  it('hooks.json: hook z timeoutem i opisem pliku w unmappedKeys', async () => {
    const r = await scanRoot(adapter, 'hooks', join(home, 'hooks.json'));
    const c = candidate(r, 'hooks.json#hooks/SessionStart/0/0');
    expect(c.draft.attributes?.hook).toEqual({
      event: 'SessionStart',
      matcher: null,
      command: '/opt/acme/start.sh',
      pathStyle: 'absolute',
      timeoutSeconds: 5,
    });
    expect(c.warnings).toEqual([]);
    expect(unmapped(c)).toEqual({ 'root.description': 'Synthetic hooks' });
  });

  it('klucz zdarzenia w korzeniu: ostrzezenie przy kazdym hooku i ImportSkip (ARCHITECTURE 12.3)', async () => {
    const file = join(fixtures, 'home-invalid-hooks', '.codex', 'hooks.json');
    const r = await scanRoot(adapter, 'hooks', file);
    const skip = skipFor(r, 'hooks.json#SessionStart');
    expect(skip?.reason).toBe('malformed');
    expect(skip?.message).toContain('bez komunikatu');
    const stop = candidate(r, 'hooks.json#hooks/Stop/0/0');
    expect(warningCodes(stop)).toEqual(['hooks-file-invalid-in-codex']);
    expect(r.candidates).toHaveLength(1);
  });

  it('uszkodzony hooks.json nie wywala skanu', async () => {
    const tree = createTempTree('acme-hooks-');
    writeTreeFile(tree, 'hooks.json', '{ nope');
    const r = await scanRoot(adapter, 'hooks', join(tree, 'hooks.json'));
    expect(skipFor(r, 'hooks.json')?.reason).toBe('malformed');
  });

  it('rodzaj roota spoza listy Codeksa (commands) jest nieobslugiwany', async () => {
    const r = await scanRoot(adapter, 'commands', join(home, 'skills'));
    expect(r.skipped[0]?.reason).toBe('unsupported');
  });
});
