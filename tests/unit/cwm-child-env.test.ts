import { describe, expect, it } from 'vitest';

import {
  buildChildEnv,
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
