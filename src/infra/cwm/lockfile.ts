import { basename, dirname, join } from 'node:path';

import {
  formatLock,
  LOCK_FILE_NAME,
  MAX_LOCK_BYTES,
  parseLock,
  type LockDocument,
} from '../../core/cwm';
import type { CwmLayout } from './layout';
import { projectCwmDir } from './layout';
import { readTextWithin } from './read';
import type { ProjectRecord } from './workspace';
import { homeScope, projectScope, writeScopedFile, type WriteScope } from './writer';

/**
 * Lockfile lezy w tym samym magazynie co manifest projektu (ADR 0051): `<projekt>/.cwm/cwm.lock` dla
 * `--store local`, `~/.cwm/companies/<firma>/projects/<id>.lock` dla `--store home`. Odczyt i zapis
 * przechodza przez te same straznikow sciezek co manifest (dowiazanie, wyjscie poza korzen, zapis atomowy 0600).
 */
export function lockFileFor(record: ProjectRecord): string {
  const dir = dirname(record.file);
  return record.store === 'local'
    ? join(dir, LOCK_FILE_NAME)
    : join(dir, `${basename(record.file, '.yaml')}.lock`);
}

function rootFor(layout: CwmLayout, record: ProjectRecord): string {
  return record.store === 'local' && record.dir !== null ? projectCwmDir(record.dir) : layout.home;
}

function scopeFor(layout: CwmLayout, record: ProjectRecord): WriteScope {
  return record.store === 'local' && record.dir !== null
    ? projectScope(record.dir)
    : homeScope(layout.home);
}

export type LockRead =
  | { readonly state: 'missing' }
  | { readonly state: 'ok'; readonly doc: LockDocument; readonly text: string }
  | { readonly state: 'invalid'; readonly message: string };

/** Brak pliku to `missing`; kazdy inny problem (dowiazanie, rozmiar, JSON, obca wersja) to `invalid`. */
export async function readLock(layout: CwmLayout, record: ProjectRecord): Promise<LockRead> {
  const read = await readTextWithin(rootFor(layout, record), lockFileFor(record), MAX_LOCK_BYTES);
  if (!read.ok) {
    return read.reason === 'missing'
      ? { state: 'missing' }
      : { state: 'invalid', message: `Lockfile jest nieczytelny: ${read.message}` };
  }
  const parsed = parseLock(read.text);
  if (!parsed.ok) {
    const shown = parsed.errors
      .slice(0, 5)
      .map((error) => `${error.path}: ${error.message}`)
      .join('; ');
    return { state: 'invalid', message: `Lockfile jest niepoprawny (${shown}).` };
  }
  return { state: 'ok', doc: parsed.value, text: read.text };
}

/** Zapis atomowy (ten sam zakres co manifest projektu); zwraca zapisany tekst. */
export async function writeLock(
  layout: CwmLayout,
  record: ProjectRecord,
  doc: LockDocument,
): Promise<string> {
  const text = formatLock(doc);
  await writeScopedFile(scopeFor(layout, record), lockFileFor(record), text);
  return text;
}
