import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import {
  copyTree,
  plain,
  symlinksAvailable,
  writeTreeFile,
} from '../contract/support/fs-source-reader';
import {
  candidate,
  scanRoot,
  skipFor,
  unmapped,
  warningCodes,
} from '../contract/support/scan-helpers';

const home = resolve(__dirname, '..', 'fixtures', 'claude-code', 'home', '.claude');
const adapter = createClaudeCodeAdapter();
const skillsDir = join(home, 'skills');
const canSymlink = symlinksAvailable(join(createTempTree('acme-probe-'), 'probe'));
const posix = process.platform !== 'win32';

afterAll(() => {
  removeTempTrees();
});

describe('Claude Code: siedem przypadkow z audytu (kryterium 2)', () => {
  it('1. katalog ze SKILL.md jest skillem z assetami i snapshotem bajt w bajt', async () => {
    const r = await scanRoot(adapter, 'skills', skillsDir);
    const c = candidate(r, 'acme-plain');
    expect(c.kind).toBe('skill');
    expect(c.draft.identity).toEqual({
      slug: 'acme-plain',
      declaredName: 'acme-plain',
      aliases: [],
    });
    expect(c.draft.content.descriptionOrigin).toBe('source');
    expect(c.draft.content.description).toBe(
      'Greets the user in the Acme style: short, polite, no filler.',
    );
    expect(c.draft.assets?.map((a) => a.relPath)).toEqual([
      'references/notes.md',
      'scripts/run.sh',
    ]);

    const files = c.draft.source?.snapshots[0]?.files ?? [];
    expect(files.map((f) => f.relPath)).toEqual([
      'SKILL.md',
      'references/notes.md',
      'scripts/run.sh',
    ]);
    for (const f of files) {
      expect(
        Buffer.from(f.bytes).equals(
          readFileSync(join(skillsDir, 'acme-plain', ...f.relPath.split('/'))),
        ),
      ).toBe(true);
    }
    if (posix) expect(files.find((f) => f.relPath === 'scripts/run.sh')?.mode).toBe(0o755);
    expect(unmapped(c)).toEqual({
      'frontmatter.allowed-tools': 'Read Grep',
      'frontmatter.license': 'MIT',
    });
    expect(c.warnings).toEqual([]);
  });

  it('2. katalog bez SKILL.md to ImportSkip not-an-element, nie skill', async () => {
    const r = await scanRoot(adapter, 'skills', skillsDir);
    expect(r.candidates.some((c) => c.relPath === 'acme-notes')).toBe(false);
    expect(skipFor(r, 'acme-notes')?.reason).toBe('not-an-element');
  });

  it('3. plaski .md bez frontmattera ma opis wyliczony z pierwszego akapitu', async () => {
    const c = candidate(await scanRoot(adapter, 'skills', skillsDir), 'acme-flat.md');
    expect(c.draft.content.descriptionOrigin).toBe('derived');
    expect(c.draft.content.description).toBe(
      'First paragraph of the flat skill. It spans two lines.',
    );
    expect(c.draft.content.title).toBe('Acme flat');
    expect(c.draft.identity.slug).toBe('acme-flat');
    expect(warningCodes(c)).toContain('description-derived');
  });

  it('4. plik bez rozszerzenia jest pominiety, a skan idzie dalej', async () => {
    const r = await scanRoot(adapter, 'skills', skillsDir);
    expect(skipFor(r, 'acme-install-cert')?.reason).toBe('not-an-element');
    expect(r.candidates.length).toBeGreaterThan(3);
  });

  it.skipIf(!canSymlink)('5. alias przez symlink dostaje ten sam aliasKey co cel', async () => {
    const tree = createTempTree('acme-alias-');
    const skills = join(tree, 'skills');
    copyTree(skillsDir, skills);
    mkdirSync(join(skills, 'acme-alias'));
    symlinkSync('../acme-plain/SKILL.md', join(skills, 'acme-alias', 'SKILL.md'));
    symlinkSync('acme-plain', join(skills, 'acme-dirlink'));

    const r = await scanRoot(adapter, 'skills', skills);
    const target = candidate(r, 'acme-plain');
    const alias = candidate(r, 'acme-alias');
    const dirLink = candidate(r, 'acme-dirlink');
    expect(target.aliasKey).not.toBeNull();
    expect(alias.aliasKey).toBe(target.aliasKey);
    expect(dirLink.aliasKey).toBe(target.aliasKey);
    // Alias czyta tresc celu, ale zachowuje wlasny slug i nie prostuje nazwy (ADR 0026).
    expect(alias.draft.content.body).toBe(target.draft.content.body);
    expect(alias.draft.identity).toEqual({
      slug: 'acme-alias',
      declaredName: 'acme-plain',
      aliases: [],
    });
    expect(warningCodes(alias)).toContain('slug-differs-from-declared-name');
    expect(
      alias.warnings.find((w) => w.code === 'slug-differs-from-declared-name')?.message,
    ).toMatch(/Claude Code.*Codex/);
    // Rozne pliki nie dostaja wspolnego klucza.
    expect(candidate(r, 'acme-renamed').aliasKey).not.toBe(target.aliasKey);
  });

  it('6 i 7. rejestr agentow to sprawa Codeksa: Claude Code nie ma tego rodzaju roota', async () => {
    const r = await scanRoot(adapter, 'agent-registry', join(home, 'settings.json'));
    expect(r.candidates).toEqual([]);
    expect(r.skipped[0]?.reason).toBe('unsupported');
  });
});

