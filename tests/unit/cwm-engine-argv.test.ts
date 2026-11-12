import { describe, expect, it } from 'vitest';

import {
  buildEngineArgv,
  checkPassThroughArgs,
  ENGINE_SUBCOMMANDS,
  type ArgvInput,
} from '../../src/core/cwm';

const base: ArgvInput = {
  settingsFile: '/cwm/runtime/acme-a/sessions/0123456789abcdef/settings.json',
  mcpConfigFile: '/cwm/runtime/acme-a/sessions/0123456789abcdef/mcp.json',
  pluginDirs: [
    '/cwm/runtime/acme-a/sessions/0123456789abcdef/plugin',
    '/cwm/runtime/acme-a/plugins/acme-a-tools@0123456789abcdef',
  ],
  strictMcp: false,
  userArgs: [],
};

function argvOf(overrides: Partial<ArgvInput> = {}): readonly string[] {
  const result = buildEngineArgv({ ...base, ...overrides });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.argv;
}

describe('buildEngineArgv (SPN-03, V-05, V-06)', () => {
  it('flagi wielowartosciowe maja forme --flaga=wartosc, a --settings jest ostatnia flaga CWM', () => {
    const argv = argvOf();
    expect(argv).toEqual([
      `--plugin-dir=${base.pluginDirs[0]}`,
      `--plugin-dir=${base.pluginDirs[1]}`,
      `--mcp-config=${base.mcpConfigFile}`,
      '--settings',
      base.settingsFile,
    ]);
  });

  it('prompt idzie po "--", a tuz przed nim stoi wartosc jednowartosciowej flagi --settings', () => {
    const argv = argvOf({ userArgs: ['napraw test'] });
    expect(argv.slice(-4)).toEqual(['--settings', base.settingsFile, '--', 'napraw test']);
    expect(argv.filter((arg) => arg === '--mcp-config' || arg === '--plugin-dir')).toEqual([]);
  });

  it('argumenty z opcjami nie dostaja "--" (inaczej -p stalby sie tekstem promptu)', () => {
    const argv = argvOf({ userArgs: ['-p', 'napraw test', '--model', 'haiku'] });
    expect(argv).not.toContain('--');
    expect(argv.slice(-4)).toEqual(['-p', 'napraw test', '--model', 'haiku']);
  });

  it('bez konfiguracji MCP i pluginow zostaje tylko --settings', () => {
    expect(argvOf({ mcpConfigFile: null, pluginDirs: [] })).toEqual([
      '--settings',
      base.settingsFile,
    ]);
  });

  it('--strict-mcp dodaje --strict-mcp-config przed --settings', () => {
    const argv = argvOf({ strictMcp: true });
    expect(argv.indexOf('--strict-mcp-config')).toBeGreaterThan(-1);
    expect(argv.indexOf('--strict-mcp-config')).toBeLessThan(argv.indexOf('--settings'));
  });

  it('prompt wygladajacy jak plik nie ma pierwszenstwa przed --: stoi po separatorze', () => {
    const argv = argvOf({ userArgs: ['/etc/passwd'] });
    expect(argv.slice(-2)).toEqual(['--', '/etc/passwd']);
  });
});

describe('checkPassThroughArgs', () => {
  it.each([
    '--settings',
    '--mcp-config',
    '--strict-mcp-config',
    '--plugin-dir',
    '--plugin-url',
    '--setting-sources',
    '--bare',
    '--safe-mode',
  ])('odrzuca zarzadzana flage %s w obu formach', (flag) => {
    expect(checkPassThroughArgs([flag, 'x']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs([`${flag}=x`]).length).toBeGreaterThan(0);
    expect(buildEngineArgv({ ...base, userArgs: [`${flag}=x`] }).ok).toBe(false);
  });

  it.each([
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--agents',
    '--debug-file',
    '--file',
    '--desktop',
    '--cloud',
    '--teleport',
    '--remote-control',
    '--environment',
  ])('odrzuca flage %s', (flag) => {
    expect(checkPassThroughArgs([flag]).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs([`${flag}=x`]).length).toBeGreaterThan(0);
  });

  it('odrzuca tryb bypassPermissions w obu formach, ale nie inne tryby', () => {
    expect(checkPassThroughArgs(['--permission-mode', 'bypassPermissions']).length).toBeGreaterThan(
      0,
    );
    expect(checkPassThroughArgs(['--permission-mode=bypassPermissions']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--permission-mode=BYPASSPERMISSIONS']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--permission-mode', 'plan'])).toEqual([]);
  });

  it.each(ENGINE_SUBCOMMANDS)(
    'odrzuca podpolecenie silnika "%s" jako pierwszy argument',
    (name) => {
      expect(checkPassThroughArgs([name, 'add']).length).toBeGreaterThan(0);
      expect(checkPassThroughArgs(['--verbose', name]).length).toBeGreaterThan(0);
    },
  );

  it('podpolecenie jako dalsze slowo promptu jest dozwolone', () => {
    expect(checkPassThroughArgs(['napraw mcp i plugin'])).toEqual([]);
    expect(checkPassThroughArgs(['-p', 'update the docs'])).toEqual([]);
  });

  it('odrzuca podpolecenie jako dowolny argument pozycyjny, nie tylko pierwszy (SEC-02)', () => {
    expect(checkPassThroughArgs(['--model', 'haiku', 'mcp', 'add', 'evil']).length).toBeGreaterThan(
      0,
    );
    expect(
      checkPassThroughArgs(['--resume', 'abc123', 'plugin', 'install', 'x']).length,
    ).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['-p', 'tekst', 'config', 'set']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--add-dir', '/tmp/x', 'install']).length).toBeGreaterThan(0);
    expect(buildEngineArgv({ ...base, userArgs: ['--model', 'x', 'mcp', 'add', 'y'] }).ok).toBe(
      false,
    );
  });

  it.each([
    'plugins',
    'upgrade',
    'kill',
    'gateway',
    'import',
    'auto-mode',
    'purge',
    'respawn',
    'ultrareview',
  ])('odrzuca alias/podpolecenie %s z claude --help 2.1.322', (name) => {
    expect(checkPassThroughArgs([name]).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--model', 'x', name, 'arg']).length).toBeGreaterThan(0);
  });

  it('wartosc opcji po znaku = nie jest argumentem pozycyjnym', () => {
    expect(checkPassThroughArgs(['--model=mcp', '-p', 'hej'])).toEqual([]);
  });

  it('odrzuca drugie "--" i znak NUL', () => {
    expect(checkPassThroughArgs(['--', 'x']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['a\0b']).length).toBeGreaterThan(0);
  });

  it('przepuszcza zwykle flagi i prompt', () => {
    expect(checkPassThroughArgs(['-p', 'hej', '--model', 'haiku', '--max-turns', '3'])).toEqual([]);
    expect(checkPassThroughArgs([])).toEqual([]);
  });
});
