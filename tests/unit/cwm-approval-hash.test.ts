import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  approvalHash,
  buildMcpConfig,
  canonicalJson,
  diffFields,
  executionFields,
  extractInlineCommands,
  evaluatePackMembers,
  extractPluginExecutables,
  gitObjectId,
  gitRawObject,
  parseGitCatFileBatch,
  verifyGitCopy,
  groupForPacks,
  mapStrings,
  mcpCommandIsPath,
  needsApproval,
  approvalWarnings,
  packMemberHash,
  projectApprovalKey,
  validateApprovalsFile,
  validateResource,
  validatePackTrustFile,
  type MemberFields,
  type McpServer,
  type PackMemberFacts,
  type PackTrustFile,
  type Plugin,
  type Skill,
  type Workflow,
} from '../../src/core/cwm';

const base = {
  company: 'acme-a',
  kind: 'settings',
  id: 'acme-a/guard',
  fields: {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
  },
} as const;

const E_ACUTE = String.fromCharCode(0xe9);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const BMP_HIGH = String.fromCharCode(0xffee);

describe('canonicalJson (RFC 8785)', () => {
  it('sortuje klucze po jednostkach UTF-16 i nie dodaje bialych znakow', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], [E_ACUTE]: 2, Z: 3 })).toBe(
      `{"Z":3,"a":[true,null,"x"],"b":1,"${E_ACUTE}":2}`,
    );
  });

  it('porzadek kluczy z para zastepcza zalezy od jednostek UTF-16, nie od punktow kodowych', () => {
    const astral = '\u{1F600}';
    const bmpHigh = BMP_HIGH;
    // Para zastepcza zaczyna sie od 0xD83D, wiec sortuje sie przed 0xFFEE.
    expect(canonicalJson({ [bmpHigh]: 1, [astral]: 2 })).toBe(`{"${astral}":2,"${bmpHigh}":1}`);
  });

  it('zachowuje kolejnosc tablic i zapisuje liczby jak ECMAScript', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1e21, 0.5, -0, 100])).toBe('[1e+21,0.5,0,100]');
  });

  it('daje ten sam tekst niezaleznie od kolejnosci wstawiania kluczy', () => {
    expect(canonicalJson({ a: { y: 1, x: 2 }, b: 0 })).toBe(
      canonicalJson({ b: 0, a: { x: 2, y: 1 } }),
    );
  });

  it('odrzuca wartosci bez zapisu JSON zamiast je pomijac', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson(10n)).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });

  it('odrzuca zbyt gleboki dokument', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 80; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow();
  });
});

describe('approvalHash', () => {
  it('to SHA-256 z przedrostkiem domeny i kanonicznego dokumentu', () => {
    const document =
      '{"company":"acme-a","engine":"claude-code","fields":{"a":1},"id":"acme-a/m","kind":"mcp","v":1}';
    const expected = createHash('sha256').update(`cwm-approval-v1\n${document}`).digest('hex');
    expect(approvalHash({ company: 'acme-a', kind: 'mcp', id: 'acme-a/m', fields: { a: 1 } })).toBe(
      expected,
    );
  });

  it('nie zalezy od kolejnosci kluczy w polach', () => {
    const reordered = {
      ...base,
      fields: {
        hooks: { PreToolUse: [{ hooks: [{ command: 'x', type: 'command' }], matcher: 'Bash' }] },
      },
    };
    expect(approvalHash(reordered)).toBe(approvalHash(base));
  });

  it('zmienia sie przy zmianie dowolnego pola wykonawczego', () => {
    const original = approvalHash(base);
    const changed = (fields: unknown) => approvalHash({ ...base, fields });
    expect(
      changed({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'y' }] }] },
      }),
    ).not.toBe(original);
    expect(changed({ ...base.fields, extra: 'permissions.allow' })).not.toBe(original);
  });

  it('zmienia sie przy zmianie firmy, rodzaju albo id', () => {
    const original = approvalHash(base);
    expect(approvalHash({ ...base, company: 'acme-b' })).not.toBe(original);
    expect(approvalHash({ ...base, kind: 'mcp' })).not.toBe(original);
    expect(approvalHash({ ...base, id: 'acme-a/other' })).not.toBe(original);
  });

  it('rozroznia kolejnosc elementow tablicy (kolejnosc hookow wchodzi do skrotu)', () => {
    const a = approvalHash({ ...base, fields: { list: ['one', 'two'] } });
    const b = approvalHash({ ...base, fields: { list: ['two', 'one'] } });
    expect(a).not.toBe(b);
  });

  it('nie normalizuje Unicode: dwa rozne polecenia nie dadza jednego skrotu', () => {
    const composed = approvalHash({ ...base, fields: { command: E_ACUTE } });
    const decomposed = approvalHash({ ...base, fields: { command: `e${COMBINING_ACUTE}` } });
    expect(composed).not.toBe(decomposed);
  });

  it('zwraca 64 znaki hex i odrzuca pola z undefined', () => {
    expect(approvalHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => approvalHash({ ...base, fields: { a: undefined } })).toThrow();
  });
});

const mcp: McpServer = {
  kind: 'mcp',
  id: 'acme-a/docs',
  transport: 'stdio',
  command: './bin/serve.sh',
  args: ['--readonly'],
  env: {},
};

const hashOf = (fields: unknown): string =>
  approvalHash({ company: 'acme-a', kind: 'mcp', id: mcp.id, fields });

describe('pola zatwierdzenia serwera MCP (SEC-01)', () => {
  it('rozpoznaje polecenie bedace sciezka', () => {
    expect(mcpCommandIsPath('./bin/serve.sh')).toBe(true);
    expect(mcpCommandIsPath('/usr/bin/node')).toBe(true);
    expect(mcpCommandIsPath('npx')).toBe(false);
    expect(mcpCommandIsPath(undefined)).toBe(false);
  });

  it('skrot zalezy od katalogu projektu i od skrotu pliku polecenia', () => {
    const facts = {
      projectDir: '/work/a',
      commandPath: '/work/a/bin/serve.sh',
      commandSha256: 'a'.repeat(64),
    };
    const base = hashOf(executionFields(mcp, facts));
    expect(hashOf(executionFields(mcp, { ...facts, projectDir: '/work/b' }))).not.toBe(base);
    expect(hashOf(executionFields(mcp, { ...facts, commandSha256: 'b'.repeat(64) }))).not.toBe(
      base,
    );
    expect(
      hashOf(executionFields(mcp, { ...facts, commandPath: '/work/a/bin/other.sh' })),
    ).not.toBe(base);
  });
});