describe('Claude Code: skille', () => {
  it('rozjechanie slug kontra name to ostrzezenie z konsekwencjami, bez prostowania (kryterium 7)', async () => {
    const c = candidate(await scanRoot(adapter, 'skills', skillsDir), 'acme-renamed');
    expect(c.draft.identity).toEqual({
      slug: 'acme-renamed',
      declaredName: 'acme-other-name',
      aliases: [],
    });
    const w = c.warnings.find((x) => x.code === 'slug-differs-from-declared-name');
    expect(w?.message).toContain('acme-renamed');
    expect(w?.message).toContain('acme-other-name');
  });

  it('nieznane klucze i konstrukcje spoza zakresu YAML trafiaja do unmappedKeys', async () => {
    const c = candidate(await scanRoot(adapter, 'skills', skillsDir), 'acme-folded');
    expect(c.draft.content.description).toBe(
      'Folded description that spans two lines.\nSecond paragraph.',
    );
    expect(unmapped(c)).toEqual({
      'frontmatter.instructions': 'Literal block\n  keeps indentation.\n',
      'frontmatter.tags': ['alpha', 'beta gamma', 'delta'],
      'frontmatter.triggers': ['first trigger', 'second trigger'],
      'frontmatter.note': "it's quoted",
      'frontmatter.count': 3,
      'frontmatter.enabled': true,
      'frontmatter.metadata': 'owner: acme\n  level: 2',
      'frontmatter.shared': '&anchor value',
    });
    expect(warningCodes(c)).toContain('frontmatter-unsupported');
    expect(c.draft.content.body).toBe('Body with a `---` rule below.\n\n---\n\nStill body.\n');
  });

  it('nazwa ze spacjami dostaje bezpieczny slug, a oryginal zostaje w aliasach', async () => {
    const c = candidate(await scanRoot(adapter, 'skills', skillsDir), 'acme broken skill');
    expect(c.draft.identity.slug).toBe('acme-broken-skill');
    expect(c.draft.identity.aliases).toEqual(['acme broken skill']);
    expect(warningCodes(c)).toEqual(
      expect.arrayContaining(['slug-derived', 'frontmatter-unclosed', 'description-derived']),
    );
  });

  it('CRLF i LF daja ten sam szkic, a snapshot zachowuje oryginalne bajty (ADR 0016)', async () => {
    const crlf = candidate(await scanRoot(adapter, 'skills', skillsDir), 'acme-crlf');
    const original = readFileSync(join(skillsDir, 'acme-crlf', 'SKILL.md'));
    expect(original.includes(0x0d)).toBe(true);
    expect(Buffer.from(crlf.draft.source!.snapshots[0]!.files[0]!.bytes).equals(original)).toBe(
      true,
    );

    const tree = createTempTree('acme-lf-');
    writeTreeFile(tree, 'acme-crlf/SKILL.md', original.toString('utf8').replace(/\r\n/g, '\n'));
    const lf = candidate(await scanRoot(adapter, 'skills', tree), 'acme-crlf');

    const strip = (c: typeof crlf) => {
      return plain({ ...c.draft, source: undefined });
    };
    expect(strip(crlf)).toEqual(strip(lf));
    expect(crlf.draft.content.body).not.toContain('\r');
  });

  it('plik z BOM i nie-UTF-8 sa obslugiwane bez wyjatku', async () => {
    const tree = createTempTree('acme-enc-');
    writeTreeFile(
      tree,
      'acme-bom/SKILL.md',
      Buffer.from('﻿---\nname: acme-bom\ndescription: With BOM.\n---\nBody\n'),
    );
    writeTreeFile(tree, 'acme-binary/SKILL.md', new Uint8Array([0xff, 0xfe, 0xfa, 0x00]));
    const r = await scanRoot(adapter, 'skills', tree);
    expect(candidate(r, 'acme-bom').draft.content.description).toBe('With BOM.');
    expect(skipFor(r, 'acme-binary/SKILL.md')?.reason).toBe('malformed');
  });

  it('nazwa z polskimi literami dostaje slug ASCII i alias', async () => {
    const tree = createTempTree('acme-name-');
    writeTreeFile(tree, 'Zażółć gęślą/SKILL.md', '---\nname: x\ndescription: d\n---\nB\n');
    const c = (await scanRoot(adapter, 'skills', tree)).candidates[0]!;
    expect(c.draft.identity.slug).toBe('Zazolc-gesla');
    expect(c.draft.identity.aliases).toEqual(['Zażółć gęślą']);
  });

  it('limit rozmiaru jednego pliku pomija element z nazwa pliku, reszta zostaje (kryterium 8)', async () => {
    const r = await scanRoot(adapter, 'skills', skillsDir, {
      fault: (rel) => (rel === 'acme-plain/references/notes.md' ? { failure: 'too-large' } : null),
    });
    expect(r.candidates.some((c) => c.relPath === 'acme-plain')).toBe(false);
    const s = skipFor(r, 'acme-plain/references/notes.md');
    expect(s?.reason).toBe('too-large');
    expect(s?.message).toContain('acme-plain/references/notes.md');
    expect(r.candidates.some((c) => c.relPath === 'acme-renamed')).toBe(true);
  });

  it('plik bez uprawnien daje ImportSkip unreadable z nazwa pliku', async () => {
    const r = await scanRoot(adapter, 'skills', skillsDir, {
      fault: (rel) => (rel === 'acme-renamed/SKILL.md' ? { failure: 'permission-denied' } : null),
    });
    const s = skipFor(r, 'acme-renamed/SKILL.md');
    expect(s?.reason).toBe('unreadable');
    expect(s?.message).toContain('SKILL.md');
  });

  describe.skipIf(!canSymlink)('symlinki wyprowadzajace poza root (kryterium 4)', () => {
    it('nie sa sledzone i nie wciagaja zewnetrznej tresci', async () => {
      const tree = createTempTree('acme-outside-');
      const skills = join(tree, 'skills');
      copyTree(skillsDir, skills);
      mkdirSync(join(tree, 'outside', 'acme-ext'), { recursive: true });
      writeFileSync(join(tree, 'outside', 'secret.md'), 'acme-outside-secret');
      writeFileSync(
        join(tree, 'outside', 'acme-ext', 'SKILL.md'),
        '---\nname: ext\n---\nacme-outside-secret',
      );
      symlinkSync('../outside/acme-ext', join(skills, 'acme-out'));
      symlinkSync('../outside/secret.md', join(skills, 'acme-outfile.md'));
      symlinkSync('../../outside/secret.md', join(skills, 'acme-plain', 'leak.txt'));

      const r = await scanRoot(adapter, 'skills', skills);
      expect(skipFor(r, 'acme-out')?.reason).toBe('symlink-outside');
      expect(skipFor(r, 'acme-outfile.md')?.reason).toBe('symlink-outside');
      expect(skipFor(r, 'acme-plain/leak.txt')?.reason).toBe('symlink-outside');
      expect(JSON.stringify(plain(r))).not.toContain('bytes:' + 'x'); // bajty sa hashowane, wiec sprawdzamy tresc nizej
      for (const c of r.candidates) {
        expect(c.draft.content.body).not.toContain('acme-outside-secret');
        for (const f of c.draft.source?.snapshots[0]?.files ?? []) {
          expect(Buffer.from(f.bytes).toString('utf8')).not.toContain('acme-outside-secret');
        }
      }
      // Skill z dowiazaniem w srodku zostaje, ale z ostrzezeniem.
      expect(warningCodes(candidate(r, 'acme-plain'))).toContain('file-not-imported');
      expect(r.candidates.some((c) => c.relPath === 'acme-out')).toBe(false);
    });
  });
});

