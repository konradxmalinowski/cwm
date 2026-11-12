import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  ID_SPACE_PATTERN,
  RESOURCE_KINDS,
  RESOURCE_SET_KEYS,
  type ResourceKind,
} from '../../core/cwm';
import { protectedSegment } from './paths';

export const CWM_HOME_ENV = 'CWM_HOME';

/** Segment sciezki z id firmy albo projektu. Tylko taki wchodzi do `join`, zeby id nie wyszlo z katalogu. */

export interface CwmLayout {
  readonly home: string;
  readonly configFile: string;
  readonly registryDir: string;
  readonly companiesDir: string;
  readonly sourcesDir: string;
  readonly cacheDir: string;
  readonly locksDir: string;
  readonly runtimeDir: string;
}

/** `CWM_HOME` (musi byc sciezka bezwzgledna) albo `~/.cwm`. */
export function resolveCwmHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CWM_HOME_ENV];
  if (override === undefined || override === '') return join(homedir(), '.cwm');
  if (!isAbsolute(override)) {
    throw new Error(`${CWM_HOME_ENV} musi byc sciezka bezwzgledna, jest: "${override}".`);
  }
  const home = resolve(override);
  const blocked = protectedSegment(home);
  if (blocked !== null) {
    throw new Error(
      `${CWM_HOME_ENV} nie moze lezec w "${blocked}" (natywna konfiguracja narzedzi).`,
    );
  }
  return home;
}

export function createLayout(home: string): CwmLayout {
  return {
    home,
    configFile: join(home, 'config.yaml'),
    registryDir: join(home, 'registry'),
    companiesDir: join(home, 'companies'),
    sourcesDir: join(home, 'sources'),
    cacheDir: join(home, 'cache'),
    locksDir: join(home, 'locks'),
    runtimeDir: join(home, 'runtime'),
  };
}

export function isSafeSegment(value: string): boolean {
  return ID_SPACE_PATTERN.test(value);
}

function safe(segment: string): string {
  if (!isSafeSegment(segment)) throw new Error(`Niedozwolony segment sciezki: "${segment}".`);
  return segment;
}

export function companyDir(layout: CwmLayout, companyId: string): string {
  return join(layout.companiesDir, safe(companyId));
}

export function companyManifestFile(layout: CwmLayout, companyId: string): string {
  return join(companyDir(layout, companyId), 'company.yaml');
}

export function companyProjectsDir(layout: CwmLayout, companyId: string): string {
  return join(companyDir(layout, companyId), 'projects');
}

export function homeProjectFile(layout: CwmLayout, companyId: string, projectId: string): string {
  return join(companyProjectsDir(layout, companyId), `${safe(projectId)}.yaml`);
}

export function projectCwmDir(projectDir: string): string {
  return join(projectDir, '.cwm');
}

export function localProjectFile(projectDir: string): string {
  return join(projectCwmDir(projectDir), 'project.yaml');
}

/** Plik definicji zasobu w katalogu zasobu: `skill.yaml`, `agent.yaml` i tak dalej. */
export function resourceFileName(kind: ResourceKind): string {
  return `${kind}.yaml`;
}

export function registryKindDir(layout: CwmLayout, kind: ResourceKind): string {
  return join(layout.registryDir, RESOURCE_SET_KEYS[kind]);
}

/** Katalogi tworzone przez `cwm init`, w kolejnosci tworzenia. */
export function homeDirectories(layout: CwmLayout): readonly string[] {
  return [
    layout.home,
    layout.registryDir,
    ...RESOURCE_KINDS.map((kind) => registryKindDir(layout, kind)),
    layout.companiesDir,
    layout.sourcesDir,
    layout.cacheDir,
    layout.locksDir,
    layout.runtimeDir,
  ];
}
