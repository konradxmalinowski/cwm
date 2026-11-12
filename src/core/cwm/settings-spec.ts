import {
  Checker,
  childPath,
  CONTROL_CHARS,
  field,
  isPlainObject,
  MAX_LIST_ITEMS,
  type PlainObject,
} from './check';
import {
  classifyEnvValue,
  ENV_NAME_PATTERN,
  isSettingsEnvNameDenied,
  textHasSecret,
} from './env-policy';
import { FORBIDDEN_KEYS, nullObject } from './safe-keys';
import type {
  HookCommand,
  HookGroup,
  Settings,
  SettingsAttribution,
  SettingsEnvEntry,
  SettingsPermissions,
  SettingsPreferences,
} from './resource';

export const SETTINGS_SPEC_FIELDS = [
  'hooks',
  'permissions',
  'env',
  'enforce',
  'attribution',
  'preferences',
] as const;

/**
 * Klucze natywnego `settings.json`, ktore uruchamiaja polecenia albo zmieniaja zrodla pluginow
 * (IMP-06). Walidator odrzuca je tez w recznie wpisanym manifescie, nie tylko przy imporcie.
 */
export const SETTINGS_REJECTED_KEYS = [
  'apiKeyHelper',
  'statusLine',
  'otelHeadersHelper',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'awsAuthRefresh',
  'awsCredentialExport',
  'fileSuggestion',
  'skipDangerousModePermissionPrompt',
] as const;

/** Wartosci `permissions.defaultMode` znane silnikowi (`claude --help`, 2.1.322, plus `default`). */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'manual',
  'plan',
] as const;

/**
 * Klucze natywnego `settings.json` przyjmowane jako preferencje (nie wykonuja kodu). Teksty to
 * krotkie nazwy trybow, `voice` ma tylko `enabled` i `mode`.
 */
export const PREFERENCE_TEXT_KEYS = ['theme', 'tui', 'preferredNotifChannel'] as const;
export const PREFERENCE_FLAG_KEYS = ['voiceEnabled', 'enableWorkflows'] as const;
export const PREFERENCE_KEYS = [...PREFERENCE_TEXT_KEYS, ...PREFERENCE_FLAG_KEYS, 'voice'] as const;
export const VOICE_KEYS = ['enabled', 'mode'] as const;
export const ATTRIBUTION_KEYS = ['commit', 'pr'] as const;
export const PREFERENCE_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const MAX_ATTRIBUTION_LENGTH = 2048;
const ATTRIBUTION_CONTROL = /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]/u;

/** Tekst attribution: do 2048 znakow, nowa linia i tabulator dozwolone, bez sekretu. Pusty tekst wylacza dopisek. */
export function attributionProblem(text: string): string | null {
  if (text.length > MAX_ATTRIBUTION_LENGTH) {
    return `Tekst moze miec najwyzej ${MAX_ATTRIBUTION_LENGTH} znakow.`;
  }
  if (ATTRIBUTION_CONTROL.test(text)) return 'Tekst zawiera znaki sterujace lub formatujace.';
  if (textHasSecret(text))
    return 'Tekst wyglada na zawierajacy sekret (wartosc nie jest cytowana).';
  return null;
}

export const MAX_HOOK_COMMAND_LENGTH = 4096;
export const MIN_HOOK_TIMEOUT = 1;
export const MAX_HOOK_TIMEOUT = 600;
const MAX_EVENTS = 64;
export const EVENT_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UNSUPPORTED_HOOK_TYPES = ['http', 'prompt', 'agent'];

/** Zglasza klucze z `SETTINGS_REJECTED_KEYS` z wlasnym komunikatem, zanim ogolny walidator powie "nieznane". */
export function rejectSettingsKeys(c: Checker, spec: PlainObject, base: string): void {
  for (const key of SETTINGS_REJECTED_KEYS) {
    if (Object.hasOwn(spec, key)) {
      c.add(
        childPath(base, key),
        'Ten klucz uruchamia polecenia, zmienia zrodla pluginow albo wylacza ostrzezenie bezpieczenstwa i jest zabroniony w Settings.',
      );
    }
  }
}

