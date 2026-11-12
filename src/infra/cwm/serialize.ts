import { stringify } from 'yaml';

import {
  API_VERSION,
  type CompanyManifest,
  type EffectiveConfiguration,
  type GlobalConfig,
  type ProjectManifest,
} from '../../core/cwm';
import type { ToolId } from '../../core/model/item';

/** Za kazdym razem nowy obiekt: wspolny obiekt YAML zapisalby jako alias (&a1/*a1), a aliasy sa w manifestach zabronione. */
const emptyAssets = (): { skills: never[]; agents: never[]; workflows: never[] } => ({
  skills: [],
  agents: [],
  workflows: [],
});

export function toYaml(document: unknown): string {
  return stringify(document, { lineWidth: 0, indent: 2, aliasDuplicateObjects: false });
}

export function defaultGlobalConfig(engine: ToolId = 'claude-code'): GlobalConfig {
  return {
    apiVersion: API_VERSION,
    kind: 'GlobalConfig',
    defaults: { engine, projectMode: 'clean', workflowSelection: 'automatic' },
    resources: {
      mandatory: { skills: [], agents: [] },
      optional: { skills: [], agents: [] },
    },
    runtime: {
      separateCompanyConfigs: true,
      preserveNativeConfiguration: true,
      overwriteNativeFiles: false,
    },
  };
}

/** Dokument nowej firmy w ksztalcie ze specyfikacji; pola `null` pomijamy, bo walidator ich nie przyjmuje. */
export function newCompanyDocument(id: string, name: string, instructionsFile?: string): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'Company',
    metadata: { id, name },
    resources: { enable: emptyAssets(), disableOptional: emptyAssets() },
    plugins: { enable: [], forbid: [] },
    mcp: { enable: [] },
    ...(instructionsFile === undefined ? {} : { instructions: { file: instructionsFile } }),
    exports: { skills: [], agents: [], workflows: [], plugins: [], mcp: [] },
  } satisfies Record<string, unknown> & { kind: CompanyManifest['kind'] };
}

export function newProjectDocument(input: {
  readonly id: string;
  readonly company: string;
  readonly engine: ToolId;
  readonly path?: string;
}): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'Project',
    metadata: {
      id: input.id,
      company: input.company,
      ...(input.path === undefined ? {} : { path: input.path }),
    },
    spec: {
      engine: input.engine,
      resources: {
        enable: emptyAssets(),
        disableOptional: { skills: [], agents: [] },
      },
      plugins: { enable: [], disable: [] },
      mcp: { enable: [], disable: [] },
      workflows: { selection: 'automatic' },
      native: { preserve: true },
    },
  } satisfies Record<string, unknown> & { kind: ProjectManifest['kind'] };
}

/** Sekcja 10 specyfikacji; pole `resources` to dodatek wewnetrzny resolvera i nie trafia do dokumentu. */
export function effectiveDocument(effective: EffectiveConfiguration): unknown {
  return {
    apiVersion: effective.apiVersion,
    kind: effective.kind,
    profile: effective.profile,
    resolved: effective.resolved,
    validation: effective.validation,
  };
}
