import {
  childPath,
  CONTROL_CHARS,
  isPlainObject,
  MAX_LIST_ITEMS,
  MAX_STRING_LENGTH,
} from './check';
import {
  classifyEnvValue,
  ENV_NAME_PATTERN,
  isSettingsEnvNameDenied,
  textHasSecret,
} from './env-policy';
import { FORBIDDEN_KEYS, hasForbiddenKey, nullObject } from './safe-keys';
import {
  EVENT_PATTERN,
  hookCommandProblem,
  MAX_HOOK_TIMEOUT,
  MIN_HOOK_TIMEOUT,
  PERMISSION_MODES,
  SETTINGS_REJECTED_KEYS,
} from './settings-spec';

/**
 * Konwersja natywnego `settings.json` na cialo manifestu `Settings` (IMP-06, IMP-07). Funkcja jest
 * czysta i zachowawcza: co nie przechodzi walidacji, jest pomijane z raportem (sciezka i powod,
 * nigdy wartosc), a nie poprawiane.
 */
export interface SkippedKey {
  readonly path: string;
  readonly reason: string;
}

export interface NativeSettingsConversion {
  readonly spec: Record<string, unknown>;
  readonly skipped: readonly SkippedKey[];
  /** Nazwy zmiennych, ktore dostaly `envRef` zamiast wartosci (do uzupelnienia przez uzytkownika). */
  readonly envRefs: readonly string[];
  /** Polecenia przyjetych hookow, do wykrycia sciezek skryptow (IMP-08). */
  readonly hookCommands: readonly string[];
  /**
   * Sciezki pol z sekretem w poleceniu hooka lub regule uprawnien. Niepuste znaczy, ze cały zasob
   * trzeba pominac (bez cytowania wartosci).
   */
  readonly secretPaths: readonly string[];
}

export type NativeSettingsResult =
  | { readonly ok: true; readonly value: NativeSettingsConversion }
  | { readonly ok: false; readonly message: string };

const MAX_SKIPPED = 200;

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_STRING_LENGTH &&
    !CONTROL_CHARS.test(value)
  );
}

export function convertNativeSettings(input: unknown): NativeSettingsResult {
  if (!isPlainObject(input)) return { ok: false, message: 'settings.json ma byc obiektem JSON.' };
  if (hasForbiddenKey(input)) {
    return {
      ok: false,
      message: 'settings.json zawiera zabroniony klucz (__proto__, constructor, prototype).',
    };
  }
  const skipped: SkippedKey[] = [];
  const skip = (path: string, reason: string): void => {
    if (skipped.length < MAX_SKIPPED) skipped.push({ path, reason });
  };
  const envRefs: string[] = [];
  const hookCommands: string[] = [];
  const secretPaths: string[] = [];
  const spec: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if ((SETTINGS_REJECTED_KEYS as readonly string[]).includes(key)) {
      skip(childPath('$', key), 'zabroniony: uruchamia polecenia albo zmienia zrodla pluginow');
    } else if (key !== 'hooks' && key !== 'permissions' && key !== 'env') {
      skip(childPath('$', key), 'poza zakresem importu');
    }
  }

  const hooks = convertHooks(input['hooks'], skip, hookCommands, secretPaths);
  if (Object.keys(hooks).length > 0) spec['hooks'] = hooks;
  const permissions = convertPermissions(input['permissions'], skip, secretPaths);
  if (Object.keys(permissions).length > 0) spec['permissions'] = permissions;
  const env = convertEnv(input['env'], skip, envRefs);
  if (Object.keys(env).length > 0) spec['env'] = env;

  return { ok: true, value: { spec, skipped, envRefs, hookCommands, secretPaths } };
}

type Skip = (path: string, reason: string) => void;

/** Nadmiar ponad limit listy nie znika po cichu: raport dostaje wpis z liczba pominietych. */
function overLimit(skip: Skip, path: string, total: number): void {
  if (total > MAX_LIST_ITEMS)
    skip(path, `${total - MAX_LIST_ITEMS} poza limitem ${MAX_LIST_ITEMS}`);
}

