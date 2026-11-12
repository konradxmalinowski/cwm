import type { ContentFlags } from '../../core/cwm';
import type { PinnedPath } from './hook-pins';

/** Limity importu (IMP-09). Przekroczenie limitu calego importu przerywa go w calosci. */
export const IMPORT_LIMITS = {
  fileBytes: 1024 * 1024,
  skillFiles: 500,
  skillBytes: 10 * 1024 * 1024,
  skillDepth: 16,
  importFiles: 20_000,
  /** Poza specyfikacja: tresc trzymamy w pamieci od skanu do zapisu, wiec calosc ma gorna granice. */
  importBytes: 256 * 1024 * 1024,
  importDirs: 5000,
} as const;

export type ImportKind = 'skill' | 'agent' | 'command' | 'settings';

/** Wpis raportu: co zostalo pominiete albo zmienione i dlaczego. Nigdy wartosc z pliku. */
export interface ReportItem {
  readonly item: string;
  readonly reason: string;
}

export interface SourceFile {
  readonly rel: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export interface Candidate {
  readonly kind: ImportKind;
  readonly rawName: string;
  /** Segment nazwy w id po normalizacji (IMP-10). */
  readonly name: string;
  /** Etykieta do raportow, np. `skills/acme-lint`. */
  readonly label: string;
  /** Pliki kopiowane do katalogu zasobu (bez manifestu). */
  readonly files: readonly SourceFile[];
  /** Sciezka zrodla po realpath (pochodzenie, IMP-01). */
  readonly sourceReal: string;
  /** Skrot kopiowanego drzewa (dla Settings: skrot pliku settings.json). */
  readonly sha256: string;
  /** Plik zrodlowy zasobu w katalogu (`SKILL.md`, `AGENT.md`, `COMMAND.md`); pusty dla Settings. */
  readonly source: string;
  readonly flags: ContentFlags;
  readonly tools: readonly string[];
  readonly model: string | null;
  /** Dla Settings: cialo `spec` po konwersji natywnego `settings.json`. */
  readonly spec: Readonly<Record<string, unknown>> | null;
  readonly envRefs: readonly string[];
  readonly pins: readonly PinnedPath[];
  readonly notes: readonly ReportItem[];
}

export type ScanOutcome =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly from: string;
      readonly candidates: readonly Candidate[];
      readonly skipped: readonly ReportItem[];
    };
