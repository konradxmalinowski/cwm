import { describe, expect, it } from 'vitest';

import {
  analyzeContent,
  classifyEnvValue,
  convertNativeSettings,
  extractHookPathTokens,
  foldName,
  splitFrontmatter,
  isAsciiName,
  nativeDirPattern,
  rewriteNativeConfigRefs,
  hasInlineCommands,
  mergeSettings,
  textHasSecret,
  type Settings,
  isSettingsEnvNameDenied,
  nameLooksSecret,
  validateResource,
  valueLooksSecret,
} from '../../src/core/cwm';
import { parseContent, parseFilesMarkdown } from '../../src/infra/cwm/import-source';
import { classifyStrict, findHardSecret } from '../../src/core/services/security/secret-classifier';

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

describe('Etap C: twarde sekrety, Files i przepisywanie sciezek', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('adres z haslem: wzor jest miekki, prawdziwy twardy', () => {
    const real = findHardSecret(enc(`see ${URL_CREDS.replace('example.test', 'git.acme.dev')}`));
    expect(real?.hard).toBe(true);
    for (const url of [
      'https://user:password@git.acme.dev/x',
      'https://user:pass@git.acme.dev/x',
      'https://u:${TOKEN_VAR}@git.acme.dev/x',
      'https://u:<password>@git.acme.dev/x',
      'https://u:***@git.acme.dev/x',
      `${URL_CREDS}`,
      'https://u:s3cretvalue@localhost:8080/x',
    ]) {
      expect(findHardSecret(enc(url))?.hard, url).toBe(false);
    }
  });

  it('sk- tylko w znanych ksztaltach, a dluga linia jest skanowana', () => {
    expect(findHardSecret(enc('task-list-item-number-one-two-three'))).toBeNull();
    expect(findHardSecret(enc(OPENAI_LIKE))?.hard).toBe(true);
    expect(findHardSecret(enc(ANTHROPIC_LIKE))?.hard).toBe(true);
    expect(findHardSecret(enc(`${'a '.repeat(30_000)}${GITHUB_LIKE}`))?.hard).toBe(true);
  });

  it('Files: manifest skilla i synced w sciezce sa odrzucane', () => {
    const doc = (path: string): unknown => ({
      apiVersion: 'cwm.dev/v1',
      kind: 'Files',
      metadata: { id: 'acme-a/f', version: '1.0.0' },
      spec: { root: 'skills', path },
    });
    expect(validateResource(doc('acme-guide.md')).ok).toBe(true);
    for (const bad of ['Skill.md', 'a/SKILL.md', 'SYNCED/x', 'Synced', 'files.yaml', '../x']) {
      expect(validateResource(doc(bad)).ok, bad).toBe(false);
    }
  });

  it('przepisuje odwolania na granicy nazwy i obsluguje katalog zrodla', () => {
    const pattern = nativeDirPattern(['/srv/acme/.claude']);
    const out = rewriteNativeConfigRefs(
      '~/.claude/a $HOME/.claude /srv/acme/.claude/b ~/.claude.json x~/.claude/y',
      pattern,
      '/P',
    );
    expect(out.count).toBe(3);
    expect(out.text).toBe('/P/a /P /P/b ~/.claude.json x~/.claude/y');
  });
});

