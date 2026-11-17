import type { Sha256 } from '../../model/item';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function asHash(value: unknown): Sha256 | null {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? (value as Sha256) : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Hashe, na ktore wskazuje obiekt bedacy korzeniem (rekord wersji albo manifest stanu z dysku).
 * Rekord wersji niesie `assets[].bytesHash` i `source.snapshots[].files[].bytesHash`, manifest
 * `salvaged[].hash`. Bajty niebedace JSON-em, o innym ksztalcie albo z hashem w zlej formie daja
 * pusta liste: nadmiarowa ochrona jest bezpieczna, a zgadywanie z tekstu nie jest potrzebne.
 */
export function childHashes(bytes: Uint8Array): readonly Sha256[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  const found = new Set<Sha256>();
  const add = (value: unknown): void => {
    const hash = asHash(value);
    if (hash !== null) found.add(hash);
  };
  for (const entry of list(field(parsed, 'salvaged'))) add(field(entry, 'hash'));
  for (const asset of list(field(parsed, 'assets'))) add(field(asset, 'bytesHash'));
  for (const snapshot of list(field(field(parsed, 'source'), 'snapshots'))) {
    for (const file of list(field(snapshot, 'files'))) add(field(file, 'bytesHash'));
  }
  return [...found];
}
