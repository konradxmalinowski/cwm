import type { ItemDraft, ItemKind, RootId, ToolId } from '../model/item';
import type { SourceReader } from './source-reader';

/**
 * Czesc kontraktu adaptera potrzebna do importu (ARCHITECTURE 5, Etap 3). `plan`, `apply`
 * i `verify` dojda w Etapie 4. Adapter nie wylicza sciezek konfiguracyjnych sam: dostaje
 * rooty z warstwy wykrywania lokalizacji (ADR 0022) i czyta przez `SourceReader`.
 */

/** Rodzaj roota, ktory warstwa lokalizacji wykrywa dla danego narzedzia. */
export type RootKind =
  'skills' | 'agents' | 'commands' | 'rules' | 'global-instructions' | 'hooks' | 'agent-registry';

export interface DetectedRoot {
  readonly rootId: RootId;
  readonly tool: ToolId;
  readonly kind: RootKind;
  /** Opis dla uzytkownika bez sciezki bezwzglednej, np. "~/.claude/skills". */
  readonly label: string;
  readonly exists: boolean;
  /** Dla drugiego roota tego samego rodzaju (ADR 0024): czy narzedzie go czyta. */
  readonly active: boolean;
}

export interface ImportWarning {
  readonly code: string;
  /** Po polsku, dla uzytkownika, bez sciezki bezwzglednej. */
  readonly message: string;
}

/** Element rozpoznany w drzewie i zamieniony na szkic kanoniczny. */
export interface ImportCandidate {
  readonly tool: ToolId;
  readonly rootId: RootId;
  /** Sciezka wzgledem roota, z `/`; trafia do `ImportOrigin.path`. */
  readonly relPath: string;
  readonly kind: ItemKind;
  readonly draft: ItemDraft;
  readonly warnings: readonly ImportWarning[];
  /** Klucz aliasu: elementy o tym samym kluczu to fizycznie ten sam plik (ADR 0026). */
  readonly aliasKey: string | null;
}

/** Plik lub katalog, ktorego adapter nie zamienil na element, z powodem. */
export interface ImportSkip {
  readonly tool: ToolId;
  readonly rootId: RootId;
  readonly relPath: string;
  readonly reason:
    'not-an-element' | 'unreadable' | 'too-large' | 'malformed' | 'symlink-outside' | 'unsupported';
  readonly message: string;
}

export interface ScanResult {
  readonly candidates: readonly ImportCandidate[];
  readonly skipped: readonly ImportSkip[];
}

/** Wynik skanu jednego roota razem z rootem, z ktorego pochodzi. */
export interface RootScan {
  readonly root: DetectedRoot;
  readonly result: ScanResult;
}

export interface ToolAdapter {
  readonly id: ToolId;
  readonly displayName: string;
  /** Rodzaje rootow, ktore adapter umie skanowac. */
  readonly rootKinds: readonly RootKind[];
  /** Skan jednego roota. Nie modyfikuje zrodla; blad jednego pliku nie przerywa skanu. */
  scan(root: DetectedRoot, reader: SourceReader): Promise<ScanResult>;
  /**
   * Opcjonalny krok po skanie wszystkich rootow jednego narzedzia, dla zaleznosci miedzy rootami
   * (np. agent w jednym roocie, rejestracja w drugim). Zwraca tyle wynikow, ile dostal, w tej
   * samej kolejnosci. Czyta wylacznie przez `reader`.
   */
  finalize?(scans: readonly RootScan[], reader: SourceReader): Promise<readonly ScanResult[]>;
}

/** Warstwa wykrywania lokalizacji (ADR 0022). Jedyne miejsce, ktore zna sciezki narzedzi. */
export interface LocationCatalog {
  detect(): Promise<readonly DetectedRoot[]>;
}