describe('klucz pary projekt-firma (SEC-09)', () => {
  it('to skrot sciezki: stala dlugosc, bez sciezki w kluczu, rozny dla roznych projektow', () => {
    const long = `/work/${'x'.repeat(2000)}`;
    const key = projectApprovalKey(long);
    expect(key).toMatch(/^project:[0-9a-f]{64}$/);
    expect(key).not.toContain('xxx');
    expect(projectApprovalKey('/work/a')).toBe(projectApprovalKey('/work/a'));
    expect(projectApprovalKey('/work/a')).not.toBe(projectApprovalKey('/work/b'));
  });

  it('walidator odczytu przyjmuje klucze project: ze skrotem i company:, a odrzuca za dlugi klucz', () => {
    const entry = (key: string) => ({
      key,
      hash: 'a'.repeat(64),
      approvedAt: '2026-11-12T10:00:00.000Z',
      fields: { path: '/work/a' },
    });
    const file = (key: string) =>
      validateApprovalsFile({
        apiVersion: 'cwm.dev/v1',
        kind: 'Approvals',
        company: 'acme-a',
        entries: [entry(key)],
      });
    expect(file(projectApprovalKey('/work/a')).ok).toBe(true);
    expect(file('company:acme-a').ok).toBe(true);
    expect(file(`project:${'x'.repeat(600)}`).ok).toBe(false);
  });
});

describe('pola zatwierdzenia pluginu (SEC-04)', () => {
  const plugin: Plugin = {
    kind: 'plugin',
    id: 'acme-a/tools',
    version: '1.0.0',
    source: { type: 'local', path: './tools' },
    activationDefault: 'enabled',
  };
  const text = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it('wyciaga hooki i serwery MCP z hooks.json, .mcp.json i plugin.json', () => {
    const exec = extractPluginExecutables([
      {
        rel: '.claude-plugin/plugin.json',
        bytes: text({ name: 'tools', mcpServers: { inline: { command: 'node', args: ['s.js'] } } }),
      },
      {
        rel: 'hooks/hooks.json',
        bytes: text({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/guard.sh' },
                  { type: 'http', url: 'https://example.invalid/h' },
                ],
              },
            ],
          },
        }),
      },
      {
        rel: '.mcp.json',
        bytes: text({
          mcpServers: {
            docs: { type: 'stdio', command: '/opt/x/serve', env: { ACME_TOKEN: 'x' } },
          },
        }),
      },
    ]);
    expect(exec.hookCommands).toEqual(['${CLAUDE_PLUGIN_ROOT}/guard.sh']);
    expect(exec.hookOther).toEqual(['http: https://example.invalid/h']);
    expect(Object.keys(exec.mcpServers).sort()).toEqual([
      '.claude-plugin/plugin.json:inline',
      '.mcp.json:docs',
    ]);
    expect(exec.mcpServers['.mcp.json:docs']?.envNames).toEqual(['ACME_TOKEN']);
  });

  it('nieczytelny JSON z deklaracjami jest zglaszany, a nie pomijany', () => {
    const exec = extractPluginExecutables([
      { rel: 'hooks/hooks.json', bytes: new TextEncoder().encode('{nie json') },
    ]);
    expect(exec.unparsed).toEqual(['hooks/hooks.json']);
  });

  it('skrot zalezy od listy plikow i od deklaracji, a roznica wymienia zmienione pliki', () => {
    const files = [
      { path: 'a.js', sha256: '1'.repeat(64) },
      { path: 'b.js', sha256: '2'.repeat(64) },
    ];
    const before = executionFields(plugin, { treeSha256: 't'.repeat(64), files });
    const changedFile = executionFields(plugin, {
      treeSha256: 't'.repeat(64),
      files: [
        files[0]!,
        { path: 'b.js', sha256: '3'.repeat(64) },
        { path: 'c.js', sha256: '4'.repeat(64) },
      ],
    });
    expect(canonicalJson(before)).not.toBe(canonicalJson(changedFile));
    const diff = diffFields(before, changedFile ?? {});
    expect(diff.find((c) => c.name === 'files')?.detail).toEqual([
      'zmieniony plik: b.js',
      'dodany plik: c.js',
    ]);
  });

  it('headersHelper z .mcp.json pluginu jest w polach, wiec jego zmiana zmienia skrot', () => {
    const exec = (helper: string) =>
      extractPluginExecutables([
        {
          rel: '.mcp.json',
          bytes: text({
            mcpServers: {
              docs: { type: 'http', url: 'https://example.invalid/m', headersHelper: helper },
            },
          }),
        },
      ]);
    const before = exec('${CLAUDE_PLUGIN_ROOT}/helper.sh');
    expect(before.mcpServers['.mcp.json:docs']?.headersHelper).toBe(
      '${CLAUDE_PLUGIN_ROOT}/helper.sh',
    );
    const a = executionFields(plugin, { treeSha256: 't'.repeat(64), pluginExec: before });
    const b = executionFields(plugin, {
      treeSha256: 't'.repeat(64),
      pluginExec: exec('${CLAUDE_PLUGIN_ROOT}/other.sh'),
    });
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });

  it('polecenie z CLAUDE_PLUGIN_ROOT i ".." (tez zakodowane) jest bledem, a zwykla sciezka nie', () => {
    const scan = (command: string, server = false) =>
      extractPluginExecutables(
        server
          ? [{ rel: '.mcp.json', bytes: text({ mcpServers: { s: { command } } }) }]
          : [
              {
                rel: 'hooks/hooks.json',
                bytes: text({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
              },
            ],
      ).errors;
    expect(scan('${CLAUDE_PLUGIN_ROOT}/hooks/check.sh')).toEqual([]);
    for (const bad of [
      '${CLAUDE_PLUGIN_ROOT}/../../x/check.sh',
      'sh "${CLAUDE_PLUGIN_ROOT}/a/../../x.sh"',
      '${CLAUDE_PLUGIN_ROOT}/%2e%2e/x.sh',
      '${CLAUDE_PLUGIN_ROOT}\\..\\x.sh',
    ]) {
      expect(scan(bad)).toHaveLength(1);
      expect(scan(bad, true)).toHaveLength(1);
    }
  });

  describe('plugin z marketplace (ADR 0043)', () => {
    const marketplacePlugin: Plugin = {
      kind: 'plugin',
      id: 'marketplace/acme-lint',
      version: '1.0.0',
      source: { type: 'marketplace', marketplace: 'example-market', plugin: 'acme-lint' },
      activationDefault: 'enabled',
    };
    const facts = {
      marketplace: 'example-market',
      plugin: 'acme-lint',
      declaredSource: './plugins/acme-lint',
      marketplaceRoot: '/m',
      resolvedPath: '/m/plugins/acme-lint',
    };
    const tree = { treeSha256: 't'.repeat(64) };
    const hashOf = (resource: Plugin, extra: object) =>
      approvalHash({
        company: 'acme-a',
        kind: 'plugin',
        id: resource.id,
        fields: executionFields(resource, { ...tree, ...extra }),
      });

    it('pola pluginu local nie dostaja klucza marketplace (skroty zatwierdzonych sie nie zmieniaja)', () => {
      const fields = executionFields(plugin, tree);
      expect(Object.keys(fields ?? {}).sort()).toEqual([
        'files',
        'hookCommands',
        'hookOther',
        'lspServers',
        'manifestRefs',
        'mcpServers',
        'pins',
        'source',
        'treeSha256',
        'unparsed',
      ]);
    });

    it('nazwa marketplace, wpis, zrodlo i rozwiazana sciezka wchodza do skrotu', () => {
      const base = hashOf(marketplacePlugin, { marketplace: facts });
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      for (const change of [
        { marketplace: 'other-market' },
        { plugin: 'Acme-Lint' },
        { declaredSource: './plugins/other' },
        { marketplaceRoot: '/m2' },
        { resolvedPath: '/m/plugins/other' },
      ]) {
        expect(hashOf(marketplacePlugin, { marketplace: { ...facts, ...change } })).not.toBe(base);
      }
    });
  });
});

