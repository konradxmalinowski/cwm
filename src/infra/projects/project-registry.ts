import { randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';

import {
  PROJECT_NAME_MAX,
  isProjectId,
  projectNameProblem,
  type ProjectId,
} from '../../core/model/project';
import { writeFileAtomic } from '../fs/atomic';
import { readBounded } from '../fs/bounded-read';
import { errnoCode } from '../fs/store-error';

/**
 * Rejestr projektow w `userData/projects.json` (ADR 0059): identyfikator, nazwa i katalog po
 * `realpath`. Katalog nie wychodzi poza main; renderer zna tylko identyfikator i nazwe.
 */

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  /** Sciezka bezwzgledna po `realpath`, sprawdzona przy dodaniu (`checkChosenProjectDir`). */
  readonly dir: string;
  readonly addedAt: string;
}

export const MAX_PROJECTS = 64;
const MAX_FILE_BYTES = 256 * 1024;
const FORMAT = 'cwm-projects';

export type ProjectRegistryErrorCode =
  | 'unknown-project'
  | 'project-exists'
  | 'too-many-projects'
  | 'invalid-name'
  | 'name-taken'
  | 'registry-failed';

export class ProjectRegistryError extends Error {
  constructor(
    readonly code: ProjectRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectRegistryError';
  }
}

export interface ProjectRegistryOptions {
  readonly newId?: () => ProjectId;
  readonly now?: () => Date;
  /** Porownanie katalogow; na Windowsie i macOS bez wielkosci liter. */
  readonly platform?: NodeJS.Platform;
  readonly onUnexpected?: (error: unknown) => void;
  /**
   * Polityka katalogu (`projectDirPolicyProblem`), uruchamiana dla kazdego wpisu przy wczytaniu.
   * Wpis, ktory jej nie przechodzi (np. recznie zmieniony plik), zostaje na liscie jako niewazny:
   * nie da sie go uzyc, mozna go tylko usunac.
   */
  readonly check?: (dir: string) => Promise<string | null>;
}

function defaultId(): ProjectId {
  return `proj-${randomBytes(8).toString('hex')}`;
}

function parseRecords(text: string): ProjectRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  if (root['format'] !== FORMAT || root['version'] !== 1 || !Array.isArray(root['projects'])) {
    return [];
  }
  const out: ProjectRecord[] = [];
  for (const raw of root['projects'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const { id, name, dir, addedAt } = r;
    if (!isProjectId(id) || typeof name !== 'string' || projectNameProblem(name) !== null) continue;
    if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) continue;
    if (typeof addedAt !== 'string') continue;
    if (out.some((p) => p.id === id)) continue;
    out.push({ id, name, dir, addedAt });
    if (out.length >= MAX_PROJECTS) break;
  }
  return out;
}

export class FsProjectRegistry {
  private records: readonly ProjectRecord[] = [];
  /** Powod, dla ktorego wpis nie przeszedl polityki przy wczytaniu. */
  private readonly invalid = new Map<string, string>();
  private loading: Promise<void> | null = null;
  /** Zapisy jeden po drugim: dwa rownolegle dodania nie moga nadpisac sie nawzajem. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly options: ProjectRegistryOptions = {},
  ) {}

  /** Wczytuje rejestr raz. Uszkodzony plik daje pusta liste, a nie blad startu. */
  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  list(): readonly ProjectRecord[] {
    return this.records;
  }

  get(id: string): ProjectRecord | null {
    return this.records.find((p) => p.id === id) ?? null;
  }

  /** `null` dla wpisu waznego; powod odmowy dla wpisu, ktory nie przeszedl polityki przy wczytaniu. */
  invalidReason(id: string): string | null {
    return this.invalid.get(id) ?? null;
  }

