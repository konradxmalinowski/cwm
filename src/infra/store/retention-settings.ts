import { join } from 'node:path';

import {
  NO_RETENTION_LIMITS,
  parseRetentionSettings,
  type RetentionSettings,
} from '../../core/model/retention';
import type { RetentionSettingsStore } from '../../core/ports/retention';
import { writeFileAtomic } from '../fs/atomic';
import { readChecked, type CheckedRead } from '../fs/bounded-read';
import { guarded } from '../fs/store-error';

const FILE_NAME = 'retention.json';
const MAX_BYTES = 4096;

/**
 * Ustawienia retencji w `<userData>/retention.json` (ADR 0056). To preferencja, nie dane: plik
 * nieczytelny albo niezgodny z zakresami daje komplet `null`, czyli brak przycinania. Nic sie wtedy
 * nie usuwa na podstawie ustawien, ktorych nie dalo sie odczytac.
 */
export class FsRetentionSettingsStore implements RetentionSettingsStore {
  private readonly path: string;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, FILE_NAME);
  }

  load(): Promise<RetentionSettings> {
    return guarded(() => this.doLoad());
  }

  save(settings: RetentionSettings): Promise<void> {
    return guarded(() => {
      const body = JSON.stringify({ version: 1, ...settings }, null, 2);
      return writeFileAtomic(this.path, new TextEncoder().encode(`${body}\n`), { mode: 0o600 });
    });
  }

  private async doLoad(): Promise<RetentionSettings> {
    let read: CheckedRead;
    try {
      read = await readChecked(this.path, MAX_BYTES, { strict: true });
    } catch {
      return NO_RETENTION_LIMITS;
    }
    if (read.kind !== 'ok') return NO_RETENTION_LIMITS;
    try {
      const parsed = parseRetentionSettings(JSON.parse(new TextDecoder().decode(read.bytes)));
      return parsed.ok ? parsed.value : NO_RETENTION_LIMITS;
    } catch {
      return NO_RETENTION_LIMITS;
    }
  }
}
