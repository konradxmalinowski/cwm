import {
  chmodSync,
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildChildEnv,
  buildEngineProbeEnv,
  buildGitEnv,
  checkGitTreeListing,
  foreignEnvRefs,
  gitHardeningArgs,
  gitRefProblem,
  gitUrlProblem,
  sanitizeGitUrl,
  sanitizePath,
  type ChildEnvInput,
} from '../../src/core/cwm';
import {
  createLayout,
  engineChecksFile,
  readEngineChecks,
  collectEngineMetadata,
  recordEngineCheck,
  runEngineCheck,
  runEngineMetadata,
} from '../../src/infra/cwm';

const input = (overrides: Partial<ChildEnvInput> = {}): ChildEnvInput => ({
  parent: {},
  configDir: '/cwm/runtime/acme-a/claude',
  tmpDir: '/cwm/runtime/acme-a/tmp',
  ownRefs: [],
  otherCompanyRefs: [],
  passthrough: [],
  settingsEnvRefs: {},
  ...overrides,
});

describe('sanitizePath', () => {
  it('zostawia tylko bezwzgledne, niepuste elementy bez powtorzen', () => {
    expect(sanitizePath('/usr/bin::bin:.:/usr/local/bin:/usr/bin:../x')).toBe(
      '/usr/bin:/usr/local/bin',
    );
  });

  it('daje bezpieczna wartosc domyslna, gdy nic nie zostaje', () => {
    expect(sanitizePath(undefined)).toBe('/usr/bin:/bin');
    expect(sanitizePath('::.:rel')).toBe('/usr/bin:/bin');
  });
});

