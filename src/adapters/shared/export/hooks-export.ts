import type { HookDefinition } from '../../../core/model/item';
import { isJsonRecord, jsonEqual, type JsonRecord } from './json-key';

/**
 * Scalanie hookow biblioteki z drzewem `hooks` w pliku narzedzia. Nic nie usuwamy: wpisy
 * nieznane bibliotece (hooki innego typu niz `command`, hooki dodane recznie) zostaja.
 * Hook rozpoznajemy po zapisie ze zrodla (snapshot `hook.json`), a gdy go nie ma, po
 * zdarzeniu, matcherze i poleceniu.
 */

export interface HookInput {
  readonly def: HookDefinition;
  /** Hook z pliku zrodlowego tego samego narzedzia, jesli element stamtad pochodzi. */
  readonly original: JsonRecord | null;
}

export interface HookMerge {
  readonly hooks: JsonRecord;
  readonly changed: boolean;
}

interface Slot {
  readonly group: JsonRecord;
  readonly list: unknown[];
  readonly index: number;
  readonly direct: boolean;
  readonly hook: JsonRecord;
}

function matcherOf(group: JsonRecord): string | null {
  return typeof group['matcher'] === 'string' ? group['matcher'] : null;
}

function slots(groups: unknown[]): Slot[] {
  const out: Slot[] = [];
  for (const group of groups) {
    if (!isJsonRecord(group)) continue;
    if (Array.isArray(group['hooks'])) {
      const list = group['hooks'] as unknown[];
      list.forEach((hook, index) => {
        if (isJsonRecord(hook)) out.push({ group, list, index, direct: false, hook });
      });
    } else {
      out.push({ group, list: groups, index: groups.indexOf(group), direct: true, hook: group });
    }
  }
  return out;
}

function newHook(def: HookDefinition, base: JsonRecord | null): JsonRecord {
  const hook: JsonRecord = { ...(base ?? {}), type: 'command', command: def.command };
  if (def.timeoutSeconds !== null) hook['timeout'] = def.timeoutSeconds;
  else delete hook['timeout'];
  return hook;
}

export function parseOriginalHook(bytes: Uint8Array | undefined): JsonRecord | null {
  if (bytes === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isJsonRecord(parsed) && isJsonRecord(parsed['hook'])) return parsed['hook'];
  } catch {
    // Uszkodzony snapshot: wracamy do dopasowania po poleceniu.
  }
  return null;
}

export function mergeHooks(existing: unknown, inputs: readonly HookInput[]): HookMerge | string {
  if (existing !== undefined && !isJsonRecord(existing)) {
    return 'Klucz "hooks" w pliku nie jest obiektem, więc aplikacja go nie zmieni.';
  }
  const hooks = structuredClone<JsonRecord>(existing ?? {});
  for (const { def, original } of inputs) {
    const current = hooks[def.event];
    if (current !== undefined && !Array.isArray(current)) {
      return `Zdarzenie "${def.event}" w pliku nie jest listą, więc aplikacja go nie zmieni.`;
    }
    const groups: unknown[] = Array.isArray(current) ? current : [];
    hooks[def.event] = groups;
    const all = slots(groups);
    const byOriginal = original === null ? undefined : all.find((s) => jsonEqual(s.hook, original));
    const byCommand = all.find(
      (s) =>
        s.hook['type'] === 'command' &&
        s.hook['command'] === def.command &&
        matcherOf(s.group) === def.matcher,
    );
    const found = byOriginal ?? byCommand;
    if (found !== undefined && matcherOf(found.group) === def.matcher) {
      const updated = newHook(def, found.hook);
      if (!jsonEqual(updated, found.hook)) {
        if (found.direct) {
          groups[found.index] = {
            ...updated,
            ...(def.matcher !== null ? { matcher: def.matcher } : {}),
          };
        } else found.list[found.index] = updated;
      }
      continue;
    }
    if (found !== undefined) {
      // Zmiana matchera przenosi hook do innej grupy.
      if (found.direct) groups.splice(found.index, 1);
      else {
        found.list.splice(found.index, 1);
        if (found.list.length === 0) groups.splice(groups.indexOf(found.group), 1);
      }
    }
    const fresh = newHook(def, found?.hook ?? null);
    const target = slots(groups).find((s) => !s.direct && matcherOf(s.group) === def.matcher);
    if (target !== undefined) target.list.push(fresh);
    else {
      groups.push({ ...(def.matcher !== null ? { matcher: def.matcher } : {}), hooks: [fresh] });
    }
  }
  return { hooks, changed: !jsonEqual(hooks, existing ?? {}) };
}