describe('plugin z git (ADR 0048)', () => {
  const commit = 'c'.repeat(40);
  const gitPlugin: Plugin = {
    kind: 'plugin',
    id: 'git/acme-lint',
    version: '1.0.0',
    source: { type: 'git', url: 'https://example.com/acme/lint.git', ref: 'main', commit },
    activationDefault: 'disabled',
  };
  const facts = { url: 'https://example.com/acme/lint.git', ref: 'main', commit };
  const hashOf = (resource: Plugin, extra: object) =>
    approvalHash({
      company: 'acme-a',
      kind: 'plugin',
      id: resource.id,
      fields: executionFields(resource, { treeSha256: 't'.repeat(64), ...extra }),
    });

  it('adres, ref i commit wchodza do skrotu, a samo zrodlo nie jest jedynym nosnikiem', () => {
    const base = hashOf(gitPlugin, { git: facts });
    for (const change of [
      { url: 'https://example.com/acme/other.git' },
      { ref: 'develop' },
      { ref: null },
      { commit: 'd'.repeat(40) },
    ]) {
      expect(hashOf(gitPlugin, { git: { ...facts, ...change } })).not.toBe(base);
    }
    // Ten sam commit i drzewo, ale inny adres w polach `git`: pyta ponownie.
    expect(hashOf(gitPlugin, {})).not.toBe(base);
  });

  it('pola local i marketplace nie dostaja klucza git (ich skroty sie nie zmieniaja)', () => {
    const localPlugin: Plugin = {
      ...gitPlugin,
      id: 'local/acme-lint',
      source: { type: 'local', path: 'plugin' },
    };
    const local = executionFields(localPlugin, { treeSha256: 't'.repeat(64) });
    expect(Object.keys(local ?? {})).not.toContain('git');
    const market: Plugin = {
      ...gitPlugin,
      id: 'marketplace/acme-lint',
      source: { type: 'marketplace', marketplace: 'example-market', plugin: 'acme-lint' },
    };
    expect(Object.keys(executionFields(market, { treeSha256: 't' }) ?? {})).not.toContain('git');
    expect(Object.keys(executionFields(gitPlugin, { git: facts }) ?? {})).toContain('git');
  });
});

describe('pola zatwierdzenia skilla i komendy (SEC-04)', () => {
  const skill: Skill = {
    kind: 'skill',
    id: 'acme-a/lint',
    version: '1.0.0',
    source: 'SKILL.md',
    visibility: 'shared',
    engines: [],
    dependencies: {
      skills: [],
      agents: [],
      workflows: [],
      plugins: [],
      mcp: [],
      settings: [],
      commands: [],
      files: [],
    },
  };

  it('wyciaga wstawki ! w calosci, razem z blokami ogrodzonymi', () => {
    const body =
      'Uruchom !`git status --short` a potem:\n```!\nnpm test\nnpm run lint\n```\nkoniec';
    expect(extractInlineCommands(body)).toEqual(['git status --short', 'npm test\nnpm run lint']);
    expect(extractInlineCommands('zwykly `kod` bez wykrzyknika')).toEqual([]);
  });

  it('pola zawieraja wartosc allowed-tools i wstawki, wiec ich zmiana zmienia skrot', () => {
    const content = {
      allowedTools: true,
      allowedToolsValue: ['Bash(git status:*)'],
      inlineCommands: true,
      inlineSnippets: ['git status --short'],
      tools: [],
      model: null,
    };
    const fields = executionFields(skill, { content, sourceSha256: 's'.repeat(64) });
    expect(fields).toMatchObject({
      allowedToolsValue: ['Bash(git status:*)'],
      inlineSnippets: ['git status --short'],
    });
    const widened = executionFields(skill, {
      content: { ...content, allowedToolsValue: ['Bash(*)'] },
      sourceSha256: 's'.repeat(64),
    });
    expect(canonicalJson(widened)).not.toBe(canonicalJson(fields));
  });
});

