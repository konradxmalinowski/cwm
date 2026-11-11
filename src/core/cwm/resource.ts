import type { ToolId } from '../model/item';
import type { ResourceKind, ResourceRef, ResourceSet } from './kinds';

/** Nazwy rodzajow w manifestach zasobow (sekcja 5 specyfikacji) i ich odpowiedniki w kodzie. */
export const MANIFEST_KINDS = {
  Skill: 'skill',
  Agent: 'agent',
  Workflow: 'workflow',
  Plugin: 'plugin',
  MCP: 'mcp',
} as const satisfies Record<string, ResourceKind>;

export interface Skill {
  readonly kind: 'skill';
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly visibility: 'shared' | 'private';
  /** Puste znaczy brak ograniczenia. */
  readonly engines: readonly ToolId[];
  readonly dependencies: ResourceSet;
}

export interface Agent {
  readonly kind: 'agent';
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly skills: {
    /** Id skilli z rejestru. Licza sie jako zaleznosci agenta. */
    readonly shared: readonly string[];
    /** Sciezki skilli nalezacych tylko do tego agenta, poza rejestrem. */
    readonly private: readonly string[];
  };
  readonly tools: readonly string[];
  readonly model: string;
}

export interface WorkflowRouting {
  readonly mode: string;
  readonly priority: number;
  readonly examples: readonly string[];
  readonly keywords: readonly string[];
}

export interface WorkflowStep {
  readonly id: string;
  readonly agent: string;
  readonly dependsOn: readonly string[];
}

export interface Workflow {
  readonly kind: 'workflow';
  readonly id: string;
  readonly version: string;
  readonly type: 'instructional' | 'orchestrated';
  readonly source: string;
  readonly routing?: WorkflowRouting;
  readonly agents: readonly string[];
  readonly steps: readonly WorkflowStep[];
}

export type PluginSource =
  | { readonly type: 'local'; readonly path: string }
  | { readonly type: 'marketplace'; readonly marketplace: string; readonly plugin: string }
  | { readonly type: 'git'; readonly url: string; readonly ref?: string };

export interface Plugin {
  readonly kind: 'plugin';
  readonly id: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly activationDefault: 'enabled' | 'disabled';
}

export interface McpEnvRef {
  readonly envRef: string;
}

/**
 * Znacznik wartosci wpisanej wprost. Samej wartosci nie przechowujemy nigdzie: walidator
 * odrzuca taki wpis, a ten typ istnieje tylko po to, by `validatePolicy` zlapal reczne konfiguracje.
 */
export interface McpEnvLiteral {
  readonly literal: true;
}

export interface McpServer {
  readonly kind: 'mcp';
  readonly id: string;
  readonly version?: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly url?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, McpEnvRef | McpEnvLiteral>>;
}

/**
 * Pola, ktore decyduja o tym, co zostanie uruchomione lub z kim polaczy sie narzedzie. Przyszly
 * ekran zatwierdzania musi je pokazac uzytkownikowi przed aktywacja zasobu (bez UI na tym etapie).
 */
export const EXECUTION_RELEVANT_FIELDS = {
  mcp: ['command', 'args', 'url', 'env.envRef'],
  plugin: ['source'],
} as const;

export type Resource = Skill | Agent | Workflow | Plugin | McpServer;

/** `id@wersja`, a dla MCP bez wersji samo `id` (sekcja 10 specyfikacji). */
export function formatResource(resource: Resource): string {
  return resource.version === undefined ? resource.id : `${resource.id}@${resource.version}`;
}

/** Zaleznosci jawne plus skille wspoldzielone agenta oraz agenci workflow. */
export function dependenciesOf(resource: Resource): readonly ResourceRef[] {
  const refs = (kind: ResourceKind, ids: readonly string[]): ResourceRef[] =>
    ids.map((id) => ({ kind, id }));
  switch (resource.kind) {
    case 'skill': {
      const d = resource.dependencies;
      return [
        ...refs('skill', d.skills),
        ...refs('agent', d.agents),
        ...refs('workflow', d.workflows),
        ...refs('plugin', d.plugins),
        ...refs('mcp', d.mcp),
      ];
    }
    case 'agent':
      return refs('skill', resource.skills.shared);
    case 'workflow':
      return refs('agent', [...resource.agents, ...resource.steps.map((step) => step.agent)]);
    case 'plugin':
    case 'mcp':
      return [];
  }
}