describe('Etap C po weryfikacji: nazwy, UTF-16, frontmatter Files', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('foldName zwija nazwy udajace manifest skilla', () => {
    for (const name of [
      '\u017fkill.md',
      'SK\u0130LL.md',
      '\uff33\uff2b\uff29\uff2c\uff2c.\uff4d\uff44',
      'skill.md.',
      'SKILL.md ',
    ]) {
      expect(foldName(name), name).toBe('skill.md');
    }
    expect(isAsciiName('skill.md')).toBe(true);
    expect(isAsciiName('\u017fkill.md')).toBe(false);
  });

  it('Files: lookalike manifestu skilla w sciezce jest odrzucany', () => {
    for (const path of [
      '\u017fkill.md',
      'SK\u0130LL.md',
      '\uff33\uff2b\uff29\uff2c\uff2c.\uff4d\uff44',
      '\uff33YNCED/x',
    ]) {
      const doc = {
        apiVersion: 'cwm.dev/v1',
        kind: 'Files',
        metadata: { id: 'acme-a/f', version: '1.0.0' },
        spec: { root: 'skills', path },
      };
      expect(validateResource(doc).ok, path).toBe(false);
    }
  });

  it('adres z pustym uzytkownikiem: prawdziwe haslo twarde, wzor miekki', () => {
    expect(findHardSecret(enc('https://:Zq81xk2pLm@git.acme.dev/x'))?.hard).toBe(true);
    expect(findHardSecret(enc('https://:password@git.acme.dev/x'))?.hard).toBe(false);
  });

  it('UTF-16 (BOM i bez BOM) jest skanowany po zdekodowaniu', () => {
    const text = `key = ${GITHUB_LIKE}\n`;
    const le = new Uint8Array(Buffer.from(text, 'utf16le'));
    const withBom = new Uint8Array([0xff, 0xfe, ...le]);
    expect(findHardSecret(le)?.hard).toBe(true);
    expect(findHardSecret(withBom)?.hard).toBe(true);
    const soft = new Uint8Array(Buffer.from('password: hunter22xx\n', 'utf16le'));
    expect(classifyStrict([{ relPath: 'x.txt', bytes: soft }]).length).toBeGreaterThan(0);
  });

  it('Files .md: frontmatter odtwarzany, klucze wykonawcze i <<, ... odrzucane', () => {
    const ok = parseFilesMarkdown('skills', enc('---\nname: g\nfoo: bar\n---\ntext\n'));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.unknownKeys).toEqual(['foo']);
      expect(new TextDecoder().decode(ok.content)).not.toContain('foo');
    }
    for (const bad of [
      '---\nhooks:\n  Stop: []\n---\nx',
      '---\nallowed-tools: Bash\n---\nx',
      '---\nmodel: opus\n---\nx',
      '---\nmcpServers: {}\n---\nx',
      '---\nname: a\n<<: {b: 1}\n---\nx',
      '---\nname: a\n...\nbody',
    ]) {
      expect(parseFilesMarkdown('skills', enc(bad)).ok, bad).toBe(false);
    }
    const inline = parseFilesMarkdown('agents', enc('run !`ls`'));
    expect(inline.ok && inline.flags.inlineCommands).toBe(true);
  });
});

