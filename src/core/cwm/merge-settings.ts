import { compareStrings, type ValidationError } from './errors';
import type {
  HookGroup,
  Settings,
  SettingsAttribution,
  SettingsEnvEntry,
  SettingsPreferences,
} from './resource';
import { nullObject } from './safe-keys';

/** Warstwa, z ktorej zasob trafil do konfiguracji; od niej zalezy kolejnosc hookow. */
export type Layer = 'global' | 'company' | 'project';
export const LAYER_RANK: Record<Layer, number> = { global: 0, company: 1, project: 2 };

export interface SettingsBundle {
  /** Zdarzenia posortowane; grupy w kolejnosci: warstwa (global, firma, projekt), potem id zasobu. */
  readonly hooks: Readonly<Record<string, readonly HookGroup[]>>;
  readonly permissions: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly ask: readonly string[];
    readonly defaultMode?: string;
    readonly additionalDirectories: readonly string[];
  };
  readonly env: Readonly<Record<string, SettingsEnvEntry>>;
  /** Teksty doklejane do commitow i PR; ten sam klucz o roznych wartosciach to konflikt, jak `env`. */
  readonly attribution?: SettingsAttribution;
  /** Preferencje silnika; ta sama zasada konfliktow. */
  readonly preferences?: SettingsPreferences;
  /** Id scalonych zasobow w kolejnosci scalania. */
  readonly sources: readonly string[];
}

/** `enforced` trafia do pliku `--settings`, `regular` do `settings.json` profilu. */
export interface MergedSettings {
  readonly regular: SettingsBundle;
  readonly enforced: SettingsBundle;
}

export interface SettingsInput {
  readonly resource: Settings;
  readonly layer: Layer;
}

const sortedUnion = (lists: readonly (readonly string[])[]): string[] =>
  [...new Set(lists.flat())].sort(compareStrings);

const sameEntry = (a: SettingsEnvEntry, b: SettingsEnvEntry): boolean =>
  'envRef' in a ? 'envRef' in b && a.envRef === b.envRef : 'value' in b && a.value === b.value;

type FlatValue = string | boolean;

/** `attribution.commit`, `preferences.theme`, `preferences.voice.mode`: jedna plaska mapa do porownan. */
function flatten(
  attribution: SettingsAttribution | undefined,
  preferences: SettingsPreferences | undefined,
): Map<string, FlatValue> {
  const out = new Map<string, FlatValue>();
  for (const [key, value] of Object.entries(attribution ?? {})) {
    if (typeof value === 'string') out.set(`attribution.${key}`, value);
  }
  for (const [key, value] of Object.entries(preferences ?? {})) {
    if (key === 'voice' && typeof value === 'object' && value !== null) {
      for (const [sub, inner] of Object.entries(value as Record<string, FlatValue>)) {
        out.set(`preferences.voice.${sub}`, inner);
      }
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      out.set(`preferences.${key}`, value);
    }
  }
  return out;
}

function unflatten(flat: ReadonlyMap<string, FlatValue>): {
  attribution?: SettingsAttribution;
  preferences?: SettingsPreferences;
} {
  const attribution: Record<string, FlatValue> = {};
  const preferences: Record<string, unknown> = {};
  const voice: Record<string, FlatValue> = {};
  for (const key of [...flat.keys()].sort(compareStrings)) {
    const value = flat.get(key);
    if (value === undefined) continue;
    if (key.startsWith('attribution.')) attribution[key.slice('attribution.'.length)] = value;
    else if (key.startsWith('preferences.voice.')) {
      voice[key.slice('preferences.voice.'.length)] = value;
    } else preferences[key.slice('preferences.'.length)] = value;
  }
  if (Object.keys(voice).length > 0) preferences['voice'] = voice;
  return {
    ...(Object.keys(attribution).length > 0 ? { attribution: attribution } : {}),
    ...(Object.keys(preferences).length > 0 ? { preferences: preferences } : {}),
  };
}