describe('Claude Code: agenci, komendy, instrukcja, hooki', () => {
  it('agent z pieciu kluczy mapuje sie na atrybuty, bez unmappedKeys', async () => {
    const c = candidate(
      await scanRoot(adapter, 'agents', join(home, 'agents')),
      'acme-reviewer.md',
    );
    expect(c.kind).toBe('agent');
    expect(c.draft.attributes).toEqual({
      presentation: { accentColor: 'blue' },
      memoryScope: 'project',
      reasoningDepth: 'deepest',
    });
    expect(unmapped(c)).toEqual({});
    expect(c.draft.content.body).toBe('You review changes. Be brief.\n');
  });

  it('nieznany model i nieznany klucz zostaja w unmappedKeys', async () => {
    const c = candidate(await scanRoot(adapter, 'agents', join(home, 'agents')), 'acme-extra.md');
    expect(c.draft.attributes).toBeUndefined();
    expect(unmapped(c)).toEqual({
      'frontmatter.model': 'custom-model',
      'frontmatter.tools': 'Read, Grep',
    });
  });

  it('agent bez frontmattera i plik nie-md', async () => {
    const r = await scanRoot(adapter, 'agents', join(home, 'agents'));
    const bare = candidate(r, 'acme-bare.md');
    expect(bare.draft.content.descriptionOrigin).toBe('derived');
    expect(warningCodes(bare)).toContain('frontmatter-missing');
    expect(skipFor(r, 'acme-notes.txt')?.reason).toBe('not-an-element');
  });

  it('komendy: opis ze zrodla albo wyliczony, reszta kluczy w unmappedKeys', async () => {
    const r = await scanRoot(adapter, 'commands', join(home, 'commands'));
    const deploy = candidate(r, 'acme-deploy.md');
    expect(deploy.kind).toBe('command');
    expect(deploy.draft.content.description).toBe('Deploy the Acme sample');
    expect(unmapped(deploy)).toEqual({
      'frontmatter.argument-hint': '[environment]',
      'frontmatter.allowed-tools': 'Bash',
    });
    const plainCmd = candidate(r, 'acme-plain-command.md');
    expect(plainCmd.draft.content.descriptionOrigin).toBe('derived');
    expect(warningCodes(plainCmd)).not.toContain('frontmatter-missing');
  });

  it('CLAUDE.md jest cala trescia, razem z tym, co lezy poza blokiem (ADR 0025)', async () => {
    const r = await scanRoot(adapter, 'global-instructions', join(home, 'CLAUDE.md'));
    const c = candidate(r, 'CLAUDE.md');
    expect(c.kind).toBe('global-instruction');
    expect(c.draft.content.body).toBe(readFileSync(join(home, 'CLAUDE.md'), 'utf8'));
    expect(c.draft.content.body).toContain('Notes written by hand outside the block.');
  });

  it('pusty CLAUDE.md jest pominiety', async () => {
    const tree = createTempTree('acme-empty-');
    writeTreeFile(tree, 'CLAUDE.md', '  \n');
    const r = await scanRoot(adapter, 'global-instructions', join(tree, 'CLAUDE.md'));
    expect(skipFor(r, 'CLAUDE.md')?.reason).toBe('not-an-element');
    const missing = await scanRoot(adapter, 'global-instructions', join(tree, 'nope'));
    expect(missing.candidates).toEqual([]);
  });

  it('hooki: tylko klucz hooks, bez reszty settings.json (sekrety)', async () => {
    const r = await scanRoot(adapter, 'hooks', join(home, 'settings.json'));
    expect(r.candidates.map((c) => c.relPath)).toEqual([
      'settings.json#hooks/PreToolUse/0/0',
      'settings.json#hooks/Stop/0/0',
    ]);
    const pre = candidate(r, 'settings.json#hooks/PreToolUse/0/0');
    expect(pre.draft.attributes?.hook).toEqual({
      event: 'PreToolUse',
      matcher: 'Bash',
      command: '$HOME/acme/check.sh',
      pathStyle: 'home-relative',
      timeoutSeconds: 10,
    });
    expect(unmapped(pre)).toEqual({ 'hook.statusMessage': 'checking' });
    expect(candidate(r, 'settings.json#hooks/Stop/0/0').draft.attributes?.hook?.pathStyle).toBe(
      'absolute',
    );
    expect(skipFor(r, 'settings.json#hooks/SessionStart/0/0')?.reason).toBe('unsupported');

    const dump = Buffer.from(
      JSON.stringify(r) +
        JSON.stringify(
          r.candidates.flatMap((c) =>
            c.draft.source!.snapshots[0]!.files.map((f) => Buffer.from(f.bytes).toString('utf8')),
          ),
        ),
    ).toString();
    expect(dump).not.toContain('acme-fake-token');
    expect(dump).not.toContain('permissions');
  });

  it('settings.json uszkodzony albo bez hooks nie wywala skanu', async () => {
    const tree = createTempTree('acme-settings-');
    writeTreeFile(tree, 'settings.json', '{ not json');
    expect(
      skipFor(await scanRoot(adapter, 'hooks', join(tree, 'settings.json')), 'settings.json')
        ?.reason,
    ).toBe('malformed');
    writeTreeFile(tree, 'settings.json', '{"env":{}}');
    expect(await scanRoot(adapter, 'hooks', join(tree, 'settings.json'))).toEqual({
      candidates: [],
      skipped: [],
    });
    writeTreeFile(tree, 'settings.json', '{"hooks":{"Stop":"nope"}}');
    expect(
      skipFor(
        await scanRoot(adapter, 'hooks', join(tree, 'settings.json')),
        'settings.json#hooks/Stop',
      )?.reason,
    ).toBe('malformed');
  });
});
