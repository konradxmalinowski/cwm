import { join } from 'node:path';

import type { LibraryGit, LibraryGitSettingsStore } from '../../core/ports/library-git';
import { FsLibraryGit } from '../../infra/library/library-git';
import { FsLibraryGitSettingsStore } from '../../infra/store/library-git-settings';
import { libraryRoot } from './paths';

/** Magazyn obiektow repozytorium biblioteki lezy obok `library/`, nie w niej (ADR 0060). */
export function libraryGitDir(userDataDir: string): string {
  return join(userDataDir, 'library-git');
}

export function createLibraryGit(userDataDir: string): {
  readonly settings: LibraryGitSettingsStore;
  readonly git: LibraryGit;
} {
  return {
    settings: new FsLibraryGitSettingsStore(userDataDir),
    git: new FsLibraryGit({
      libraryDir: libraryRoot(userDataDir),
      gitDir: libraryGitDir(userDataDir),
    }),
  };
}
