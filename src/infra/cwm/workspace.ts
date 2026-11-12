import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  validateCompanyManifest,
  validateGlobalConfig,
  validateProjectManifest,
  type CompanyManifest,
  type GlobalConfig,
  type ProjectManifest,
} from '../../core/cwm';
import { isPathInside } from '../../core/model/path-containment';
import { errnoCode } from '../fs/store-error';
import {
  companyManifestFile,
  companyProjectsDir,
  isSafeSegment,
  localProjectFile,
  projectCwmDir,
  type CwmLayout,
} from './layout';
import { lstatLoose, realpathLoose } from './paths';
import {
  listDirectory,
  problemAt,
  problemWithoutPosition,
  readManifest,
  SCAN_LIMIT_MESSAGE,
  type Loaded,
  type Problem,
} from './read';
import { FileResourceRegistry } from './registry';

export type ProjectStore = 'local' | 'home';

export interface ProjectRecord {
  readonly store: ProjectStore;
  /** Katalog projektu: z polozenia pliku (local) albo z `metadata.path` (home). Null, gdy manifest jest bledny. */
  readonly dir: string | null;
  readonly file: string;
  /** Firma z katalogu `companies/<firma>/projects` (home); null dla local. */
  readonly storedUnder: string | null;
  readonly loaded: Loaded<ProjectManifest>;
}

export function loadGlobalConfig(layout: CwmLayout): Promise<Loaded<GlobalConfig>> {
  return readManifest(layout.home, layout.configFile, validateGlobalConfig);
}

export function loadCompany(layout: CwmLayout, id: string): Promise<Loaded<CompanyManifest>> {
  return readManifest(layout.home, companyManifestFile(layout, id), validateCompanyManifest);
}

export interface CompanyList {
  readonly ids: readonly string[];
  readonly problems: readonly Problem[];
}

/** Katalogi firm w `~/.cwm/companies`. Nazwa spoza wzorca id jest zglaszana i pomijana. */
export async function listCompanyIds(layout: CwmLayout): Promise<CompanyList> {
  const listing = await listDirectory(layout.home, layout.companiesDir);
  if (!listing.ok) {
    return {
      ids: [],
      problems: [problemWithoutPosition(layout.companiesDir, '$', listing.message)],
    };
  }
  const ids: string[] = [];
  const problems: Problem[] = [];
  for (const entry of listing.entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(layout.companiesDir, entry.name);
    if (entry.kind !== 'dir') {
      problems.push(
        problemWithoutPosition(path, '$', 'Oczekiwano katalogu firmy (dowiazania sa pomijane).'),
      );
    } else if (!isSafeSegment(entry.name)) {
      problems.push(
        problemWithoutPosition(path, '$', 'Nazwa katalogu nie jest poprawnym id firmy.'),
      );
    } else {
      ids.push(entry.name);
    }
  }
  return { ids, problems };
}

type HomePath = { readonly dir: string } | { readonly problem: Problem };

/**
 * `metadata.path` z manifestu w `~/.cwm` to dane z dysku: musi byc sciezka bezwzgledna do istniejacego
 * katalogu poza katalogiem danych CWM. Inaczej manifest dostaje problem, a projekt jest pomijany.
 */
async function checkHomeProjectPath(
  layout: CwmLayout,
  file: string,
  text: string,
  path: string | undefined,
): Promise<HomePath> {
  const bad = (field: string, message: string): HomePath => ({
    problem: problemAt(file, text, field, message),
  });
  if (path === undefined) {
    return bad('metadata', 'Manifest w katalogu danych wymaga metadata.path (katalog projektu).');
  }
  if (!isAbsolute(path)) return bad('metadata.path', 'Sciezka projektu musi byc bezwzgledna.');
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) {
      return bad('metadata.path', 'Sciezka projektu nie jest katalogiem.');
    }
  } catch (error: unknown) {
    const code = errnoCode(error);
    return bad(
      'metadata.path',
      code === 'ENOENT' || code === 'ENOTDIR'
        ? 'Katalog projektu nie istnieje.'
        : 'Katalogu projektu nie mozna sprawdzic.',
    );
  }
  const homeReal = await realpathLoose(layout.home);
  if (isPathInside(real, homeReal, { allowSame: true })) {
    return bad('metadata.path', 'Projekt nie moze lezec w katalogu danych CWM.');
  }
  return { dir: real };
}