  add(dir: string, name: string): Promise<ProjectRecord> {
    return this.serial(async () => {
      const problem = projectNameProblem(name);
      if (problem !== null) throw new ProjectRegistryError('invalid-name', problem);
      const existing = this.records.find((p) => this.sameDir(p.dir, dir));
      if (existing !== undefined) {
        throw new ProjectRegistryError(
          'project-exists',
          `Ten katalog jest już na liście jako projekt „${existing.name}”.`,
        );
      }
      if (this.records.length >= MAX_PROJECTS) {
        throw new ProjectRegistryError(
          'too-many-projects',
          `Lista może mieć najwyżej ${MAX_PROJECTS} projekty. Usuń nieużywany projekt.`,
        );
      }
      const record: ProjectRecord = {
        id: (this.options.newId ?? defaultId)(),
        name: this.uniqueName(name.trim(), dir),
        dir,
        addedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      await this.persist([...this.records, record]);
      return record;
    });
  }

  rename(id: string, name: string): Promise<ProjectRecord> {
    return this.serial(async () => {
      const problem = projectNameProblem(name);
      if (problem !== null) throw new ProjectRegistryError('invalid-name', problem);
      const current = this.require(id);
      const wanted = name.trim();
      if (this.records.some((p) => p.id !== id && p.name.toLowerCase() === wanted.toLowerCase())) {
        throw new ProjectRegistryError(
          'name-taken',
          `Projekt o nazwie „${wanted}” jest już na liście. Wybierz inną nazwę.`,
        );
      }
      const renamed: ProjectRecord = { ...current, name: wanted };
      await this.persist(this.records.map((p) => (p.id === id ? renamed : p)));
      return renamed;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.require(id);
      await this.persist(this.records.filter((p) => p.id !== id));
      this.invalid.delete(id);
    });
  }

  private require(id: string): ProjectRecord {
    const found = this.get(id);
    if (found === null) {
      throw new ProjectRegistryError(
        'unknown-project',
        'Nie ma takiego projektu. Odśwież listę projektów.',
      );
    }
    return found;
  }

  /**
   * Nazwa bez duplikatu na liscie (wielkosc liter pomijana): przy kolizji dostaje w nawiasie nazwe
   * katalogu nadrzednego, a gdy i ta jest zajeta, kolejny numer.
   */
  private uniqueName(name: string, dir: string): string {
    const taken = new Set(this.records.map((p) => p.name.toLowerCase()));
    const fit = (value: string): string => value.slice(0, PROJECT_NAME_MAX);
    if (!taken.has(name.toLowerCase())) return name;
    const parent = basename(dirname(dir));
    const base = parent === '' ? name : fit(`${name} (${parent})`);
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const numbered = fit(`${base} ${n}`);
      if (!taken.has(numbered.toLowerCase())) return numbered;
    }
  }

  private sameDir(a: string, b: string): boolean {
    const platform = this.options.platform ?? process.platform;
    return platform === 'win32' || platform === 'darwin'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ready();
      return run();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(next: readonly ProjectRecord[]): Promise<void> {
    const body = JSON.stringify({ format: FORMAT, version: 1, projects: next }, null, 2);
    try {
      await writeFileAtomic(this.file, new TextEncoder().encode(`${body}\n`), { mode: 0o600 });
    } catch (error: unknown) {
      this.options.onUnexpected?.(error);
      throw new ProjectRegistryError(
        'registry-failed',
        'Nie udało się zapisać listy projektów. Szczegóły są w logu aplikacji.',
      );
    }
    this.records = next;
  }

  private async load(): Promise<void> {
    try {
      const { bytes, truncated } = await readBounded(this.file, MAX_FILE_BYTES);
      if (truncated) return;
      this.records = parseRecords(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error: unknown) {
      if (errnoCode(error) !== 'ENOENT') this.options.onUnexpected?.(error);
    }
    const check = this.options.check;
    if (check === undefined) return;
    for (const record of this.records) {
      const problem = await check(record.dir).catch(() => 'Nie udało się sprawdzić katalogu.');
      if (problem !== null) this.invalid.set(record.id, problem);
    }
  }
}