/** Polecenie hooka: do 4096 znakow, bez znakow sterujacych i formatujacych (Cc, Cf). */
export function hookCommandProblem(command: string): string | null {
  if (command.length === 0) return 'Polecenie hooka jest puste.';
  if (command.length > MAX_HOOK_COMMAND_LENGTH) {
    return `Polecenie hooka moze miec najwyzej ${MAX_HOOK_COMMAND_LENGTH} znakow.`;
  }
  if (CONTROL_CHARS.test(command)) {
    return 'Polecenie hooka nie moze zawierac znakow sterujacych ani formatujacych (takze nowej linii).';
  }
  if (textHasSecret(command)) {
    return 'Polecenie hooka wyglada na zawierajace sekret. Przekaz go przez envRef w env, nie w poleceniu.';
  }
  return null;
}

function readHook(c: Checker, element: unknown, path: string): HookCommand | null {
  const obj = c.object(element, path, ['type', 'command', 'timeout'], ['type', 'command']);
  if (!obj) return null;
  const typePath = childPath(path, 'type');
  const type = field(obj, 'type');
  if (typeof type === 'string' && UNSUPPORTED_HOOK_TYPES.includes(type)) {
    c.add(
      typePath,
      `Typ hooka "${type}" jest zabroniony: dozwolony jest tylko "command" (hook http wysyla zdarzenia sesji pod wskazany adres).`,
    );
  } else {
    c.oneOf(type, typePath, ['command']);
  }
  const commandPath = childPath(path, 'command');
  const commandValue = field(obj, 'command');
  let command: string | null = null;
  if (typeof commandValue !== 'string') c.add(commandPath, 'Oczekiwano tekstu.');
  else {
    const problem = hookCommandProblem(commandValue);
    if (problem === null) command = commandValue;
    else c.add(commandPath, problem);
  }
  const timeoutValue = field(obj, 'timeout');
  const timeout =
    timeoutValue === undefined
      ? null
      : c.integer(timeoutValue, childPath(path, 'timeout'), MIN_HOOK_TIMEOUT, MAX_HOOK_TIMEOUT);
  if (type !== 'command' || command === null) return null;
  return { type: 'command', command, ...(timeout === null ? {} : { timeout }) };
}

function readHookGroup(c: Checker, element: unknown, path: string): HookGroup | null {
  const obj = c.object(element, path, ['matcher', 'hooks'], ['hooks']);
  if (!obj) return null;
  const matcherValue = field(obj, 'matcher');
  const matcher =
    matcherValue === undefined ? null : c.string(matcherValue, childPath(path, 'matcher'));
  let index = 0;
  const hooks = c.list(
    field(obj, 'hooks'),
    childPath(path, 'hooks'),
    (el, p) => readHook(c, el, p),
    () => String(index++),
  );
  const rawHooks = field(obj, 'hooks');
  if (hooks.length === 0 && Array.isArray(rawHooks) && rawHooks.length === 0) {
    c.add(childPath(path, 'hooks'), 'Grupa wymaga co najmniej jednego hooka.');
  }
  return hooks.length === 0 ? null : { ...(matcher === null ? {} : { matcher }), hooks };
}

function readHooks(c: Checker, value: unknown): Record<string, HookGroup[]> {
  const result = nullObject<HookGroup[]>();
  if (value === undefined) return result;
  if (!isPlainObject(value)) {
    c.add('spec.hooks', 'Oczekiwano obiektu.');
    return result;
  }
  const events = Object.keys(value);
  if (events.length > MAX_EVENTS) {
    c.add('spec.hooks', `Najwyzej ${MAX_EVENTS} zdarzen.`);
    return result;
  }
  for (const event of events) {
    const path = childPath('spec.hooks', event);
    if (FORBIDDEN_KEYS.has(event)) {
      c.add(path, 'Zabroniony klucz.');
      continue;
    }
    if (!EVENT_PATTERN.test(event)) {
      c.add(path, 'Nazwa zdarzenia ma miec zapis jak PreToolUse (litery, cyfry, _).');
      continue;
    }
    let index = 0;
    const groups = c.list(
      field(value, event),
      path,
      (el, p) => readHookGroup(c, el, p),
      () => String(index++),
    );
    if (groups.length > 0) result[event] = groups;
  }
  return result;
}

