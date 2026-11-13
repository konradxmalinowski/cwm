import type { ToolId } from '../model/item';
import type { ResourceKind, ResourceRef, ResourceSet } from './kinds';

/** Nazwy rodzajow w manifestach zasobow (sekcja 5 specyfikacji) i ich odpowiedniki w kodzie. */
export const MANIFEST_KINDS = {
  Skill: 'skill',
  Agent: 'agent',
  Workflow: 'workflow',
  Plugin: 'plugin',
  MCP: 'mcp',
  Settings: 'settings',
  Command: 'command',
  Files: 'files',
} as const satisfies Record<string, ResourceKind>;

/**
 * Cechy tresci pliku zrodlowego, ktore robia z zasobu zasob z polami wykonawczymi (IMP-05):
 * `allowed-tools` lub `tools` we frontmatterze oraz wstawki `!` z poleceniem w odwrotnych apostrofach,
 * wykonywane przy wczytaniu. Etap zatwierdzania liczy je ponownie z pliku; to jest zapis z importu.
 */
export interface ContentFlags {
  readonly allowedTools: boolean;
  readonly inlineCommands: boolean;
}

export interface Skill {
  readonly kind: 'skill';
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly visibility: 'shared' | 'private';
  /** Puste znaczy brak ograniczenia. */
  readonly engines: readonly ToolId[];
  readonly dependencies: ResourceSet;
  readonly contentFlags?: ContentFlags;
  /** Katalog natywny, z ktorego zasob zaimportowano (`realpath(--from)`): `cwm start` przepisuje odwolania do niego. */
  readonly nativeDir?: string;
}

/** Katalogi profilu, pod ktorymi mozna umiescic wspolne pliki (rodzaj `Files`). */
export const FILES_ROOTS = ['skills', 'agents'] as const;
export type FilesRoot = (typeof FILES_ROOTS)[number];

/**
 * Wspolny material, ktory agenci i skille czytaja po sciezce: pliki `.md` wprost w `skills/`, katalogi
 * `skills/<x>` bez `SKILL.md`, podkatalogi `agents/<x>`. Tresc lezy w katalogu zasobu pod ta sama
 * sciezka wzgledna co w profilu (`<katalog zasobu>/<path>/...`), a `path` jest jej wspolnym przedrostkiem.
 * To dane, nie polecenia: zasob nie ma pol wykonawczych i nie jest zatwierdzany, chyba ze lezy
 * w `agents/` i ma frontmatter agenta z polami wykonawczymi (silnik czyta `agents/` rekurencyjnie).
 */
export interface FilesResource {
  readonly kind: 'files';
  readonly id: string;
  readonly version: string;
  readonly root: FilesRoot;
  readonly path: string;
  /** Katalog natywny, z ktorego zasob zaimportowano (`realpath(--from)`): `cwm start` przepisuje odwolania do niego. */
  readonly nativeDir?: string;
}

/** Plik `.md` z `commands/`. Jak Skill, ale bez zaleznosci i bez ograniczen silnika. */
export interface Command {
  readonly kind: 'command';
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly contentFlags?: ContentFlags;
  /** Katalog natywny, z ktorego zasob zaimportowano (`realpath(--from)`): `cwm start` przepisuje odwolania do niego. */
  readonly nativeDir?: string;
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
  readonly contentFlags?: ContentFlags;
  /** Katalog natywny, z ktorego zasob zaimportowano (`realpath(--from)`): `cwm start` przepisuje odwolania do niego. */
  readonly nativeDir?: string;
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

/** Jeden hook; `type` to zawsze `command` (SET-03: `http`, `prompt` i `agent` sa odrzucane). */
export interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout?: number;
  /** Tylko hooki skilla (frontmatter): tekst pokazywany przy uruchomieniu hooka. */
  readonly statusMessage?: string;
}

export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

export interface SettingsPermissions {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  readonly defaultMode?: string;
  readonly additionalDirectories: readonly string[];
}

/** Zmienna `Settings.env`: odwolanie do zmiennej srodowiska uzytkownika albo wartosc niebedaca sekretem. */
export type SettingsEnvEntry = { readonly envRef: string } | { readonly value: string };

/** Teksty doklejane przez silnik do commitow i opisow PR. Sprawdzane pod katem sekretow jak reguly. */
export interface SettingsAttribution {
  readonly commit?: string;
  readonly pr?: string;
}

/** Ustawienia preferencji silnika bez wplywu na wykonanie kodu (typy sprawdzane przy walidacji). */
export interface SettingsPreferences {
  readonly theme?: string;
  readonly tui?: string;
  readonly voice?: { readonly enabled?: boolean; readonly mode?: string };
  readonly voiceEnabled?: boolean;
  readonly preferredNotifChannel?: string;
  readonly enableWorkflows?: boolean;
}

/** Hooki, uprawnienia i zmienne srodowiska silnika. Mapy sa obiektami bez prototypu (IMP-04). */
export interface Settings {
  readonly kind: 'settings';
  readonly id: string;
  readonly version: string;
  readonly hooks: Readonly<Record<string, readonly HookGroup[]>>;
  readonly permissions: SettingsPermissions;
  readonly env: Readonly<Record<string, SettingsEnvEntry>>;
  /** True: do pliku `--settings` (wyzszy priorytet niz projekt), false: do `settings.json` profilu. */
  readonly enforce: boolean;
  readonly attribution?: SettingsAttribution;
  readonly preferences?: SettingsPreferences;
}

/**
 * Pola, ktore decyduja o tym, co zostanie uruchomione lub z kim polaczy sie narzedzie. Przyszly
 * ekran zatwierdzania musi je pokazac uzytkownikowi przed aktywacja zasobu (bez UI na tym etapie).
 */
export const EXECUTION_RELEVANT_FIELDS = {
  mcp: [
    'transport',
    'command',
    'args',
    'url',
    'env.envRef',
    'headers',
    'headersHelper',
    'command.sha256',
  ],
  plugin: ['source', 'tree.sha256'],
  settings: [
    'hooks',
    'permissions.allow',
    'permissions.deny',
    'permissions.ask',
    'permissions.defaultMode',
    'permissions.additionalDirectories',
    'env',
    'enforce',
    'hooks.paths.sha256',
  ],
  /** Tylko pliki z `agents/` z frontmatterem agenta, ktory ma pola wykonawcze (`tools`, wstawki `!`). */
  files: ['tools', 'allowed-tools', 'source.sha256'],
  /** Tylko zasoby z `contentFlags`; skrot tresci pliku zrodlowego wchodzi razem z tymi polami. */
  skill: ['tools', 'allowed-tools', 'model', 'source.sha256'],
  agent: ['tools', 'allowed-tools', 'model', 'source.sha256'],
  command: ['tools', 'allowed-tools', 'model', 'source.sha256'],
  project: ['path.realpath', 'company'],
} as const;

export type Resource =
  Skill | Agent | Workflow | Plugin | McpServer | Settings | Command | FilesResource;

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
        ...refs('files', d.files),
      ];
    }
    case 'agent':
      return refs('skill', resource.skills.shared);
    case 'workflow':
      return refs('agent', [...resource.agents, ...resource.steps.map((step) => step.agent)]);
    case 'plugin':
    case 'mcp':
    case 'settings':
    case 'command':
    case 'files':
      return [];
  }
}