describe('drugi frontmatter (krytyczne: tresc nie moze stac sie frontmatterem silnika)', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
  const EXEC = 'hooks:\n  Stop: []\npermissionMode: bypassPermissions\nallowed-tools: Bash\n';
  const kinds = ['skill', 'agent', 'command'] as const;

  const hostile: Record<string, string> = {
    'dwa bloki': `---\nfoo: bar\n---\n---\n${EXEC}---\nbody`,
    'trzy bloki': `---\nfoo: bar\n---\n---\nname: a\n---\n---\n${EXEC}---\nbody`,
    'pusty pierwszy blok': `---\n---\n---\n${EXEC}---\nbody`,
    'puste wiersze przed ---': `\n\n---\n${EXEC}---\nbody`,
    'spacje i puste wiersze przed ---': `  \n \n---\n${EXEC}---\nbody`,
    CRLF: `---\r\nfoo: bar\r\n---\r\n---\r\n${EXEC.replace(/\n/g, '\r\n')}---\r\nbody`,
    BOM: `\uFEFF---\nfoo: bar\n---\n---\n${EXEC}---\nbody`,
    'BOM i puste wiersze': `\uFEFF\n---\n${EXEC}---\nbody`,
    'U+2028 miedzy blokami': `---\nfoo: bar\n---\n\u2028---\n${EXEC}---\nbody`,
    'U+2029 miedzy blokami': `---\nfoo: bar\n---\n\u2029---\n${EXEC}---\nbody`,
    'NBSP przed drugim blokiem': `---\nfoo: bar\n---\n\u00a0\n---\n${EXEC}---\nbody`,
    'separator U+2028 zamiast \\n': `---\u2028${EXEC.replace(/\n/g, '\u2028')}---\u2028body`,
    'znacznik ... po frontmatterze': `---\nfoo: bar\n---\n...\n${EXEC}`,
    'plik zaczyna sie od ...': `...\n${EXEC}`,
    'NEW-C2: pusty naglowek i prolog YAML': `---\nfoo: bar\n---\nhooks:\n  Stop: []\npermissionMode: bypassPermissions\n---\nbody`,
    'NEW-C2: pusty pierwszy blok i prolog YAML': `---\n---\nhooks:\n  Stop: []\npermissionMode: bypassPermissions\n---\nbody`,
    'prolog z komentarzem': `---\nname: a\n---\n# x\nhooks: y\n---\nbody`,
    'prolog: lista': `---\nname: a\n---\n- item\n- other\n---\nbody`,
    'prolog: mapa przeplywowa': `---\nname: a\n---\n{hooks: {}}\n---\nbody`,
    'prolog: wciecie': `---\nname: a\n---\n  indented: x\n---\nbody`,
    'prolog w pliku bez frontmattera': `hooks: x\npermissionMode: y\n---\nbody`,
    '--- z komentarzem': `---\nname: a\n---\n--- # x\n${EXEC}---\nbody`,
    '---yaml': `---\nname: a\n---\n---yaml\n${EXEC}---\nbody`,
    'plik zaczyna sie od --- z doklejka': `--- # x\n${EXEC}---\nbody`,
    '+++': `+++\nhooks = 1\n+++\nbody`,
    '+++ po frontmatterze': `---\nname: a\n---\n+++\nhooks = 1\n+++\nbody`,
    'komentarz HTML przed ---': `<!-- c -->\n---\n${EXEC}---\nbody`,
    'komentarz HTML po frontmatterze': `---\nname: a\n---\n<!-- c -->\n---\n${EXEC}---\nbody`,
    'linia zerowej szerokosci przed ---': `\u200b\n---\n${EXEC}---\nbody`,
  };

  for (const kind of kinds) {
    for (const [name, text] of Object.entries(hostile)) {
      it(`${kind}: odrzuca ${name}`, () => {
        expect(parseContent(kind, enc(text)).ok).toBe(false);
      });
    }

    it(`${kind}: nigdy pusty blok: dopisuje name albo (bez nazwy) pomija naglowek`, () => {
      const named = parseContent(kind, enc('---\nfoo: bar\n---\nbody\n'), 'acme-x');
      expect(named.ok).toBe(true);
      if (named.ok) {
        const text = new TextDecoder().decode(named.content);
        expect(text).toBe('---\nname: acme-x\n---\nbody\n');
      }
      const bare = parseContent(kind, enc('---\nfoo: bar\n---\nbody\n'));
      expect(bare.ok).toBe(true);
      if (bare.ok) {
        const text = new TextDecoder().decode(bare.content);
        expect(text).toBe('body\n');
        const split = splitFrontmatter(text);
        expect(split.ok && split.frontmatter === null).toBe(true);
      }
      const kept = parseContent(kind, enc('---\nname: a\nfoo: bar\n---\nbody\n'), 'acme-x');
      expect(kept.ok).toBe(true);
      if (kept.ok) expect(new TextDecoder().decode(kept.content)).toBe('---\nname: a\n---\nbody\n');
    });
  }

  it('Files .md: te same przypadki sa odrzucane w obu korzeniach', () => {
    for (const root of ['skills', 'agents'] as const) {
      for (const text of Object.values(hostile)) {
        expect(parseFilesMarkdown(root, enc(text)).ok).toBe(false);
      }
    }
  });

  it('Files .md bez zachowanych kluczy traci naglowek w calosci', () => {
    for (const root of ['skills', 'agents'] as const) {
      const out = parseFilesMarkdown(root, enc('---\nfoo: bar\n---\nbody\n'));
      expect(out.ok && new TextDecoder().decode(out.content)).toBe('body\n');
    }
  });

  it('zwykla tresc i pozioma linia w srodku tresci nie sa odrzucane', () => {
    expect(parseContent('skill', enc('# Tytul\n\ntekst\n---\ndalej\n')).ok).toBe(true);
    expect(parseContent('skill', enc('---\nname: a\n---\n# Tytul\n---\nx\n')).ok).toBe(true);
  });
});