describe('pola zatwierdzenia workflow instructional (ADR 0049)', () => {
  const workflow: Workflow = {
    kind: 'workflow',
    id: 'acme-a/review',
    version: '1.0.0',
    type: 'instructional',
    source: 'workflow.md',
    agents: [],
    steps: [],
  };
  const plain = {
    allowedTools: false,
    allowedToolsValue: [],
    inlineCommands: false,
    inlineSnippets: [],
    tools: [],
    model: null,
  };

  it('sama tresc bez allowed-tools i wstawek nie wymaga zatwierdzenia, jak komenda', () => {
    expect(needsApproval(workflow, { content: plain, sourceSha256: 's'.repeat(64) })).toBe(false);
    expect(executionFields(workflow, { content: plain, sourceSha256: 's'.repeat(64) })).toBeNull();
  });

  it('allowed-tools i wstawki ! wymuszaja zatwierdzenie, a skrot zalezy od tresci i rodzaju', () => {
    const content = {
      ...plain,
      allowedTools: true,
      allowedToolsValue: ['Bash(git diff:*)'],
      inlineCommands: true,
      inlineSnippets: ['git diff --stat'],
    };
    const facts = { content, sourceSha256: 'a'.repeat(64) };
    expect(needsApproval(workflow, facts)).toBe(true);
    const fields = executionFields(workflow, facts);
    expect(fields).toMatchObject({
      inlineSnippets: ['git diff --stat'],
      sourceSha256: 'a'.repeat(64),
    });
    const changed = executionFields(workflow, { content, sourceSha256: 'b'.repeat(64) });
    const hash = (kind: 'workflow' | 'command', f: unknown): string =>
      approvalHash({ company: 'acme-a', kind, id: 'acme-a/review', fields: f });
    expect(hash('workflow', changed)).not.toBe(hash('workflow', fields));
    expect(hash('workflow', fields)).not.toBe(hash('command', fields));
  });

  it('walidator odczytu przyjmuje klucz workflow:', () => {
    const entry = {
      key: 'workflow:acme-a/review',
      hash: 'c'.repeat(64),
      approvedAt: '2026-11-15T10:00:00Z',
      fields: {},
    };
    const parsed = validateApprovalsFile({
      apiVersion: 'cwm.dev/v1',
      kind: 'Approvals',
      company: 'acme-a',
      entries: [entry],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('skan pluginu: fail closed (SEC-04)', () => {
  const file = (rel: string, value: unknown) => ({
    rel,
    bytes: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
  });
  const manifest = (value: unknown) => file('.claude-plugin/plugin.json', value);

  it('znajduje hooks.json, .mcp.json i .lsp.json bez rozroznienia wielkosci liter', () => {
    const exec = extractPluginExecutables([
      file('Hooks/Hooks.JSON', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x.sh' }] }] },
      }),
      file('.MCP.json', { mcpServers: { docs: { command: 'node' } } }),
      file('.LSP.json', { go: { command: 'gopls', args: ['serve'] } }),
    ]);
    expect(exec.hookCommands).toEqual(['x.sh']);
    expect(Object.keys(exec.mcpServers)).toEqual(['.mcp.json:docs']);
    expect(exec.lspServers['.lsp.json:go']?.command).toBe('gopls');
    expect(exec.errors).toEqual([]);
  });

  it('odwolanie z manifestu poza drzewo albo do brakujacego pliku to blad', () => {
    for (const hooks of [
      '../outside.json',
      '/etc/hooks.json',
      './missing/hooks.json',
      '${CLAUDE_PLUGIN_ROOT}/../x.json',
    ]) {
      const exec = extractPluginExecutables([manifest({ name: 'p', hooks })]);
      expect(exec.errors.length).toBeGreaterThan(0);
    }
    const ok = extractPluginExecutables([
      manifest({ name: 'p', hooks: './h/own.json' }),
      file('H/Own.json', { Stop: [{ hooks: [{ command: 'ok.sh' }] }] }),
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.hookCommands).toEqual(['ok.sh']);
    expect(ok.manifestRefs['hooks']).toEqual(['h/own.json']);
  });

  it('klucze uruchamiajace procesy sa polami zatwierdzenia, a nieznane klucze odrzucaja plugin', () => {
    const exec = extractPluginExecutables([
      manifest({
        name: 'p',
        version: '1.0.0',
        lspServers: { rust: { command: 'rust-analyzer' } },
        mcpServers: { s: { command: 'node', args: ['s.js'] } },
        commands: './cmds',
      }),
      file('cmds/a.md', 'x'),
    ]);
    expect(exec.lspServers['.claude-plugin/plugin.json:rust']?.command).toBe('rust-analyzer');
    expect(exec.manifestRefs).toMatchObject({
      lspServers: ['(inline)'],
      mcpServers: ['(inline)'],
      commands: ['cmds'],
    });
    expect(exec.errors).toEqual([]);

    const unknown = extractPluginExecutables([manifest({ name: 'p', postInstall: 'curl x | sh' })]);
    expect(unknown.errors.join(' ')).toContain('postInstall');
    const wrongType = extractPluginExecutables([manifest({ name: 'p', hooks: 42 })]);
    expect(wrongType.errors.length).toBeGreaterThan(0);
    const missingContent = extractPluginExecutables([manifest({ name: 'p', commands: './nope' })]);
    expect(missingContent.errors.length).toBeGreaterThan(0);
  });

  it('lspServers i manifestRefs wchodza do pol zatwierdzenia pluginu', () => {
    const plugin: Plugin = {
      kind: 'plugin',
      id: 'acme-a/tools',
      version: '1.0.0',
      source: { type: 'local', path: './tools' },
      activationDefault: 'enabled',
    };
    const base = extractPluginExecutables([manifest({ name: 'p' })]);
    const withLsp = extractPluginExecutables([
      manifest({ name: 'p', lspServers: { a: { command: 'x' } } }),
    ]);
    const hash = (exec: typeof base) =>
      canonicalJson(executionFields(plugin, { treeSha256: 't', files: [], pluginExec: exec }));
    expect(hash(withLsp)).not.toBe(hash(base));
  });
});

describe('zatwierdzenie MCP bez sciezki nie zalezy od projektu (NEW-1) i mcp.json ma sciezke bezwzgledna', () => {
  it('pola polecenia bez sciezki nie niosa projektu, wiec skrot jest ten sam w kazdym projekcie', () => {
    const npx: McpServer = { ...mcp, command: 'npx', args: ['pkg@1.2.3'] };
    expect(canonicalJson(executionFields(npx, {}))).toBe(canonicalJson(executionFields(npx, {})));
    expect(executionFields(npx, {})).toMatchObject({
      projectDir: null,
      commandPath: null,
      commandSha256: null,
    });
  });

  it('buildMcpConfig wpisuje bezwzgledna sciezke po realpath zamiast wzglednej', () => {
    const rel = buildMcpConfig('acme-a', [mcp], { [mcp.id]: '/work/a/bin/serve.sh' });
    expect(JSON.stringify(rel.document)).toContain('"command":"/work/a/bin/serve.sh"');
    const plain = buildMcpConfig('acme-a', [mcp]);
    expect(JSON.stringify(plain.document)).toContain('"command":"./bin/serve.sh"');
  });
});

describe('hooki skilla w polach zatwierdzenia (ADR 0042)', () => {
  const skill: Skill = {
    kind: 'skill',
    id: 'acme-a/careful',
    version: '1.0.0',
    source: 'SKILL.md',
    visibility: 'shared',
    engines: [],
    dependencies: {
      skills: [],
      agents: [],
      workflows: [],
      plugins: [],
      mcp: [],
      settings: [],
      commands: [],
      files: [],
    },
  };
  const plain = {
    allowedTools: false,
    allowedToolsValue: [],
    inlineCommands: false,
    inlineSnippets: [],
    tools: [],
    model: null,
  };
  const hooks = {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command' as const, command: '/p/check.sh', timeout: 5 }],
      },
    ],
  };
  const sha = 's'.repeat(64);
  const pin = (hash: string | null) => ({
    raw: '/p/check.sh',
    sha256: hash,
    unpinnedReason: hash === null ? 'nieprzypiete: brak pliku' : null,
  });

  it('skill z hookami zawsze wymaga zatwierdzenia, bez hookow nie', () => {
    expect(needsApproval(skill, { content: plain, sourceSha256: sha })).toBe(false);
    expect(needsApproval(skill, { content: { ...plain, hooks }, sourceSha256: sha })).toBe(true);
    expect(needsApproval(skill, { content: { ...plain, hooks: {} }, sourceSha256: sha })).toBe(
      false,
    );
  });

  it('pola niosa pelne hooki i piny, a ich zmiana zmienia skrot', () => {
    const base = { content: { ...plain, hooks }, sourceSha256: sha, pins: [pin('a'.repeat(64))] };
    const fields = executionFields(skill, base);
    expect(fields).toMatchObject({
      hooks,
      pins: [{ path: '/p/check.sh', sha256: 'a'.repeat(64) }],
    });
    const key = (f: unknown) => canonicalJson(f);
    const changedScript = executionFields(skill, { ...base, pins: [pin('b'.repeat(64))] });
    const changedHook = executionFields(skill, {
      ...base,
      content: {
        ...plain,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command' as const, command: '/p/check.sh', timeout: 6 }],
            },
          ],
        },
      },
    });
    const status = executionFields(skill, {
      ...base,
      content: {
        ...plain,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command' as const,
                  command: '/p/check.sh',
                  timeout: 5,
                  statusMessage: 'x',
                },
              ],
            },
          ],
        },
      },
    });
    expect(key(changedScript)).not.toBe(key(fields));
    expect(key(changedHook)).not.toBe(key(fields));
    expect(key(status)).not.toBe(key(fields));
  });

  it('skill bez hookow zachowuje dotychczasowe pola (skrot zatwierdzonych bez zmian)', () => {
    const fields = executionFields(skill, {
      content: { ...plain, inlineCommands: true, inlineSnippets: ['ls'] },
      sourceSha256: sha,
    });
    expect(fields).not.toHaveProperty('hooks');
    expect(fields).not.toHaveProperty('pins');
  });

  it('nieprzypiete sciezki skilla sa ostrzezeniem na ekranie zatwierdzenia', () => {
    const warnings = approvalWarnings(skill, {
      content: { ...plain, hooks },
      sourceSha256: sha,
      pins: [pin(null)],
    });
    expect(warnings.some((w) => w.includes('/p/check.sh') && w.includes('nieprzypiete'))).toBe(
      true,
    );
  });
});

