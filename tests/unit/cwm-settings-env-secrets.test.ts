import { describe, expect, it } from 'vitest';

import {
  analyzeContent,
  classifyEnvValue,
  convertNativeSettings,
  extractHookPathTokens,
  hasInlineCommands,
  mergeSettings,
  textHasSecret,
  type Settings,
  isSettingsEnvNameDenied,
  nameLooksSecret,
  validateResource,
  valueLooksSecret,
} from '../../src/core/cwm';

/**
 * Wartosci wygladajace na sekrety sa skladane z kawalkow, zeby zrodlo testu nie zawieralo ciagu,
 * ktory gitleaks w CI uznalby za prawdziwy klucz (jak w secret-classifier.test.ts).
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function filler(length: number, seed = 5): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += ALPHABET.charAt(state % ALPHABET.length);
  }
  return out;
}

const OPENAI_LIKE = ['s', 'k', '-', filler(30)].join('');
const ANTHROPIC_LIKE = ['sk', '-ant-', filler(30, 9)].join('');
const GITHUB_LIKE = ['gh', 'p_', filler(36, 11)].join('');
const GITLAB_LIKE = ['glp', 'at-', filler(20, 13)].join('');
const AWS_LIKE = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const SLACK_LIKE = ['xo', 'xb-', filler(20, 17)].join('');
const JWT_LIKE = ['ey', 'J', filler(12, 3), '.ey', 'J', filler(12, 4), '.', filler(12, 6)].join('');
const PEM_LIKE = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const URL_CREDS = ['https://acme', ':', filler(10, 21), '@example.test/repo'].join('');

function settingsManifest(env: Record<string, unknown>): unknown {
  return {
    apiVersion: 'cwm.dev/v1',
    kind: 'Settings',
    metadata: { id: 'acme-a/env-check', version: '1.0.0' },
    spec: { env },
  };
}

describe('nameLooksSecret (SET-04, nazwy)', () => {
  it.each([
    'ACME_TOKEN',
    'acme_secret',
    'ACME_API_KEY',
    'DB_PASSWORD',
    'DB_PASSWD',
    'SSH_PASSPHRASE',
    'ACME_CREDENTIALS',
    'ACME_AUTH_HEADER',
    'GITLAB_PAT',
    'ACME_PRIVATE_THING',
    'SENTRY_DSN',
    'ACME_COOKIE_JAR',
    'ACME_SESSION_ID',
  ])('rozpoznaje %s', (name) => {
    expect(nameLooksSecret(name)).toBe(true);
  });

  it('akceptuje falszywe trafienia (KEYBOARD_*), ktore koncza sie wymaganiem envRef', () => {
    expect(nameLooksSecret('KEYBOARD_LAYOUT')).toBe(true);
  });

  it.each(['ACME_REGION', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'BASH_DEFAULT_TIMEOUT_MS', 'ACME_MODE'])(
    'przepuszcza %s',
    (name) => {
      expect(nameLooksSecret(name)).toBe(false);
    },
  );
});

describe('valueLooksSecret (SET-04, wartosci)', () => {
  it.each([
    ['klucz z prefiksem sk-', OPENAI_LIKE],
    ['klucz sk-ant-', ANTHROPIC_LIKE],
    ['token ghp_', GITHUB_LIKE],
    ['token glpat-', GITLAB_LIKE],
    ['klucz AWS AKIA', AWS_LIKE],
    ['token xox', SLACK_LIKE],
    ['JWT', JWT_LIKE],
    ['blok PEM', PEM_LIKE],
    ['adres z haslem', URL_CREDS],
    ['klucz po slowie Bearer', `Bearer ${OPENAI_LIKE}`],
    ['dlugi ciag o wysokiej entropii', filler(48, 31)],
  ])('rozpoznaje: %s', (_label, value) => {
    expect(valueLooksSecret(value)).toBe(true);
  });

  it.each([
    '1',
    'true',
    '120000',
    'https://example.test/api',
    'acme-debug',
    '/usr/local/bin',
    'task-list',
  ])('przepuszcza zwykla wartosc: %s', (value) => {
    expect(valueLooksSecret(value)).toBe(false);
  });

  it('nazwa wygrywa nad wartoscia w werdykcie', () => {
    expect(classifyEnvValue('ACME_TOKEN', '1')).toBe('secret-name');
    expect(classifyEnvValue('ACME_REGION', OPENAI_LIKE)).toBe('secret-value');
    expect(classifyEnvValue('ACME_REGION', 'eu-west')).toBe('ok');
  });
});

describe('isSettingsEnvNameDenied (SET-04, zakazane nazwy)', () => {
  it.each([
    'PATH',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'HTTPS_PROXY',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_TMPDIR',
    'CLAUDE_CODE_PLUGIN_CACHE_DIR',
    'CLAUDE_CODE_SHELL_PREFIX',
    'CLAUDE_CODE_SHELL',
    'CLAUDE_CODE_GIT_BASH_PATH',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ACME_PROVIDER_BASE_URL',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_LOGS_HEADERS',
  ])('zabrania %s', (name) => {
    expect(isSettingsEnvNameDenied(name)).toBe(true);
  });

  it.each(['ANTHROPIC_MODEL', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_SERVICE_NAME', 'ACME_REGION'])(
    'dopuszcza %s',
    (name) => {
      expect(isSettingsEnvNameDenied(name)).toBe(false);
    },
  );
});

describe('walidator Settings.env', () => {
  it('przyjmuje envRef oraz value niebedace sekretem', () => {
    const result = validateResource(
      settingsManifest({
        ACME_REGION: { value: 'eu-west' },
        ACME_TOKEN: { envRef: 'ACME_TOKEN' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('odrzuca value pod nazwa sekretu, nie cytujac wartosci', () => {
    const result = validateResource(settingsManifest({ ACME_TOKEN: { value: 'plain-1' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path)).toEqual(['spec.env.ACME_TOKEN.value']);
      expect(JSON.stringify(result.errors)).not.toContain('plain-1');
    }
  });

  it('odrzuca value wygladajace na sekret pod niewinna nazwa, nie cytujac wartosci', () => {
    const result = validateResource(settingsManifest({ ACME_REGION: { value: OPENAI_LIKE } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path)).toEqual(['spec.env.ACME_REGION.value']);
      expect(JSON.stringify(result.errors)).not.toContain(OPENAI_LIKE);
    }
  });

  it('odrzuca zakazane nazwy, zapis tekstem i obie formy naraz', () => {
    const result = validateResource(
      settingsManifest({
        ANTHROPIC_BASE_URL: { value: 'https://proxy.example.test' },
        ACME_REGION: 'eu-west',
        ACME_MODE: { value: 'fast', envRef: 'ACME_MODE' },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path)).toEqual([
        'spec.env.ACME_MODE',
        'spec.env.ACME_REGION',
        'spec.env.ANTHROPIC_BASE_URL',
      ]);
    }
  });

  it('odrzuca klucze prototypu w env', () => {
    const env = JSON.parse('{"__proto__": {"value": "x"}}') as Record<string, unknown>;
    const result = validateResource(settingsManifest(env));
    expect(result.ok).toBe(false);
  });
});

describe('convertNativeSettings (IMP-07, env)', () => {
  it('daje envRef dla sekretow i value dla reszty, bez wartosci w raporcie', () => {
    const result = convertNativeSettings({
      env: {
        ACME_TOKEN: 'hunter2-hunter2',
        ACME_REGION: OPENAI_LIKE,
        ACME_MODE: 'fast',
        ANTHROPIC_BASE_URL: 'https://proxy.example.test',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spec['env']).toEqual({
      ACME_TOKEN: { envRef: 'ACME_TOKEN' },
      ACME_REGION: { envRef: 'ACME_REGION' },
      ACME_MODE: { value: 'fast' },
    });
    expect([...result.value.envRefs].sort()).toEqual(['ACME_REGION', 'ACME_TOKEN']);
    const report = JSON.stringify(result.value.skipped);
    expect(report).toContain('ANTHROPIC_BASE_URL');
    expect(report).not.toContain('proxy.example.test');
    expect(report).not.toContain(OPENAI_LIKE);
  });
});

describe('rozszerzenia po przegladzie (SEC-002, SEC-004, SEC-005, SEC-006)', () => {
  it.each([
    'DB_PASS',
    'ACME_PWD',
    'DB_PW',
    'ACME_CRED',
    'ACME_BEARER',
    'SLACK_WEBHOOK',
    'ACME_SIGNING',
    'ACME_SIGNATURE',
    'ACME_CERT',
  ])('nazwa %s wymaga envRef', (name) => {
    expect(nameLooksSecret(name)).toBe(true);
  });

  it('PW tylko jako caly segment', () => {
    expect(nameLooksSecret('ACME_PWR_MODE')).toBe(false);
  });

  it.each([
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'CLAUDE_ENV_FILE',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'EDITOR',
    'VISUAL',
    'PAGER',
    'GIT_PAGER',
    'GIT_EXTERNAL_DIFF',
    'GIT_CONFIG_COUNT',
    'GIT_SSH',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'ZDOTDIR',
    'PROMPT_COMMAND',
    'LESSOPEN',
    'BROWSER',
  ])('zabrania %s', (name) => {
    expect(isSettingsEnvNameDenied(name)).toBe(true);
  });

  it('rozpoznaje adres z haslem zakodowanym procentowo i przypisania sekretu', () => {
    expect(valueLooksSecret('https://acme:p%40ss%3Aword@example.test/x')).toBe(true);
    expect(valueLooksSecret('--password=abcd')).toBe(true);
    expect(valueLooksSecret('token: abcd')).toBe(true);
    expect(valueLooksSecret('api_key=xyz12')).toBe(true);
  });

  it('textHasSecret nie trafia w zwykle polecenie z cyfra', () => {
    expect(textHasSecret('node /opt/acme/hook2.js --strict')).toBe(false);
    expect(textHasSecret(`curl -H "Authorization: Bearer ${OPENAI_LIKE}" x`)).toBe(true);
  });

  it('sekret w poleceniu hooka lub regule uprawnien: walidator odrzuca bez cytowania', () => {
    const doc = {
      apiVersion: 'cwm.dev/v1',
      kind: 'Settings',
      metadata: { id: 'acme-a/s', version: '1.0.0' },
      spec: {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: `run --token=${OPENAI_LIKE}` }] }] },
        permissions: { allow: [`Bash(curl:${GITHUB_LIKE})`] },
      },
    };
    const result = validateResource(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.errors)).not.toContain(OPENAI_LIKE);
      expect(JSON.stringify(result.errors)).not.toContain(GITHUB_LIKE);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('import: sekret w hooku oznacza pominiecie calego zasobu (secretPaths)', () => {
    const result = convertNativeSettings({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `run --token=${OPENAI_LIKE}` }] }] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.secretPaths.length).toBe(1);
      expect(JSON.stringify(result.value)).not.toContain(OPENAI_LIKE);
    }
  });

  it('frontmatter: warianty zapisu zabronionych kluczy odrzucaja zasob, a allowed_tools ustawia flage', () => {
    for (const key of ['Hooks', 'MCP_servers', 'permission-mode', 'permission_Mode']) {
      expect(analyzeContent('skill', { [key]: 1 }, 'x').ok).toBe(false);
    }
    const result = analyzeContent('skill', { name: 'a', allowed_tools: 'Read' }, 'x');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.flags.allowedTools).toBe(true);
      expect(Object.keys(result.value.kept)).toEqual(['name']);
    }
  });

  it('wstawki: ogrodzenia 3+ odwrotnych apostrofow lub tyld z wykrzyknikiem', () => {
    expect(hasInlineCommands('```!\nls\n```')).toBe(true);
    expect(hasInlineCommands('````!\nls')).toBe(true);
    expect(hasInlineCommands('~~~!\nls')).toBe(true);
    expect(hasInlineCommands('```sh\nls\n```')).toBe(false);
  });

  it('sciezki hookow: cudzyslow najpierw, sciezki bez kotwicy to variable', () => {
    const { tokens } = extractHookPathTokens(
      'sh "$HOME"/hooks/a.sh ./b.sh hooks/c.sh $X/d.sh /opt/e.sh',
    );
    const byRaw = Object.fromEntries(tokens.map((t) => [t.raw, t.base]));
    expect(byRaw['$HOME/hooks/a.sh']).toBe('home');
    expect(byRaw['./b.sh']).toBe('variable');
    expect(byRaw['hooks/c.sh']).toBe('variable');
    expect(byRaw['$X/d.sh']).toBe('variable');
    expect(byRaw['/opt/e.sh']).toBe('absolute');
  });

  it('nadmiar sciezek jest liczony, nie gubiony', () => {
    const command = Array.from({ length: 40 }, (_, i) => `/opt/s${i}.sh`).join(' ');
    const scan = extractHookPathTokens(command);
    expect(scan.tokens.length).toBe(32);
    expect(scan.dropped).toBe(8);
  });

  it('scalanie: env i defaultMode w enforce true i false musza sie zgadzac', () => {
    const make = (id: string, enforce: boolean, value: string, mode: string): Settings => ({
      kind: 'settings',
      id,
      version: '1.0.0',
      hooks: {},
      permissions: { allow: [], deny: [], ask: [], defaultMode: mode, additionalDirectories: [] },
      env: { ACME_MODE: { value } },
      enforce,
    });
    const conflict = mergeSettings([
      { resource: make('acme-a/a', false, 'x', 'plan'), layer: 'global' },
      { resource: make('acme-a/b', true, 'y', 'default'), layer: 'company' },
    ]);
    expect(conflict.errors.length).toBe(2);
    const same = mergeSettings([
      { resource: make('acme-a/a', false, 'x', 'plan'), layer: 'global' },
      { resource: make('acme-a/b', true, 'x', 'plan'), layer: 'company' },
    ]);
    expect(same.errors.length).toBe(0);
  });
});