function convertHooks(
  value: unknown,
  skip: Skip,
  commands: string[],
  secretPaths: string[],
): Record<string, unknown> {
  const result = nullObject<unknown>();
  if (value === undefined) return result;
  if (!isPlainObject(value)) {
    skip('hooks', 'oczekiwano obiektu');
    return result;
  }
  for (const event of Object.keys(value)) {
    const base = childPath('hooks', event);
    const groups = value[event];
    if (!EVENT_PATTERN.test(event) || FORBIDDEN_KEYS.has(event)) {
      skip(base, 'nazwa zdarzenia poza wzorcem');
      continue;
    }
    if (!Array.isArray(groups)) {
      skip(base, 'oczekiwano listy');
      continue;
    }
    const kept: unknown[] = [];
    (groups as unknown[]).slice(0, MAX_LIST_ITEMS).forEach((group, gi) => {
      const groupPath = `${base}[${gi}]`;
      const converted = convertGroup(group, groupPath, skip, commands, secretPaths);
      if (converted !== null) kept.push(converted);
    });
    overLimit(skip, base, (groups as unknown[]).length);
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

function convertGroup(
  group: unknown,
  path: string,
  skip: Skip,
  commands: string[],
  secretPaths: string[],
): unknown {
  if (!isPlainObject(group)) {
    skip(path, 'oczekiwano obiektu');
    return null;
  }
  for (const key of Object.keys(group)) {
    if (key !== 'matcher' && key !== 'hooks')
      skip(childPath(path, key), 'nieobslugiwane pole grupy');
  }
  const matcher = group['matcher'];
  const hasMatcher = matcher !== undefined && matcher !== '';
  if (hasMatcher && !validText(matcher)) {
    skip(childPath(path, 'matcher'), 'matcher poza limitami');
    return null;
  }
  const list = group['hooks'];
  if (!Array.isArray(list)) {
    skip(childPath(path, 'hooks'), 'oczekiwano listy');
    return null;
  }
  overLimit(skip, childPath(path, 'hooks'), list.length);
  const accepted: Record<string, unknown>[] = [];
  const acceptedCommands: string[] = [];
  (list as unknown[]).slice(0, MAX_LIST_ITEMS).forEach((hook, hi) => {
    const hookPath = `${childPath(path, 'hooks')}[${hi}]`;
    if (!isPlainObject(hook)) return skip(hookPath, 'oczekiwano obiektu');
    const type = hook['type'];
    if (type !== 'command') {
      return skip(
        hookPath,
        `hook typu ${typeof type === 'string' ? `"${childPath('$', type)}"` : 'nieznanego'} nie jest obslugiwany (tylko command)`,
      );
    }
    const extra = Object.keys(hook).find((k) => k !== 'type' && k !== 'command' && k !== 'timeout');
    if (extra !== undefined) return skip(hookPath, 'hook ma nieobslugiwane pole');
    const command = hook['command'];
    if (typeof command !== 'string') return skip(hookPath, 'brak polecenia');
    if (textHasSecret(command)) {
      secretPaths.push(`${hookPath}.command`);
      return skip(
        hookPath,
        'polecenie wyglada na zawierajace sekret (zasob Settings zostanie pominiety)',
      );
    }
    const problem = hookCommandProblem(command);
    if (problem !== null) return skip(hookPath, problem);
    const timeout = hook['timeout'];
    const entry: Record<string, unknown> = { type: 'command', command };
    if (timeout !== undefined) {
      const okTimeout =
        typeof timeout === 'number' &&
        Number.isInteger(timeout) &&
        timeout >= MIN_HOOK_TIMEOUT &&
        timeout <= MAX_HOOK_TIMEOUT;
      if (!okTimeout) return skip(hookPath, 'timeout poza zakresem 1..600');
      entry['timeout'] = timeout;
    }
    accepted.push(entry);
    acceptedCommands.push(command);
  });
  if (accepted.length === 0) return null;
  commands.push(...acceptedCommands);
  return hasMatcher ? { matcher, hooks: accepted } : { hooks: accepted };
}

function convertPermissions(
  value: unknown,
  skip: Skip,
  secretPaths: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (value === undefined) return result;
  if (!isPlainObject(value)) {
    skip('permissions', 'oczekiwano obiektu');
    return result;
  }
  for (const key of Object.keys(value)) {
    const path = childPath('permissions', key);
    if (key === 'allow' || key === 'deny' || key === 'ask' || key === 'additionalDirectories') {
      const list = value[key];
      if (!Array.isArray(list)) {
        skip(path, 'oczekiwano listy');
        continue;
      }
      const kept = new Set<string>();
      (list as unknown[]).forEach((item, index) => {
        if (typeof item === 'string' && key !== 'additionalDirectories' && textHasSecret(item)) {
          secretPaths.push(`${path}[${index}]`);
          skip(
            `${path}[${index}]`,
            'regula wyglada na zawierajaca sekret (zasob Settings zostanie pominiety)',
          );
        } else if (!validText(item))
          skip(
            `${path}[${index}]`,
            'wpis poza limitami (pusty, za dlugi lub ze znakami sterujacymi)',
          );
        else if (kept.size < MAX_LIST_ITEMS) kept.add(item);
        else skip(`${path}[${index}]`, 'ponad limit listy');
      });
      if (kept.size > 0) result[key] = [...kept];
    } else if (key === 'defaultMode') {
      const mode = value[key];
      if ((PERMISSION_MODES as readonly unknown[]).includes(mode)) result[key] = mode;
      else skip(path, 'nieznany tryb');
    } else {
      skip(path, 'poza zakresem importu');
    }
  }
  return result;
}

function convertEnv(value: unknown, skip: Skip, envRefs: string[]): Record<string, unknown> {
  const result = nullObject<unknown>();
  if (value === undefined) return result;
  if (!isPlainObject(value)) {
    skip('env', 'oczekiwano obiektu');
    return result;
  }
  for (const name of Object.keys(value)) {
    const path = childPath('env', name);
    const raw = value[name];
    if (!ENV_NAME_PATTERN.test(name) || FORBIDDEN_KEYS.has(name)) {
      skip(path, 'nazwa zmiennej poza wzorcem WIELKIMI_LITERAMI');
    } else if (isSettingsEnvNameDenied(name)) {
      skip(path, 'zabroniona zmienna (steruje procesem, silnikiem lub ruchem sieciowym)');
    } else if (!validText(raw)) {
      skip(path, 'wartosc poza limitami (nie tekst, pusta, za dluga lub ze znakami sterujacymi)');
    } else if (classifyEnvValue(name, raw) === 'ok') {
      result[name] = { value: raw };
    } else {
      result[name] = { envRef: name };
      envRefs.push(name);
    }
  }
  return result;
}