describe('pakiety zasobow: zaufane skroty czlonkow (ADR 0044)', () => {
  const tree = 'a'.repeat(64);
  const fields = (over: Partial<MemberFields> = {}): MemberFields => ({
    def: 'b'.repeat(64),
    tree,
    files: [{ path: 'SKILL.md', sha256: 'c'.repeat(16) }],
    filesMore: 0,
    exec: { allowedToolsValue: ['Read'], pins: [] },
    bindings: [],
    ...over,
  });
  const member = (
    key: string,
    f: MemberFields,
    extra: Partial<PackMemberFacts> = {},
  ): PackMemberFacts => ({
    pack: 'global/acme',
    key,
    kind: key.startsWith('files:') ? 'files' : 'skill',
    id: key.slice(key.indexOf(':') + 1),
    fields: f,
    required: f.exec !== null,
    warnings: [],
    deps: [],
    blockers: [],
    ...extra,
  });
  const trustOf = (...members: PackMemberFacts[]): Map<string, PackTrustFile> =>
    new Map([
      [
        'global/acme',
        {
          pack: 'global/acme',
          members: members.map((m) => ({
            key: m.key,
            hash: packMemberHash(m.key, m.fields),
            approvedAt: '2026-11-14T10:00:00.000Z',
            via: 'import' as const,
            fields: m.fields,
          })),
        },
      ],
    ]);

  it('skrot czlonka zalezy od kazdego pola, ale nie od nazwy pakietu', () => {
    const base = packMemberHash('skill:global/x', fields());
    expect(packMemberHash('skill:global/x', fields())).toBe(base);
    expect(packMemberHash('skill:global/y', fields())).not.toBe(base);
    expect(packMemberHash('skill:global/x', fields({ tree: 'd'.repeat(64) }))).not.toBe(base);
    expect(packMemberHash('skill:global/x', fields({ def: null }))).not.toBe(base);
    expect(
      packMemberHash(
        'skill:global/x',
        fields({ exec: { allowedToolsValue: ['Read', 'Bash'], pins: [] } }),
      ),
    ).not.toBe(base);
  });

  it('plik zaufanych skrotow z niezgodnym skrotem czlonka jest odrzucany', () => {
    const f = fields();
    const document = (hash: string): unknown => ({
      apiVersion: 'cwm.dev/v1',
      kind: 'PackApprovals',
      pack: 'global/acme',
      members: [
        {
          key: 'skill:global/x',
          hash,
          approvedAt: '2026-11-14T10:00:00.000Z',
          via: 'import',
          fields: f,
        },
      ],
    });
    expect(validatePackTrustFile(document(packMemberHash('skill:global/x', f))).ok).toBe(true);
    expect(validatePackTrustFile(document('e'.repeat(64))).ok).toBe(false);
  });

  it('czlonek o zgodnym skrocie jest objety zgoda, zmiana drzewa albo pol pyta', () => {
    const a = member('skill:global/a', fields());
    const trust = trustOf(a);
    expect(evaluatePackMembers([a], trust).get(a.key)?.state).toBe('covered');
    const edited = member(a.key, fields({ tree: 'd'.repeat(64) }));
    const verdict = evaluatePackMembers([edited], trust).get(a.key);
    expect(verdict?.state).toBe('pending');
    expect(verdict?.state === 'pending' && verdict.reason).toBe('changed');
    const added = member('skill:global/b', fields());
    const unknown = evaluatePackMembers([a, added], trust).get(added.key);
    expect(unknown?.state === 'pending' && unknown.reason).toBe('new');
  });

  it('czlonek bez pol wykonawczych nie ma werdyktu, ale skrypt hooka z niego jest sprawdzany', () => {
    const script = member('files:global/bin', fields({ def: null, exec: null }));
    const hook = member('skill:global/hook', fields(), {
      deps: [{ rel: 'skills/bin/x.sh', owner: script.key }],
    });
    const trust = trustOf(script, hook);
    expect(evaluatePackMembers([script, hook], trust).has(script.key)).toBe(false);
    expect(evaluatePackMembers([script, hook], trust).get(hook.key)?.state).toBe('covered');
    const changed = member(script.key, fields({ def: null, exec: null, tree: 'd'.repeat(64) }));
    const verdict = evaluatePackMembers([changed, hook], trust).get(hook.key);
    expect(verdict?.state).toBe('pending');
    expect(verdict?.state === 'pending' && verdict.changes.map((c) => c.name)).toEqual([
      `zasob ze skryptem hooka: ${script.key}`,
    ]);
  });

  it('wlasciciel skryptu z innego pakietu nie spelnia zaleznosci, a powiazanie wchodzi do skrotu', () => {
    const owner = member('files:global/helper', fields({ exec: null }), { pack: 'global/other' });
    const hook = member('skill:global/hook', fields(), {
      deps: [{ rel: 'skills/helper/run.sh', owner: owner.key }],
    });
    const trust = new Map([...trustOf(hook), ...trustOf(owner).entries()]);
    const verdict = evaluatePackMembers([owner, hook], trust).get(hook.key);
    expect(verdict?.state === 'pending' && verdict.reason).toBe('blocked');
    const bound = fields({
      bindings: [{ rel: 'skills/helper/run.sh', owner: owner.key, ownerTree: 'f'.repeat(64) }],
    });
    expect(packMemberHash(hook.key, bound)).not.toBe(packMemberHash(hook.key, fields()));
    expect(
      packMemberHash(
        hook.key,
        fields({ bindings: [{ rel: 'skills/helper/run.sh', owner: null, ownerTree: null }] }),
      ),
    ).not.toBe(packMemberHash(hook.key, bound));
  });

  it('skrypt hooka spoza pakietow albo bez wlasciciela blokuje zgode pakietu', () => {
    const outside = member('skill:global/h1', fields(), {
      deps: [{ rel: 'skills/x.sh', owner: 'files:global/poza' }],
    });
    const unowned = member('skill:global/h2', fields(), {
      deps: [{ rel: 'skills/y.sh', owner: null }],
    });
    const trust = trustOf(outside, unowned);
    for (const item of [outside, unowned]) {
      const verdict = evaluatePackMembers([outside, unowned], trust).get(item.key);
      expect(verdict?.state === 'pending' && verdict.reason).toBe('blocked');
    }
  });

  it('czlonek z niedeterministycznymi polami (blocker) nigdy nie jest objety zgoda', () => {
    const a = member('skill:global/a', fields(), { blockers: ['pola zalezne od profilu'] });
    const verdict = evaluatePackMembers([a], trustOf(a)).get(a.key);
    expect(verdict?.state === 'pending' && verdict.reason).toBe('blocked');
  });

  it('mapStrings przeksztalca teksty w glab, a reszte zostawia', () => {
    expect(mapStrings({ a: ['x/p', 1, null], b: { c: 'p' } }, (t) => t.replace('p', 'Q'))).toEqual({
      a: ['x/Q', 1, null],
      b: { c: 'Q' },
    });
  });

  it('grupowanie: katalog zrodlowy po dowiazaniu, wspolny przedrostek, reszta wedlug rodzaju', () => {
    const from = '/h/.claude';
    const groups = groupForPacks(
      [
        { kind: 'skill', id: 'global/qa', sourceReal: `${from}/skills/repo/qa` },
        { kind: 'skill', id: 'global/ship', sourceReal: `${from}/skills/repo/ship` },
        { kind: 'skill', id: 'global/antislop', sourceReal: `${from}/skills/antislop` },
        { kind: 'skill', id: 'global/antislop-ui', sourceReal: `${from}/skills/antislop-ui` },
        { kind: 'skill', id: 'global/notes', sourceReal: `${from}/skills/notes` },
        { kind: 'agent', id: 'global/rev', sourceReal: `${from}/agents/rev.md` },
      ],
      { namespace: 'global', company: false, from, existing: new Map() },
    );
    expect(Object.fromEntries(groups)).toEqual({
      'global/repo': ['skill:global/qa', 'skill:global/ship'],
      'global/antislop': ['skill:global/antislop', 'skill:global/antislop-ui'],
      'global/skills': ['skill:global/notes'],
      'global/agents': ['agent:global/rev'],
    });
    const company = groupForPacks([{ kind: 'skill', id: 'acme/a', sourceReal: null }], {
      namespace: 'acme',
      company: true,
      from,
      existing: new Map(),
    });
    expect([...company.keys()]).toEqual(['acme/acme']);
  });
});

