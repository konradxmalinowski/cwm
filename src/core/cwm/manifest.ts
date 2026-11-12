import type { ToolId } from '../model/item';
import type { API_VERSION, ResourceSet } from './kinds';

export type AssetSet = Pick<
  ResourceSet,
  'skills' | 'agents' | 'workflows' | 'commands' | 'settings'
>;
export type OptionalAssetSet = Pick<ResourceSet, 'skills' | 'agents' | 'commands' | 'settings'>;

export interface GlobalConfig {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: 'GlobalConfig';
  readonly defaults: {
    readonly engine: ToolId;
    readonly projectMode: string;
    readonly workflowSelection: string;
  };
  readonly resources: {
    /** Zawsze w srodowisku. Firma ani projekt nie moga ich wylaczyc. */
    readonly mandatory: OptionalAssetSet;
    /** Domyslnie aktywne, firma i projekt moga je wylaczyc. */
    readonly optional: OptionalAssetSet;
  };
  readonly runtime: {
    readonly separateCompanyConfigs: boolean;
    readonly preserveNativeConfiguration: boolean;
    readonly overwriteNativeFiles: boolean;
  };
}

export interface CompanyManifest {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: 'Company';
  readonly metadata: { readonly id: string; readonly name: string };
  readonly resources: {
    readonly enable: AssetSet;
    readonly disableOptional: AssetSet;
  };
  readonly plugins: {
    readonly enable: readonly string[];
    /** Rozszerzenie spoza specyfikacji (wymaga zgody wlasciciela): pluginy zabronione w projektach firmy. */
    readonly forbid: readonly string[];
  };
  readonly mcp: { readonly enable: readonly string[] };
  readonly instructions: { readonly file: string } | null;
  /** Rozszerzenie wlasciciela: zasoby dostepne do importu przez projekty innych firm. */
  readonly exports: ResourceSet;
}

/** Rozszerzenie wlasciciela. `from` to id firmy zrodlowej. */
export interface ProjectImport extends ResourceSet {
  readonly from: string;
}

export interface ProjectManifest {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: 'Project';
  readonly metadata: {
    readonly id: string;
    readonly company: string;
    /** Katalog projektu. Tylko w manifescie trzymanym w `~/.cwm` (`--store home`), gdzie nie ma go z polozenia pliku. */
    readonly path?: string;
  };
  readonly spec: {
    readonly engine: ToolId;
    readonly resources: {
      readonly enable: AssetSet;
      readonly disableOptional: AssetSet;
    };
    readonly plugins: { readonly enable: readonly string[]; readonly disable: readonly string[] };
    readonly mcp: { readonly enable: readonly string[]; readonly disable: readonly string[] };
    readonly workflows: { readonly selection: string | null };
    readonly native: { readonly preserve: boolean | null };
    readonly imports: readonly ProjectImport[];
  };
}
