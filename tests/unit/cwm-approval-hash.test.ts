import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  approvalHash,
  buildMcpConfig,
  canonicalJson,
  diffFields,
  executionFields,
  extractInlineCommands,
  extractPluginExecutables,
  mcpCommandIsPath,
  needsApproval,
  approvalWarnings,
  projectApprovalKey,
  validateApprovalsFile,
  type McpServer,
  type Plugin,
  type Skill,
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
