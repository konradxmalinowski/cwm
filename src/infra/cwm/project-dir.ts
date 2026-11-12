import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { errnoCode } from '../fs/store-error';
import { lstatLoose } from './paths';
import { readDirLimited } from './read';

export interface ProjectDirInfo {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly empty: boolean;
  /** Natywna konfiguracja narzedzi. Tylko wykrywana, CWM jej nie czyta ani nie zmienia. */
  readonly native: {
    readonly claudeDir: boolean;
    readonly claudeMd: boolean;
    readonly mcpJson: boolean;
  };
}

/** Katalog projektu moze byc dowiazaniem do katalogu: wtedy liczy sie to, na co wskazuje. */
export async function inspectProjectDir(dir: string): Promise<ProjectDirInfo> {
  const link = await lstatLoose(dir);
  const native = {
    claudeDir: (await lstatLoose(join(dir, '.claude'))) !== null,
    claudeMd: (await lstatLoose(join(dir, 'CLAUDE.md'))) !== null,
    mcpJson: (await lstatLoose(join(dir, '.mcp.json'))) !== null,
  };
  if (link === null) return { exists: false, isDirectory: false, empty: true, native };
  const target = link.isSymbolicLink() ? await stat(dir).catch(() => null) : link;
  const isDirectory = target?.isDirectory() === true;
  const empty = isDirectory ? (await readDirLimited(dir, 1)).entries.length === 0 : false;
  return { exists: true, isDirectory, empty, native };
}

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'build']);
const MAX_SCAN_DIRS = 2000;

export interface ScanResult {
  readonly dirs: string[];
  /** Skan zatrzymal sie na limicie katalogow albo wpisow: wynik moze byc niepelny. */
  readonly limited: boolean;
}

/** Katalogi z `.cwm/project.yaml` w `root` i do `maxDepth` poziomow nizej (bez dowiazan). */
export async function scanLocalProjects(root: string, maxDepth: number): Promise<ScanResult> {
  const dirs: string[] = [];
  let visited = 0;
  let limited = false;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (visited >= MAX_SCAN_DIRS) {
      limited = true;
      return;
    }
    visited += 1;
    if ((await lstatLoose(join(dir, '.cwm', 'project.yaml'))) !== null) dirs.push(dir);
    if (depth >= maxDepth) return;
    let listing: Awaited<ReturnType<typeof readDirLimited>>;
    try {
      listing = await readDirLimited(dir);
    } catch (error: unknown) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(errnoCode(error) ?? '')) return;
      throw error;
    }
    if (listing.truncated) limited = true;
    for (const entry of listing.entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  await visit(root, 0);
  return { dirs, limited };
}