describe('weryfikacja kopii pluginu z git wzgledem commita (ADR 0048)', () => {
  const enc = new TextEncoder();
  const limits = { files: 500, fileBytes: 1024 * 1024, bytes: 10 * 1024 * 1024 };

  /** Repozytorium z jednym plikiem w korzeniu, jednym w podkatalogu (wykonywalnym) i obiektami w danym formacie. */
  function build(algorithm: 'sha1' | 'sha256') {
    const rawLength = algorithm === 'sha1' ? 20 : 32;
    const readme = enc.encode('# acme\r\n');
    const script = enc.encode('#!/bin/sh\necho acme\n');
    const readmeId = gitObjectId(algorithm, 'blob', readme);
    const scriptId = gitObjectId(algorithm, 'blob', script);
    const entry = (mode: string, name: string, id: string): Uint8Array => {
      const head = enc.encode(`${mode} ${name}\0`);
      const out = new Uint8Array(head.length + rawLength);
      out.set(head, 0);
      for (let i = 0; i < rawLength; i += 1)
        out[head.length + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
      return out;
    };
    const join = (parts: Uint8Array[]): Uint8Array => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };
    const subBody = entry('100755', 'run.sh', scriptId);
    const subId = gitObjectId(algorithm, 'tree', subBody);
    const rootBody = join([entry('100644', 'README.md', readmeId), entry('40000', 'bin', subId)]);
    const rootId = gitObjectId(algorithm, 'tree', rootBody);
    const commitBody = enc.encode(`tree ${rootId}\nauthor A <a@example.com> 1 +0000\n\ninit\n`);
    const commit = gitObjectId(algorithm, 'commit', commitBody);
    const objects = new Map<string, Uint8Array>([
      [commit, gitRawObject('commit', commitBody)],
      [rootId, gitRawObject('tree', rootBody)],
      [subId, gitRawObject('tree', subBody)],
    ]);
    const files = [
      { rel: 'README.md', bytes: readme, executable: false },
      { rel: 'bin/run.sh', bytes: script, executable: true },
    ];
    return { commit, objects, files, rootId, subId };
  }

  it('liczy skrot obiektu jak git (wektory znane z git)', () => {
    expect(gitObjectId('sha1', 'blob', enc.encode('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
    expect(gitObjectId('sha1', 'tree', new Uint8Array(0))).toBe(
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    );
  });

  for (const algorithm of ['sha1', 'sha256'] as const) {
    describe(algorithm, () => {
      it('przepuszcza kopie zgodna z commitem (bajty z CRLF bez zmian)', () => {
        const repo = build(algorithm);
        expect(verifyGitCopy(repo.commit, repo.objects, repo.files, limits)).toMatchObject({
          ok: true,
          files: 2,
        });
      });

      it('odmawia po zmianie bajtu pliku, bitu wykonywania, sciezki, dodatkowym i brakujacym pliku', () => {
        const repo = build(algorithm);
        const [readme, script] = repo.files;
        const flipped = new Uint8Array(readme?.bytes ?? []);
        flipped[0] = (flipped[0] ?? 0) ^ 1;
        const bad = (files: typeof repo.files): boolean =>
          verifyGitCopy(repo.commit, repo.objects, files, limits).ok;
        expect(bad([{ ...(readme as object), bytes: flipped } as never, script as never])).toBe(
          false,
        );
        expect(bad([readme as never, { ...(script as object), executable: false } as never])).toBe(
          false,
        );
        expect(
          bad([readme as never, { ...(script as object), rel: 'bin/other.sh' } as never]),
        ).toBe(false);
        expect(
          bad([...repo.files, { rel: 'extra.txt', bytes: new Uint8Array(1), executable: false }]),
        ).toBe(false);
        expect(bad([readme as never])).toBe(false);
      });

      it('odmawia po podmianie obiektu drzewa, commita, braku obiektu i nadmiarowym obiekcie', () => {
        const repo = build(algorithm);
        const swapped = new Map(repo.objects);
        swapped.set(repo.subId, gitRawObject('tree', new Uint8Array(0)));
        expect(verifyGitCopy(repo.commit, swapped, repo.files, limits).ok).toBe(false);

        const forged = new Map(repo.objects);
        forged.set(
          repo.commit,
          gitRawObject('commit', enc.encode(`tree ${repo.rootId}\n\nother\n`)),
        );
        expect(verifyGitCopy(repo.commit, forged, repo.files, limits).ok).toBe(false);

        const missing = new Map(repo.objects);
        missing.delete(repo.subId);
        expect(verifyGitCopy(repo.commit, missing, repo.files, limits).ok).toBe(false);

        const extra = new Map(repo.objects);
        const stray = gitRawObject('blob', enc.encode('x'));
        extra.set(gitObjectId(algorithm, 'blob', enc.encode('x')), stray);
        expect(verifyGitCopy(repo.commit, extra, repo.files, limits).ok).toBe(false);
      });

      it('odmawia, gdy przypiety commit jest inny niz skrot obiektu', () => {
        const repo = build(algorithm);
        const other = repo.commit.replace(/.$/, repo.commit.endsWith('0') ? '1' : '0');
        const renamed = new Map([
          [other, repo.objects.get(repo.commit) as Uint8Array],
          ...repo.objects,
        ]);
        renamed.delete(repo.commit);
        expect(verifyGitCopy(other, renamed, repo.files, limits).ok).toBe(false);
      });
    });
  }

  it('odrzuca dowiazanie symboliczne w drzewie commita', () => {
    const symlinkRepo = build('sha1');
    const link = enc.encode('120000 link\0');
    const body = new Uint8Array(link.length + 20);
    body.set(link, 0);
    const treeId = gitObjectId('sha1', 'tree', body);
    const commitBody = enc.encode(`tree ${treeId}\n\nx\n`);
    const commit = gitObjectId('sha1', 'commit', commitBody);
    const objects = new Map([
      [commit, gitRawObject('commit', commitBody)],
      [treeId, gitRawObject('tree', body)],
    ]);
    expect(verifyGitCopy(commit, objects, symlinkRepo.files, limits).ok).toBe(false);
  });

  it('parsuje wyjscie cat-file --batch i odrzuca uszkodzone', () => {
    const id = 'a'.repeat(40);
    const good = enc.encode(`${id} blob 3\nabc\n`);
    const parsed = parseGitCatFileBatch(good, 40);
    expect(parsed.ok && parsed.objects[0]?.type).toBe('blob');
    expect(parseGitCatFileBatch(enc.encode(`${id} blob 9\nabc\n`), 40).ok).toBe(false);
    expect(parseGitCatFileBatch(enc.encode(`${id} missing\n`), 40).ok).toBe(false);
  });
});

describe('plan drzewa git: tryb 100664, kolizje nazw i dlugie nazwy (ADR 0048)', () => {
  const enc = new TextEncoder();
  const limits = { files: 500, fileBytes: 1024 * 1024, bytes: 10 * 1024 * 1024 };

  /** Repozytorium SHA-1 z plikami o podanych trybach i nazwach w korzeniu (tresc pliku to jego nazwa). */
  function flat(entries: readonly { mode: string; name: string }[]) {
    const parts = entries.map(({ mode, name }) => {
      const id = gitObjectId('sha1', 'blob', enc.encode(name));
      const head = enc.encode(`${mode} ${name}\0`);
      const out = new Uint8Array(head.length + 20);
      out.set(head, 0);
      for (let i = 0; i < 20; i += 1)
        out[head.length + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
      return out;
    });
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      body.set(part, at);
      at += part.length;
    }
    const treeId = gitObjectId('sha1', 'tree', body);
    const commitBody = enc.encode(`tree ${treeId}\n\nx\n`);
    const commit = gitObjectId('sha1', 'commit', commitBody);
    const objects = new Map([
      [commit, gitRawObject('commit', commitBody)],
      [treeId, gitRawObject('tree', body)],
    ]);
    const files = entries.map(({ mode, name }) => ({
      rel: name,
      bytes: enc.encode(name),
      executable: mode === '100755',
    }));
    return { commit, objects, files };
  }

  it('przyjmuje dawny tryb 100664 jako zwykly plik bez bitu wykonywania', () => {
    const repo = flat([{ mode: '100664', name: 'a.txt' }]);
    expect(verifyGitCopy(repo.commit, repo.objects, repo.files, limits).ok).toBe(true);
    const flagged = repo.files.map((file) => ({ ...file, executable: true }));
    expect(verifyGitCopy(repo.commit, repo.objects, flagged, limits).ok).toBe(false);
  });

  it('odrzuca nazwy rozniace sie tylko wielkoscia liter albo normalizacja Unicode', () => {
    for (const names of [
      ['README', 'readme'],
      ['café.md', 'café.md'],
    ]) {
      const repo = flat(names.map((name) => ({ mode: '100644', name })));
      const verdict = verifyGitCopy(repo.commit, repo.objects, repo.files, limits);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.message).toContain('kolizja wielkosci liter');
    }
  });

  it('odrzuca zbyt dluga nazwe wpisu drzewa', () => {
    const repo = flat([{ mode: '100644', name: `${'a'.repeat(201)}.md` }]);
    const verdict = verifyGitCopy(repo.commit, repo.objects, repo.files, limits);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.message).toContain('zbyt dluga');
  });
});

describe('workflow orchestrated: kroki w manifescie i zatwierdzenie (ADR 0050)', () => {
  const manifest = (steps: unknown): unknown => ({
    apiVersion: 'cwm.dev/v1',
    kind: 'Workflow',
    metadata: { id: 'acme-a/flow', version: '1.0.0' },
    spec: { type: 'orchestrated', source: 'workflow.md', steps },
  });
  const steps = [
    { id: 'lint', agent: 'acme-a/linter', task: 'Check style.' },
    { id: 'ship', agent: 'acme-a/shipper', dependsOn: ['lint'] },
  ];

  it('przyjmuje task kroku i zachowuje go w modelu', () => {
    const result = validateResource(manifest(steps));
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'workflow') {
      expect(result.value.steps[0]).toMatchObject({ id: 'lint', task: 'Check style.' });
      expect(result.value.steps[1]).not.toHaveProperty('task');
    }
  });

  it.each([
    ['nowa linia', 'a\nb'],
    ['tabulator', 'a\tb'],
    ['znak formatujacy', `a${String.fromCharCode(0x202e)}b`],
    ['za dlugi', 'x'.repeat(1001)],
    ['pusty', '   '],
    ['nie tekst', 5],
  ])('odrzuca task kroku: %s', (_label, task) => {
    const result = validateResource(manifest([{ id: 'lint', agent: 'acme-a/linter', task }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe('spec.steps[0].task');
  });

  it('cykl i nieznany krok nadal sa odrzucane', () => {
    expect(
      validateResource(
        manifest([
          { id: 'a', agent: 'acme-a/x', dependsOn: ['b'] },
          { id: 'b', agent: 'acme-a/x', dependsOn: ['a'] },
        ]),
      ).ok,
    ).toBe(false);
    expect(validateResource(manifest([{ id: 'a', agent: 'acme-a/x', dependsOn: ['zz'] }])).ok).toBe(
      false,
    );
  });

  it('komunikat o cyklu wymienia kroki', () => {
    const result = validateResource(
      manifest([
        { id: 'a', agent: 'acme-a/x', dependsOn: ['b'] },
        { id: 'b', agent: 'acme-a/x', dependsOn: ['a'] },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('a -> b -> a');
  });

  it('zmiana agenta w wygenerowanej tresci zmienia skrot zatwierdzenia', () => {
    const workflow: Workflow = {
      kind: 'workflow',
      id: 'acme-a/flow',
      version: '1.0.0',
      type: 'orchestrated',
      source: 'workflow.md',
      agents: [],
      steps: [{ id: 'lint', agent: 'acme-a/linter', dependsOn: [] }],
    };
    const content = {
      allowedTools: true,
      allowedToolsValue: ['Task'],
      inlineCommands: false,
      inlineSnippets: [],
      tools: [],
      model: null,
    };
    const hashOf = (sha: string): string =>
      approvalHash({
        company: 'acme-a',
        kind: 'workflow',
        id: workflow.id,
        fields: executionFields(workflow, { content, sourceSha256: sha }),
      });
    expect(needsApproval(workflow, { content, sourceSha256: 'a'.repeat(64) })).toBe(true);
    expect(hashOf('a'.repeat(64))).not.toBe(hashOf('b'.repeat(64)));
  });
});