/** Manifesty projektow trzymane w `~/.cwm` (`--store home`), wszystkich firm albo jednej. */
export async function listHomeProjects(
  layout: CwmLayout,
  companyIds: readonly string[],
): Promise<{ records: ProjectRecord[]; problems: Problem[] }> {
  const records: ProjectRecord[] = [];
  const problems: Problem[] = [];
  for (const company of companyIds) {
    const dir = companyProjectsDir(layout, company);
    const listing = await listDirectory(layout.home, dir);
    if (!listing.ok) {
      problems.push(problemWithoutPosition(dir, '$', listing.message));
      continue;
    }
    if (listing.truncated) problems.push(problemWithoutPosition(dir, '$', SCAN_LIMIT_MESSAGE));
    for (const entry of listing.entries) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.yaml')) continue;
      const file = join(dir, entry.name);
      if (entry.kind !== 'file') {
        problems.push(problemWithoutPosition(file, '$', 'Oczekiwano zwyklego pliku manifestu.'));
        continue;
      }
      const loaded = await readManifest(layout.home, file, validateProjectManifest);
      if (!loaded.ok) {
        records.push({ store: 'home', dir: null, file, storedUnder: company, loaded });
        continue;
      }
      const checked = await checkHomeProjectPath(
        layout,
        file,
        loaded.text,
        loaded.value.metadata.path,
      );
      if ('problem' in checked) problems.push(checked.problem);
      else records.push({ store: 'home', dir: checked.dir, file, storedUnder: company, loaded });
    }
  }
  return { records, problems };
}

export async function loadLocalProject(projectDir: string): Promise<ProjectRecord | null> {
  const file = localProjectFile(projectDir);
  if ((await lstatLoose(projectCwmDir(projectDir))) === null) return null;
  const loaded = await readManifest(projectCwmDir(projectDir), file, validateProjectManifest);
  if (!loaded.ok && loaded.reason === 'missing') return null;
  return { store: 'local', dir: resolve(projectDir), file, storedUnder: null, loaded };
}

const realOrResolved = realpathLoose;

export interface ProjectLookup {
  readonly record: ProjectRecord | null;
  readonly problems: readonly Problem[];
}

/**
 * Indeks projektow: jeden odczyt manifestow z `~/.cwm`, potem wyszukiwanie po katalogu. Projekt
 * w katalogu moze miec manifest lokalny i/lub w `~/.cwm`; oba naraz to blad (Fail Closed).
 */
export class ProjectIndex {
  private constructor(private readonly home: ReadonlyMap<string, ProjectRecord[]>) {}

  /** Indeks z juz wczytanych manifestow (bez ponownego czytania `~/.cwm`). */
  static fromRecords(records: readonly ProjectRecord[]): ProjectIndex {
    const map = new Map<string, ProjectRecord[]>();
    for (const record of records) {
      if (record.dir === null) continue;
      map.set(record.dir, [...(map.get(record.dir) ?? []), record]);
    }
    return new ProjectIndex(map);
  }

  static async build(layout: CwmLayout, companyIds: readonly string[]): Promise<ProjectIndex> {
    const { records } = await listHomeProjects(layout, companyIds);
    return ProjectIndex.fromRecords(records);
  }

  /** Projekt zadeklarowany dokladnie w tym katalogu. */
  async at(dir: string): Promise<ProjectLookup> {
    const real = await realOrResolved(dir);
    const found: ProjectRecord[] = [];
    const local = await loadLocalProject(real);
    if (local) found.push(local);
    found.push(...(this.home.get(real) ?? []));
    const [first, second] = found;
    if (first && second) {
      return {
        record: null,
        problems: [
          problemWithoutPosition(
            second.file,
            '$',
            `Katalog ${real} ma dwa manifesty projektu (takze ${first.file}). Zostaw jeden.`,
          ),
        ],
      };
    }
    return { record: first ?? null, problems: [] };
  }

  /** Najblizszy projekt w katalogu `dir` albo wyzej. */
  async enclosing(dir: string, includeSelf: boolean): Promise<ProjectLookup> {
    let current = await realOrResolved(dir);
    if (!includeSelf) current = dirname(current);
    for (;;) {
      const lookup = await this.at(current);
      if (lookup.record !== null || lookup.problems.length > 0) return lookup;
      const parent = dirname(current);
      if (parent === current) return { record: null, problems: [] };
      current = parent;
    }
  }
}

export interface Workspace {
  readonly layout: CwmLayout;
  readonly global: Loaded<GlobalConfig>;
  readonly companyIds: readonly string[];
  readonly companies: ReadonlyMap<string, Loaded<CompanyManifest>>;
  readonly registry: FileResourceRegistry;
  readonly index: ProjectIndex;
  /** Manifesty projektow z `~/.cwm`, wczytane raz (poprawne sciezki projektow). */
  readonly homeProjects: readonly ProjectRecord[];
  /** Problemy samych katalogow (nie manifestow): zle nazwy, dowiazania, nieczytelne katalogi. */
  readonly problems: readonly Problem[];
  /** Manifesty projektow z `~/.cwm` pominiete przez zla albo niebezpieczna `metadata.path`. */
  readonly homeProjectProblems: readonly Problem[];
}

export async function loadWorkspace(layout: CwmLayout): Promise<Workspace> {
  const global = await loadGlobalConfig(layout);
  const { ids, problems } = await listCompanyIds(layout);
  const companies = new Map<string, Loaded<CompanyManifest>>();
  for (const id of ids) companies.set(id, await loadCompany(layout, id));
  const registry = await FileResourceRegistry.load(layout, ids);
  const home = await listHomeProjects(layout, ids);
  const index = ProjectIndex.fromRecords(home.records);
  return {
    layout,
    global,
    companyIds: ids,
    companies,
    registry,
    index,
    homeProjects: home.records,
    problems,
    homeProjectProblems: home.problems,
  };
}
