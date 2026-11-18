import { join } from 'node:path';

import {
  DEFAULT_LIBRARY_GIT_SETTINGS,
  parseLibraryGitSettings,
  type LibraryGitSettings,
} from '../../core/model/library-git';
import type { LibraryGitSettingsStore } from '../../core/ports/library-git';
import { writeFileAtomic } from '../fs/atomic';
import { readChecked, type CheckedRead } from '../fs/bounded-read';
import { guarded } from '../fs/store-error';

const FILE_NAME = 'library-git.json';
const MAX_BYTES = 4096;

/**
 * Ustawienia wersjonowania biblioteki w `<userData>/library-git.json` (ADR 0060). To preferencja:
 * plik nieczytelny albo niezgodny z kontraktem daje wylaczone wersjonowanie bez zgody na prywatne
 * elementy, czyli nic nie trafia do historii na podstawie ustawien, ktorych nie dalo sie odczytac.
 */
export class FsLibraryGitSettingsStore implements LibraryGitSettingsStore {
  private readonly path: string;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, FILE_NAME);
  }

  load(): Promise<LibraryGitSettings> {
    return guarded(() => this.doLoad());
  }

  save(settings: LibraryGitSettings): Promise<void> {
    return guarded(() => {
      const body = JSON.stringify({ version: 1, ...settings }, null, 2);
      return writeFileAtomic(this.path, new TextEncoder().encode(`${body}\n`), { mode: 0o600 });
    });
  }

  private async doLoad(): Promise<LibraryGitSettings> {
    let read: CheckedRead;
    try {
      read = await readChecked(this.path, MAX_BYTES, { strict: true });
    } catch {
      return DEFAULT_LIBRARY_GIT_SETTINGS;
    }
    if (read.kind !== 'ok') return DEFAULT_LIBRARY_GIT_SETTINGS;
    try {
      const parsed = parseLibraryGitSettings(JSON.parse(new TextDecoder().decode(read.bytes)));
      return parsed.ok ? parsed.value : DEFAULT_LIBRARY_GIT_SETTINGS;
    } catch {
      return DEFAULT_LIBRARY_GIT_SETTINGS;
    }
  }
}