describe('buildChildEnv (SPN-02)', () => {
  it('dziedziczy zwykle zmienne, a nie wartosci sekretow', () => {
    const result = buildChildEnv(
      input({
        parent: {
          HOME: '/home/u',
          JAVA_HOME: '/jdk',
          LANG: 'pl_PL.UTF-8',
          GITHUB_TOKEN: 'x',
          DB_PASSWORD: 'y',
        },
      }),
    );
    expect(result.env['HOME']).toBe('/home/u');
    expect(result.env['JAVA_HOME']).toBe('/jdk');
    expect(result.env['GITHUB_TOKEN']).toBeUndefined();
    expect(result.env['DB_PASSWORD']).toBeUndefined();
    expect(result.removed).toEqual(['DB_PASSWORD', 'GITHUB_TOKEN']);
  });

  it('zostawia sekret, ktory jest envRef tej firmy albo jest na liscie passthrough', () => {
    const result = buildChildEnv(
      input({
        parent: { ACME_A_TOKEN: 'a', NPM_TOKEN: 'b', OTHER_SECRET: 'c' },
        ownRefs: ['ACME_A_TOKEN'],
        passthrough: ['NPM_TOKEN'],
      }),
    );
    expect(result.env['ACME_A_TOKEN']).toBe('a');
    expect(result.env['NPM_TOKEN']).toBe('b');
    expect(result.removed).toEqual(['OTHER_SECRET']);
  });

  it('usuwa envRef innych firm, takze gdy nazwa nie wyglada na sekret', () => {
    const result = buildChildEnv(
      input({
        parent: { ACME_B_ENDPOINT: 'https://b.example', KEEP: '1' },
        otherCompanyRefs: ['ACME_B_ENDPOINT'],
      }),
    );
    expect(result.env['ACME_B_ENDPOINT']).toBeUndefined();
    expect(result.env['KEEP']).toBe('1');
  });

  it('zmienna wspolna dla dwoch firm zostaje, jesli jest tez wlasnym envRef', () => {
    const result = buildChildEnv(
      input({
        parent: { SHARED_URL: 'u' },
        ownRefs: ['SHARED_URL'],
        otherCompanyRefs: ['SHARED_URL'],
      }),
    );
    expect(result.env['SHARED_URL']).toBe('u');
  });

  it('usuwa rodzine ANTHROPIC_*, CLAUDE_* i CLAUDECODE z rodzica, chyba ze jest na liscie firmy', () => {
    const result = buildChildEnv(
      input({
        parent: {
          ANTHROPIC_API_KEY: 'k',
          ANTHROPIC_MODEL: 'm',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
          CLAUDE_CODE_PLUGIN_CACHE_DIR: '/shared',
          CLAUDE_CONFIG_DIR: '/home/u/.claude',
          CLAUDECODE: '1',
        },
        passthrough: ['ANTHROPIC_MODEL'],
      }),
    );
    expect(result.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(result.env['ANTHROPIC_MODEL']).toBe('m');
    expect(result.env['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    expect(result.env['CLAUDE_CODE_PLUGIN_CACHE_DIR']).toBeUndefined();
    expect(result.env['CLAUDECODE']).toBeUndefined();
  });

  it('ustawia CLAUDE_CONFIG_DIR i CLAUDE_CODE_TMPDIR, nawet gdy lista firmy je wymienia', () => {
    const result = buildChildEnv(
      input({
        parent: { CLAUDE_CONFIG_DIR: '/home/u/.claude', CLAUDE_CODE_TMPDIR: '/tmp/x' },
        passthrough: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR'],
      }),
    );
    expect(result.env['CLAUDE_CONFIG_DIR']).toBe('/cwm/runtime/acme-a/claude');
    expect(result.env['CLAUDE_CODE_TMPDIR']).toBe('/cwm/runtime/acme-a/tmp');
    expect(result.added).toEqual(
      expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR']),
    );
  });

  it('oczyszcza PATH z elementow wzglednych i pustych', () => {
    const result = buildChildEnv(input({ parent: { PATH: '.:/usr/bin::bin:/opt/bin' } }));
    expect(result.env['PATH']).toBe('/usr/bin:/opt/bin');
  });

  it('nie zdejmuje zmiennych systemowych, ktore tylko wygladaja jak sekret', () => {
    const result = buildChildEnv(
      input({
        parent: { XDG_SESSION_ID: '1', TERM_SESSION_ID: 'w0', SSH_AUTH_SOCK: '/tmp/agent' },
      }),
    );
    expect(result.env['XDG_SESSION_ID']).toBe('1');
    expect(result.env['TERM_SESSION_ID']).toBe('w0');
    expect(result.env['SSH_AUTH_SOCK']).toBeUndefined();
  });

  it('dziedziczy sciezki i identyfikatory, ktore wzorzec sekretu lapie przez przypadek', () => {
    const parent = {
      FPATH: '/usr/share/zsh/functions',
      INFOPATH: '/opt/info',
      PWD: '/work',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
      WARP_TERMINAL_SESSION_UUID: 'u-1',
      NoDefaultCurrentDirectoryInExePath: '1',
    };
    const result = buildChildEnv(input({ parent }));
    for (const [name, value] of Object.entries(parent)) expect(result.env[name]).toBe(value);
    expect(result.removed).toEqual([]);
  });

  it('materializuje Settings.env z envRef wylacznie w srodowisku dziecka (SET-02)', () => {
    const result = buildChildEnv(
      input({
        parent: { ACME_PROXY_PASS: 'p' },
        ownRefs: ['ACME_PROXY_PASS'],
        settingsEnvRefs: { PROXY_USER_SECRET: 'ACME_PROXY_PASS' },
      }),
    );
    expect(result.env['PROXY_USER_SECRET']).toBe('p');
    expect(result.added).toContain('PROXY_USER_SECRET');
    expect(result.missing).toEqual([]);
  });

  it('zglasza brakujace i puste zmienne envRef bez wartosci', () => {
    const result = buildChildEnv(
      input({
        parent: { EMPTY_TOKEN: '' },
        ownRefs: ['EMPTY_TOKEN', 'ABSENT_TOKEN'],
        settingsEnvRefs: { SOME_NAME: 'ABSENT_SETTINGS_REF' },
      }),
    );
    expect(result.missing).toEqual(['ABSENT_SETTINGS_REF', 'ABSENT_TOKEN', 'EMPTY_TOKEN']);
    expect(result.env['SOME_NAME']).toBeUndefined();
  });

  it('wlasny envRef z rodziny silnika jest zglaszany jako zarezerwowany i nie trafia do srodowiska', () => {
    const result = buildChildEnv(
      input({ parent: { ANTHROPIC_API_KEY: 'k' }, ownRefs: ['ANTHROPIC_API_KEY'] }),
    );
    expect(result.reserved).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('nie zmienia wejsciowego srodowiska i nie zwraca wartosci w listach nazw', () => {
    const parent = { GITHUB_TOKEN: 'super-tajne', HOME: '/h' };
    const copy = { ...parent };
    const result = buildChildEnv(input({ parent }));
    expect(parent).toEqual(copy);
    expect(
      JSON.stringify([result.removed, result.added, result.missing, result.reserved]),
    ).not.toContain('super-tajne');
  });
});

describe('foreignEnvRefs (SEC-03)', () => {
  it('to wszystkie envRef z rejestru poza wlasnymi, bez powtorzen i posortowane', () => {
    expect(foreignEnvRefs(['B_TOKEN', 'GLOBAL_PROXY', 'A_TOKEN', 'B_TOKEN'], ['A_TOKEN'])).toEqual([
      'B_TOKEN',
      'GLOBAL_PROXY',
    ]);
    expect(foreignEnvRefs([], ['A_TOKEN'])).toEqual([]);
  });

  it('zmienna nieuzywana przez te firme, a znana z rejestru, jest usuwana ze srodowiska dziecka', () => {
    const others = foreignEnvRefs(['UNUSED_GLOBAL_ENDPOINT', 'OWN_ENDPOINT'], ['OWN_ENDPOINT']);
    const result = buildChildEnv(
      input({
        parent: { UNUSED_GLOBAL_ENDPOINT: 'u', OWN_ENDPOINT: 'o' },
        ownRefs: ['OWN_ENDPOINT'],
        otherCompanyRefs: others,
      }),
    );
    expect(result.env['UNUSED_GLOBAL_ENDPOINT']).toBeUndefined();
    expect(result.env['OWN_ENDPOINT']).toBe('o');
  });
});

describe('wartosci o ksztalcie sekretu i PATH (SEC-11)', () => {
  const token = `gh${'p_'}${'a1B2c3D4e5F6g7H8'}`;
  const withPassword = `post${'gres://'}user:${'pw'}@db.example.invalid/app`;

  it('usuwa zmienne z wartoscia o ksztalcie sekretu, raportujac tylko nazwy', () => {
    const result = buildChildEnv(
      input({ parent: { SOME_VAR: token, DB_URL: withPassword, PLAIN: 'ok' } }),
    );
    expect(result.env['SOME_VAR']).toBeUndefined();
    expect(result.env['DB_URL']).toBeUndefined();
    expect(result.env['PLAIN']).toBe('ok');
    expect(result.secretShaped).toEqual(['DB_URL', 'SOME_VAR']);
    expect(JSON.stringify(result.secretShaped)).not.toContain(token);
  });

  it('zostawia taka wartosc, gdy to envRef tej firmy albo passthrough', () => {
    const result = buildChildEnv(
      input({
        parent: { OWN_DB_URL: withPassword, PASSED: token },
        ownRefs: ['OWN_DB_URL'],
        passthrough: ['PASSED'],
      }),
    );
    expect(result.env['OWN_DB_URL']).toBe(withPassword);
    expect(result.env['PASSED']).toBe(token);
    expect(result.secretShaped).toEqual([]);
  });

  it('usuwa z PATH elementy w katalogu projektu', () => {
    expect(sanitizePath('/work/proj/bin:/usr/bin:/work/proj:/work/other', '/work/proj')).toBe(
      '/usr/bin:/work/other',
    );
    const result = buildChildEnv(
      input({
        parent: { PATH: '/work/proj/node_modules/.bin:/usr/bin' },
        projectDir: '/work/proj',
      }),
    );
    expect(result.env['PATH']).toBe('/usr/bin');
  });
});

describe('srodowisko i opcje procesu git (ADR 0048)', () => {
  const gitInput = {
    parent: {
      HOME: '/home/u',
      PATH: '/evil/bin:/usr/bin',
      GITHUB_TOKEN: 'ghp_xxx',
      SSH_AUTH_SOCK: '/tmp/agent',
      GIT_SSH_COMMAND: 'evil',
      GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
      GIT_EXEC_PATH: '/evil',
      HTTPS_PROXY: 'http://proxy.example:3128',
      SSL_CERT_FILE: '/etc/ssl/ca.pem',
      ANTHROPIC_API_KEY: 'sk-ant-x',
    },
    scratchDir: '/cwm/sources/git/.tmp-1',
    gitDir: '/usr/bin',
    allowLoopbackHttp: false,
  };

  it('buduje srodowisko od zera: bez sekretow, agenta ssh, GIT_* rodzica i prawdziwego HOME', () => {
    const env = buildGitEnv(gitInput);
    expect(Object.keys(env).sort()).toEqual(
      [
        'GIT_ALLOW_PROTOCOL',
        'GIT_ATTR_NOSYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_SYSTEM',
        'GIT_LFS_SKIP_SMUDGE',
        'GIT_NO_LAZY_FETCH',
        'GIT_NO_REPLACE_OBJECTS',
        'GIT_OPTIONAL_LOCKS',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'HTTPS_PROXY',
        'LANG',
        'LC_ALL',
        'PATH',
        'SSL_CERT_FILE',
        'TMPDIR',
        'XDG_CONFIG_HOME',
      ].sort(),
    );
    expect(env['HOME']).toBe('/cwm/sources/git/.tmp-1');
    expect(env['PATH']).toBe('/usr/bin:/usr/bin:/bin');
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('https');
  });

  it('http dopuszcza tylko dla petli zwrotnej i wylacza dla niej proxy', () => {
    const env = buildGitEnv({ ...gitInput, allowLoopbackHttp: true });
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('https:http');
    expect(env['NO_PROXY']).toBe('localhost,127.0.0.1,::1');
    expect(gitHardeningArgs(true)).toContain('protocol.http.allow=always');
    expect(gitHardeningArgs(false)).toContain('protocol.http.allow=never');
  });

  it('opcje -c wylaczaja hooki, protokoly file i ext, przekierowania, submoduly i LFS', () => {
    const settings = gitHardeningArgs(false).filter((_, index) => index % 2 === 1);
    for (const expected of [
      'core.hooksPath=/dev/null',
      'protocol.allow=never',
      'protocol.file.allow=never',
      'protocol.ext.allow=never',
      'protocol.ssh.allow=never',
      'http.followRedirects=false',
      'fetch.recurseSubmodules=false',
      'filter.lfs.smudge=',
      'filter.lfs.required=false',
      'credential.helper=',
      'transfer.fsckObjects=true',
    ]) {
      expect(settings).toContain(expected);
    }
    expect(gitHardeningArgs(false).filter((_, index) => index % 2 === 0)).not.toContain('--');
  });

  it('odrzuca adresy file, ext, ssh, z haslem, zapytaniem i bialymi znakami', () => {
    for (const bad of [
      'file:///tmp/repo',
      'ext::sh -c id',
      '/tmp/repo',
      'ssh://git@example.com/acme/tools.git',
      'git@example.com:acme/tools.git',
      'git://example.com/acme/tools.git',
      'http://example.com/acme/tools.git',
      'https://user:pass@example.com/acme/tools.git',
      'https://token@example.com/acme/tools.git',
      'https://example.com/acme/tools.git?x=1',
      'https://example.com/acme/tools.git#frag',
      'https://example.com/',
      'https://example.com/acme/tools .git',
      'https://example.com/acme\\tools.git',
      '-https://example.com/a',
      'HTTPS://example.com/acme/tools.git',
      'http://\uFF11\uFF12\uFF17.0.0.1/acme/tools.git',
      'http:127.0.0.1:8080/acme/tools.git',
      'https://EXAMPLE.com/acme/tools.git',
      'https://example.com:443/acme/tools.git',
    ]) {
      expect(gitUrlProblem(bad), bad).not.toBeNull();
    }
    for (const good of [
      'https://example.com/acme/tools.git',
      'https://example.com:8443/acme/tools',
      'http://127.0.0.1:8080/acme/tools.git',
      'http://localhost/acme/tools.git',
    ]) {
      expect(gitUrlProblem(good), good).toBeNull();
    }
  });

  it('sanityzuje adres do wyswietlenia i odrzuca skrocony SHA oraz zle refy', () => {
    expect(sanitizeGitUrl('https://user:pass@example.com/a/b.git?token=x#f')).toBe(
      'https://example.com/a/b.git',
    );
    expect(gitRefProblem('main')).toBeNull();
    expect(gitRefProblem('refs/tags/v1.0.0')).toBeNull();
    expect(gitRefProblem('a'.repeat(40))).toBeNull();
    for (const bad of ['-x', 'abc1234', 'a..b', 'x/', 'a//b', 'x.lock', 'a b']) {
      expect(gitRefProblem(bad), bad).not.toBeNull();
    }
  });

  describe('lista plikow commita', () => {
    const limits = { files: 3, fileBytes: 100, bytes: 150 };
    const entry = (mode: string, type: string, size: string, path: string): string =>
      `${mode} ${type} ${'a'.repeat(40)} ${size.padStart(7)}\t${path}\0`;

    it('przyjmuje zwykle pliki i zbiera submoduly', () => {
      const raw =
        entry('100644', 'blob', '10', 'a.md') +
        entry('100755', 'blob', '20', 'bin/run.sh') +
        entry('160000', 'commit', '-', 'vendor/lib');
      expect(checkGitTreeListing(raw, limits)).toEqual({
        ok: true,
        files: 2,
        bytes: 30,
        submodules: ['vendor/lib'],
      });
    });

    it('odrzuca sciezki rozniace sie tylko wielkoscia liter albo postacia unicode', () => {
      const res = (raw: string) => checkGitTreeListing(raw, limits);
      expect(
        res(entry('100644', 'blob', '1', 'SKILL.md') + entry('100644', 'blob', '1', 'skill.md')),
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining('wielkoscia liter') as string,
      });
      // Katalog i plik o tej samej nazwie z dokladnoscia do wielkosci liter tez sie zderzaja.
      expect(
        res(entry('040000', 'tree', '-', 'Skills') + entry('100644', 'blob', '1', 'skills')),
      ).toMatchObject({ ok: false });
      expect(
        res(
          entry('100644', 'blob', '1', 'caf\u00e9.md') +
            entry('100644', 'blob', '1', 'cafe\u0301.md'),
        ),
      ).toMatchObject({ ok: false });
      // Rozne nazwy i ta sama nazwa w roznych katalogach przechodza.
      expect(
        res(
          entry('100644', 'blob', '1', 'a/SKILL.md') + entry('100644', 'blob', '1', 'b/SKILL.md'),
        ),
      ).toMatchObject({ ok: true });
    });

    it('odrzuca dowiazanie, skladnik .git, limity i pusty commit', () => {
      const bad = (raw: string): boolean => !checkGitTreeListing(raw, limits).ok;
      expect(bad(entry('120000', 'blob', '5', 'link'))).toBe(true);
      expect(bad(entry('100644', 'blob', '5', 'x/.GIT/config'))).toBe(true);
      expect(bad(entry('100644', 'blob', '101', 'big'))).toBe(true);
      expect(bad(['a', 'b', 'c', 'd'].map((n) => entry('100644', 'blob', '1', n)).join(''))).toBe(
        true,
      );
      expect(bad(entry('100644', 'blob', '99', 'a') + entry('100644', 'blob', '99', 'b'))).toBe(
        true,
      );
      expect(bad(entry('100644', 'blob', '5', 'a\nb'))).toBe(true);
      expect(bad(entry('100644', 'blob', '5', 'a\u202Eb'))).toBe(true);
      expect(bad(entry('100644', 'blob', '5', 'a\u2028b'))).toBe(true);
      expect(bad('')).toBe(true);
      expect(bad('nonsense\0')).toBe(true);
    });
  });
});

describe('srodowisko prob metadanych silnika (ADR 0052)', () => {
  it('ma tylko PATH bez elementow wzglednych, HOME, CLAUDE_CONFIG_DIR z katalogu proby i wylaczone aktualizacje', () => {
    const env = buildEngineProbeEnv(
      {
        PATH: '/usr/bin:.:bin:/evil/../bin:/usr/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'sk-ant-x',
        GITHUB_TOKEN: 'ghp_x',
        CLAUDE_CONFIG_DIR: '/home/u/.claude',
        AWS_SECRET_ACCESS_KEY: 'x',
      },
      '/tmp/acme-probe',
      null,
    );
    expect(env).toEqual({
      PATH: '/usr/bin:/evil/../bin',
      HOME: '/home/u',
      CLAUDE_CONFIG_DIR: '/tmp/acme-probe',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(buildEngineProbeEnv({}, '/tmp/p', null)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '',
      CLAUDE_CONFIG_DIR: '/tmp/p',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('wycina z PATH elementy w katalogu projektu: shim silnika nie dostanie interpretera z repozytorium (SEC-E1)', () => {
    const env = buildEngineProbeEnv(
      { PATH: '/work/acme/node_modules/.bin:/work/acme:/usr/local/bin:/usr/bin', HOME: '/h' },
      '/tmp/p',
      '/work/acme',
    );
    expect(env['PATH']).toBe('/usr/local/bin:/usr/bin');
    // Projekt jedyny na PATH: wraca bezpieczna wartosc domyslna, nie katalog projektu.
    expect(buildEngineProbeEnv({ PATH: '/work/acme/bin' }, '/tmp/p', '/work/acme')['PATH']).toBe(
      '/usr/bin:/bin',
    );
    expect(
      buildEngineProbeEnv({ PATH: '/work/acme-other/bin' }, '/tmp/p', '/work/acme')['PATH'],
    ).toBe('/work/acme-other/bin');
  });
});

describe.skipIf(process.platform === 'win32')('sprawdzenie silnika na atrapie (ADR 0052)', () => {
  const root = mkdtempSync(join(tmpdir(), 'acme-engine-check-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const HELP = [
    'Usage: stub [options] [command]',
    '',
    'Options:',
    '  --settings <file>        Settings',
    '  --mcp-config <configs>   MCP config',
    '  --strict-mcp-config      Strict',
    '  --plugin-dir <path>      Plugin dir',
    '',
    'Commands:',
    '  mcp                      MCP',
    '  newcmd [x]               Nowe',
    '',
  ].join('\n');
  const stub = join(root, 'stub-claude');
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      'D=$(dirname "$0")',
      'echo "$*" >> "$D/calls.log"',
      'case "$1" in',
      '  --version) echo "9.9.9 (Claude Code)" ;;',
      `  --help) cat <<'EOF'`,
      HELP,
      'EOF',
      '  ;;',
      '  plugin) echo "Not logged in" ; exit 1 ;;',
      '  mcp) echo "Usage: stub mcp" ;;',
      '  --dump) /usr/bin/env ; pwd ;;',
      '  --flood) i=0; while [ $i -lt 2000 ]; do echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done ;;',
      '  --hang) exec sleep 5 ;;',
      '  --gc-exit) sleep 20 & echo $! > "$D/gc-exit.pid"; echo done ;;',
      '  --gc-hang) sleep 20 & echo $! > "$D/gc-hang.pid"; wait ;;',
      '  --gc-flood) sleep 20 & echo $! > "$D/gc-flood.pid"; i=0; while [ $i -lt 5000 ]; do echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; wait ;;',
      '  *) exit 3 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);
  const scratch = (): string => {
    const dir = mkdtempSync(join(root, 'cwm-probe-'));
    chmodSync(dir, 0o700);
    return dir;
  };
  const limits = { timeoutMs: 3000, maxBytes: 4096 };
  const hangStub = join(root, 'hang-claude');
  writeFileSync(
    hangStub,
    '#!/bin/sh\necho "$*" >> "$(dirname "$0")/hang-calls.log"\nexec sleep 8\n',
  );
  chmodSync(hangStub, 0o755);
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidOf = (name: string): number => Number(readFileSync(join(root, name), 'utf8').trim());
  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40; i += 1) {
      if (!alive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  it('proces dostaje minimalne srodowisko i pusty katalog proby jako katalog roboczy', async () => {
    const dir = scratch();
    const previous = process.env['ACME_SECRET_TOKEN'];
    process.env['ACME_SECRET_TOKEN'] = 'sekret-nie-dla-silnika';
    try {
      const out = await runEngineMetadata(stub, ['--dump'], dir, limits, null);
      expect(out).not.toBeNull();
      expect(out).not.toMatch(/ACME_SECRET_TOKEN|sekret-nie-dla-silnika/);
      expect(out).toMatch(new RegExp(`CLAUDE_CONFIG_DIR=${dir}\\n`));
      expect(out?.trimEnd().split('\n').pop()).toMatch(/acme-engine-check-.*cwm-probe-/);
    } finally {
      if (previous === undefined) delete process.env['ACME_SECRET_TOKEN'];
      else process.env['ACME_SECRET_TOKEN'] = previous;
    }
  });

  it('kod wyjscia, przekroczenie rozmiaru i czasu to null', async () => {
    const dir = scratch();
    expect(await runEngineMetadata(stub, ['--version'], dir, limits, null)).toMatch(/^9\.9\.9/);
    expect(await runEngineMetadata(stub, ['plugin', '--help'], dir, limits, null)).toBeNull();
    expect(await runEngineMetadata(stub, ['--flood'], dir, limits, null)).toBeNull();
    expect(
      await runEngineMetadata(stub, ['--hang'], dir, { timeoutMs: 300, maxBytes: 4096 }, null),
    ).toBeNull();
  });

  it('proba dostaje wylaczone aktualizacje i ruch nieistotny', async () => {
    const out = await runEngineMetadata(stub, ['--dump'], scratch(), limits, null);
    expect(out).toMatch(/DISABLE_AUTOUPDATER=1\n/);
    expect(out).toMatch(/CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n/);
  });

  it.each([
    ['gc-exit', '--gc-exit', limits],
    ['gc-hang', '--gc-hang', { timeoutMs: 400, maxBytes: 4096 }],
    ['gc-flood', '--gc-flood', { timeoutMs: 3000, maxBytes: 2048 }],
  ])('zadne dziecko proby nie przezywa: %s (SEC-E5)', async (name, arg, probeLimits) => {
    const out = await runEngineMetadata(stub, [arg], scratch(), probeLimits, null);
    expect(arg === '--gc-exit' ? out : null).toBe(arg === '--gc-exit' ? 'done\n' : null);
    const pid = pidOf(`${name}.pid`);
    expect(await gone(pid)).toBe(true);
  });

  it('dwa przekroczenia czasu w jednym sprawdzeniu zatrzymuja reszte polecen (SEC-E4)', async () => {
    rmSync(join(root, 'hang-calls.log'), { force: true });
    const started = Date.now();
    const meta = await collectEngineMetadata(hangStub, scratch(), null, 250);
    expect(meta).toEqual({ version: null, help: null, pluginHelp: null, mcpHelp: null });
    expect(readFileSync(join(root, 'hang-calls.log'), 'utf8').trim().split('\n')).toEqual([
      '--version',
      '--help',
    ]);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('runEngineCheck: wersja z --version inna niz wykryta wczesniej to unverified bez wpisu (SEC-E7)', async () => {
    const parent = mkdtempSync(join(root, 'parent-'));
    const same = await runEngineCheck(stub, parent, { projectDir: null, expectedVersion: '9.9.9' });
    expect(same.report.verdict).toBe('ok');
    const other = await runEngineCheck(stub, parent, {
      projectDir: null,
      expectedVersion: '9.9.8',
    });
    expect(other.report.verdict).toBe('unverified');
    expect(other.entry).toBeNull();
  });

  it('wpis wiaze wynik z plikiem: sciezka, rozmiar i mtime (SEC-E2)', async () => {
    const parent = mkdtempSync(join(root, 'parent-'));
    const run = await runEngineCheck(stub, parent, { projectDir: null });
    const info = statSync(stub);
    expect(run.entry?.binary).toEqual({ path: stub, size: info.size, mtimeMs: info.mtimeMs });
  });

  it('runEngineCheck: ocena z czterech polecen, wpis ze skrotami i sprzatanie katalogu proby', async () => {
    const parent = mkdtempSync(join(root, 'parent-'));
    const run = await runEngineCheck(stub, parent, { projectDir: null });
    expect(run.report.verdict).toBe('ok');
    expect(run.report.version).toBe('9.9.9');
    expect(run.report.newSubcommands).toEqual(['newcmd']);
    expect(run.report.unavailable).toEqual(['plugin --help']);
    expect(run.entry?.helpSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.entry?.pluginHelpSha256).toBeNull();
    expect(run.entry?.mcpHelpSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('zapis wyniku w ~/.cwm/runtime: 0600, odczyt zwraca wpis, uszkodzony plik to pusty zbior', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    const layout = createLayout(home);
    expect((await readEngineChecks(layout)).state).toBe('missing');
    const run = await runEngineCheck(stub, mkdtempSync(join(root, 'parent-')), {
      projectDir: null,
    });
    if (run.entry === null) throw new Error('brak wpisu');
    const before = await readEngineChecks(layout);
    await recordEngineCheck(layout, before.file, '9.9.9', run.entry);
    const file = engineChecksFile(layout);
    expect(file).toBe(join(home, 'runtime', 'engine-checks.json'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'runtime')).mode & 0o777).toBe(0o700);
    const after = await readEngineChecks(layout);
    expect(after.state).toBe('ok');
    expect(after.file.checks['9.9.9']?.helpSha256).toBe(run.entry.helpSha256);

    writeFileSync(file, '{"apiVersion":"cwm.dev/v1"}');
    const broken = await readEngineChecks(layout);
    expect(broken.state).toBe('invalid');
    expect(Object.keys(broken.file.checks)).toEqual([]);
  });

  it('dowiazanie w miejscu pliku wynikow: odczyt to invalid, zapis odmowa i nic nie powstaje poza ~/.cwm', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    const layout = createLayout(home);
    mkdirSync(join(home, 'runtime'), { mode: 0o700 });
    const outside = join(root, 'outside.json');
    symlinkSync(outside, engineChecksFile(layout));
    expect((await readEngineChecks(layout)).state).toBe('invalid');
    const run = await runEngineCheck(stub, mkdtempSync(join(root, 'parent-')), {
      projectDir: null,
    });
    if (run.entry === null) throw new Error('brak wpisu');
    await expect(
      recordEngineCheck(layout, (await readEngineChecks(layout)).file, '9.9.9', run.entry),
    ).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });
});