function mergeGroup(items: readonly Settings[], errors: ValidationError[]): SettingsBundle {
  const events = new Map<string, HookGroup[]>();
  const env = nullObject<SettingsEnvEntry>();
  const envOwner = new Map<string, string>();
  let defaultMode: string | undefined;
  let modeOwner = '';
  const flat = new Map<string, FlatValue>();
  const flatOwner = new Map<string, string>();

  for (const item of items) {
    for (const [event, groups] of Object.entries(item.hooks)) {
      events.set(event, [...(events.get(event) ?? []), ...groups]);
    }
    for (const [name, entry] of Object.entries(item.env)) {
      const known = env[name];
      if (known === undefined) {
        env[name] = entry;
        envOwner.set(name, item.id);
      } else if (!sameEntry(known, entry)) {
        errors.push({
          path: `settings:${item.id}.env.${name}`,
          message: `Zmienna ${name} ma rozne definicje w ${envOwner.get(name) ?? '?'} i ${item.id}.`,
        });
      }
    }
    for (const [key, value] of flatten(item.attribution, item.preferences)) {
      const known = flat.get(key);
      if (known === undefined) {
        flat.set(key, value);
        flatOwner.set(key, item.id);
      } else if (known !== value) {
        errors.push({
          path: `settings:${item.id}.${key}`,
          message: `Ustawienie ${key} ma rozne wartosci w ${flatOwner.get(key) ?? '?'} i ${item.id}.`,
        });
      }
    }
    const mode = item.permissions.defaultMode;
    if (mode !== undefined) {
      if (defaultMode === undefined) {
        defaultMode = mode;
        modeOwner = item.id;
      } else if (defaultMode !== mode) {
        errors.push({
          path: `settings:${item.id}.permissions.defaultMode`,
          message: `defaultMode ma rozne wartosci w ${modeOwner} i ${item.id}.`,
        });
      }
    }
  }

  const hooks = nullObject<readonly HookGroup[]>();
  for (const event of [...events.keys()].sort(compareStrings))
    hooks[event] = events.get(event) ?? [];
  const sortedEnv = nullObject<SettingsEnvEntry>();
  for (const name of Object.keys(env).sort(compareStrings)) {
    const entry = env[name];
    if (entry !== undefined) sortedEnv[name] = entry;
  }
  return {
    hooks,
    permissions: {
      allow: sortedUnion(items.map((i) => i.permissions.allow)),
      deny: sortedUnion(items.map((i) => i.permissions.deny)),
      ask: sortedUnion(items.map((i) => i.permissions.ask)),
      ...(defaultMode === undefined ? {} : { defaultMode }),
      additionalDirectories: sortedUnion(items.map((i) => i.permissions.additionalDirectories)),
    },
    env: sortedEnv,
    ...unflatten(flat),
    sources: items.map((i) => i.id),
  };
}

/**
 * Scala wiele `Settings` w jedna konfiguracje, osobno dla `enforce: true` i `false`: hooki sa
 * konkatenowane (warstwa, potem id), listy uprawnien sumowane i sortowane, a `env` oraz
 * `defaultMode` z roznymi wartosciami to blad (identyczne duplikaty nie sa konfliktem). Komunikaty
 * nie cytuja wartosci. Scalanie dziala na obiektach bez prototypu.
 */
export function mergeSettings(inputs: readonly SettingsInput[]): {
  readonly merged: MergedSettings;
  readonly errors: readonly ValidationError[];
} {
  const ordered = [...inputs].sort(
    (a, b) =>
      LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || compareStrings(a.resource.id, b.resource.id),
  );
  const errors: ValidationError[] = [];
  const part = (enforce: boolean): SettingsBundle =>
    mergeGroup(
      ordered.filter((i) => i.resource.enforce === enforce).map((i) => i.resource),
      errors,
    );
  const merged = { regular: part(false), enforced: part(true) };
  // `enforce` zmienia tylko plik docelowy, wiec rozne wartosci tej samej zmiennej albo trybu
  // w dwoch plikach to nadal konflikt: o wyniku decydowalby priorytet pliku, nie konfiguracja.
  for (const [name, entry] of Object.entries(merged.enforced.env)) {
    const other = merged.regular.env[name];
    if (other !== undefined && !sameEntry(other, entry)) {
      errors.push({
        path: `settings.env.${name}`,
        message: `Zmienna ${name} ma rozne definicje w Settings z enforce true i false.`,
      });
    }
  }
  const regularFlat = flatten(merged.regular.attribution, merged.regular.preferences);
  for (const [key, value] of flatten(merged.enforced.attribution, merged.enforced.preferences)) {
    const other = regularFlat.get(key);
    if (other !== undefined && other !== value) {
      errors.push({
        path: `settings.${key}`,
        message: `Ustawienie ${key} ma rozne wartosci w Settings z enforce true i false.`,
      });
    }
  }
  const modes = [merged.regular.permissions.defaultMode, merged.enforced.permissions.defaultMode];
  if (modes[0] !== undefined && modes[1] !== undefined && modes[0] !== modes[1]) {
    errors.push({
      path: 'settings.permissions.defaultMode',
      message: 'defaultMode ma rozne wartosci w Settings z enforce true i false.',
    });
  }
  return { merged, errors };
}