function readStringList(c: Checker, value: unknown, path: string, secrets = false): string[] {
  return c.list(value, path, (el, p) => {
    const text = c.string(el, p);
    if (text !== null && secrets && textHasSecret(text)) {
      c.add(p, 'Regula wyglada na zawierajaca sekret (wartosc nie jest cytowana).');
      return null;
    }
    return text;
  });
}

function readPermissions(c: Checker, value: unknown): SettingsPermissions {
  const obj =
    value === undefined
      ? {}
      : (c.object(value, 'spec.permissions', [
          'allow',
          'deny',
          'ask',
          'defaultMode',
          'additionalDirectories',
        ]) ?? {});
  const mode = field(obj, 'defaultMode');
  const defaultMode =
    mode === undefined ? null : c.oneOf(mode, 'spec.permissions.defaultMode', PERMISSION_MODES);
  return {
    allow: readStringList(c, field(obj, 'allow'), 'spec.permissions.allow', true),
    deny: readStringList(c, field(obj, 'deny'), 'spec.permissions.deny', true),
    ask: readStringList(c, field(obj, 'ask'), 'spec.permissions.ask', true),
    ...(defaultMode === null ? {} : { defaultMode }),
    additionalDirectories: readStringList(
      c,
      field(obj, 'additionalDirectories'),
      'spec.permissions.additionalDirectories',
    ),
  };
}

function readEnvEntry(
  c: Checker,
  name: string,
  entry: unknown,
  path: string,
): SettingsEnvEntry | null {
  if (typeof entry === 'string') {
    c.add(path, 'Uzyj { value: ... } albo { envRef: ... }, nie samego tekstu.');
    return null;
  }
  const obj = c.object(entry, path, ['envRef', 'value']);
  if (!obj) return null;
  const hasRef = Object.hasOwn(obj, 'envRef');
  const hasValue = Object.hasOwn(obj, 'value');
  if (hasRef === hasValue) {
    c.add(path, 'Podaj dokladnie jedno z pol: envRef albo value.');
    return null;
  }
  if (hasRef) {
    const envRef = c.string(field(obj, 'envRef'), childPath(path, 'envRef'), ENV_NAME_PATTERN);
    return envRef === null ? null : { envRef };
  }
  const valuePath = childPath(path, 'value');
  const value = c.string(field(obj, 'value'), valuePath);
  if (value === null) return null;
  // Komunikaty nie cytuja wartosci (zasada z validatePolicy).
  switch (classifyEnvValue(name, value)) {
    case 'secret-name':
      c.add(
        valuePath,
        'Nazwa zmiennej wyglada na sekret. Uzyj envRef z nazwa zmiennej srodowiskowej.',
      );
      return null;
    case 'secret-value':
      c.add(valuePath, 'Wartosc wyglada na sekret. Uzyj envRef z nazwa zmiennej srodowiskowej.');
      return null;
    case 'ok':
      return { value };
  }
}

