import type { ToolId } from '../model/item';
import type { API_VERSION } from './kinds';
import type { Layer, MergedSettings } from './merge-settings';
import type { Resource } from './resource';

/** Skad zasob wzial sie w konfiguracji. Przy kilku powodach liczy sie najsilniejszy. */
export type Origin = 'mandatory' | 'optional' | 'dependency';

export interface EffectiveResource {
  readonly origin: Origin;
  /** Najnizsza warstwa, z ktorej zasob trafil do konfiguracji (zaleznosc dziedziczy warstwe rodzica). */
  readonly layer: Layer;
  readonly resource: Resource;
}

/**
 * Wynik `resolve` w ksztalcie z sekcji 10 specyfikacji. `resources` to dodatek wewnetrzny
 * (pelne definicje i pochodzenie dla `validatePolicy` i lockfile), nie czesc dokumentu ze specyfikacji.
 * Wszystkie listy sa posortowane, wiec wynik jest powtarzalny.
 */
export interface EffectiveConfiguration {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: 'EffectiveConfiguration';
  readonly profile: {
    readonly company: string;
    readonly project: string;
    readonly engine: ToolId;
  };
  /** `id@wersja`, dla MCP samo `id`. */
  readonly resolved: {
    readonly skills: readonly string[];
    readonly agents: readonly string[];
    readonly workflows: readonly string[];
    readonly plugins: readonly string[];
    readonly mcp: readonly string[];
    readonly settings: readonly string[];
    readonly commands: readonly string[];
    readonly files: readonly string[];
  };
  /** Ustawienia scalone ze wszystkich zasobow `Settings` (hooki, uprawnienia, env). */
  readonly settings: MergedSettings;
  /** Przy wyniku bez bledow zawsze puste: konflikty i braki przerywaja budowanie (Fail Closed). */
  readonly validation: {
    readonly conflicts: readonly string[];
    readonly missingDependencies: readonly string[];
  };
  readonly resources: readonly EffectiveResource[];
}