function readEnv(c: Checker, value: unknown): Record<string, SettingsEnvEntry> {
  const env = nullObject<SettingsEnvEntry>();
  if (value === undefined) return env;
  if (!isPlainObject(value)) {
    c.add('spec.env', 'Oczekiwano obiektu.');
    return env;
  }
  const names = Object.keys(value);
  if (names.length > MAX_LIST_ITEMS) {
    c.add('spec.env', `Najwyzej ${MAX_LIST_ITEMS} zmiennych.`);
    return env;
  }
  for (const name of names) {
    const path = childPath('spec.env', name);
    if (FORBIDDEN_KEYS.has(name)) {
      c.add(path, 'Zabroniony klucz.');
    } else if (!ENV_NAME_PATTERN.test(name)) {
      c.add(path, 'Nazwa zmiennej ma miec zapis WIELKIMI_LITERAMI.');
    } else if (isSettingsEnvNameDenied(name)) {
      c.add(
        path,
        'Ta zmienna zmienia uruchamianie procesu, sterowanie silnikiem lub ruch sieciowy i jest zabroniona.',
      );
    } else {
      const entry = readEnvEntry(c, name, field(value, name), path);
      if (entry !== null) env[name] = entry;
    }
  }
  return env;
}

function readAttribution(c: Checker, value: unknown): SettingsAttribution | null {
  if (value === undefined) return null;
  const obj = c.object(value, 'spec.attribution', ATTRIBUTION_KEYS);
  if (!obj) return null;
  const out: { commit?: string; pr?: string } = {};
  for (const key of ATTRIBUTION_KEYS) {
    const raw = field(obj, key);
    if (raw === undefined) continue;
    const path = childPath('spec.attribution', key);
    if (typeof raw !== 'string') c.add(path, 'Oczekiwano tekstu.');
    else {
      const problem = attributionProblem(raw);
      if (problem === null) out[key] = raw;
      else c.add(path, problem);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function preferenceText(c: Checker, value: unknown, path: string): string | null {
  return c.string(value, path, PREFERENCE_TEXT, 'krotka nazwa (litery, cyfry, _ . : -)');
}

function readVoice(c: Checker, value: unknown): { enabled?: boolean; mode?: string } | null {
  const obj = c.object(value, 'spec.preferences.voice', VOICE_KEYS);
  if (!obj) return null;
  const out: { enabled?: boolean; mode?: string } = {};
  const enabled = field(obj, 'enabled');
  if (enabled !== undefined) {
    const flag = c.boolean(enabled, 'spec.preferences.voice.enabled');
    if (flag !== null) out.enabled = flag;
  }
  const mode = field(obj, 'mode');
  if (mode !== undefined) {
    const text = preferenceText(c, mode, 'spec.preferences.voice.mode');
    if (text !== null) out.mode = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readPreferences(c: Checker, value: unknown): SettingsPreferences | null {
  if (value === undefined) return null;
  const obj = c.object(value, 'spec.preferences', PREFERENCE_KEYS);
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const key of PREFERENCE_TEXT_KEYS) {
    const raw = field(obj, key);
    if (raw === undefined) continue;
    const text = preferenceText(c, raw, childPath('spec.preferences', key));
    if (text !== null) out[key] = text;
  }
  for (const key of PREFERENCE_FLAG_KEYS) {
    const raw = field(obj, key);
    if (raw === undefined) continue;
    const flag = c.boolean(raw, childPath('spec.preferences', key));
    if (flag !== null) out[key] = flag;
  }
  const voiceValue = field(obj, 'voice');
  if (voiceValue !== undefined) {
    const voice = readVoice(c, voiceValue);
    if (voice !== null) out['voice'] = voice;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function readSettings(c: Checker, spec: PlainObject, id: string, version: string): Settings {
  const enforceValue = field(spec, 'enforce');
  const attribution = readAttribution(c, field(spec, 'attribution'));
  const preferences = readPreferences(c, field(spec, 'preferences'));
  return {
    kind: 'settings',
    id,
    version,
    hooks: readHooks(c, field(spec, 'hooks')),
    permissions: readPermissions(c, field(spec, 'permissions')),
    env: readEnv(c, field(spec, 'env')),
    enforce:
      enforceValue === undefined ? false : (c.boolean(enforceValue, 'spec.enforce') ?? false),
    ...(attribution === null ? {} : { attribution }),
    ...(preferences === null ? {} : { preferences }),
  };
}
