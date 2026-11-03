import type { ItemId, ItemKind, RootId, Timestamp, ToolId } from './item';

/**
 * Plan zapisu do konfiguracji narzedzia (ADR 0012, 0013, 0028). Plan jest wartoscia: da sie
 * go pokazac, porownac i przetestowac bez dotykania dysku. `plan` po `apply` musi byc pusty.
 */

export type CompatibilityLevel = 'full' | 'partial' | 'lossy' | 'unsupported';

export interface CompatibilityVerdict {
  readonly level: CompatibilityLevel;
  /** Tekst dla uzytkownika, po polsku. */
  readonly reasons: readonly string[];
  readonly lostAttributes: readonly string[];
  readonly addedAttributes: readonly string[];
}

export type RecoverabilityStatus = 'recoverable' | 'blocked';

export interface RecoverabilityVerdict {
  readonly status: RecoverabilityStatus;
  readonly reason: string | null;
  readonly probedAt: Timestamp;
}

/** Jak wpis zmienia plik docelowy. Zakres edycji decyduje o weryfikacji po zapisie. */
export type EditScope =
  /** Plik w calosci nalezy do eksportu (skill, agent, komenda). */
  | 'whole-file'
  /** Tylko blok miedzy markerami aplikacji (ADR 0025). */
  | 'marker-block'
  /** Tylko segmenty rejestracyjne agentow w `config.toml` (ADR 0011). */
  | 'toml-segment'
  /** Tylko klucz `hooks` w pliku ustawien JSON; reszta pliku semantycznie bez zmian. */
  | 'json-key';

export type MaterializationMode = 'symlink' | 'junction' | 'copy';

export type WriteAction =
  | 'create'
  | 'modify'
  /** Dowiazanie do wyrenderowanej kopii elementu w `userData` (ADR 0015). */
  | 'link'
  /** Cel juz ma oczekiwana tresc; wpis istnieje, zeby plan byl pelnym obrazem. */
  | 'unchanged';

export interface WritePlanEntry {
  readonly rootId: RootId;
  /** Sciezka wzgledem roota, z `/`. */
  readonly relPath: string;
  readonly action: WriteAction;
  readonly scope: EditScope;
  /** Elementy biblioteki, ktore ten wpis realizuje (plik wspolny ma ich wiele). */
  readonly itemIds: readonly ItemId[];
  /** Docelowe bajty pliku dla `create`/`modify` i dla kopii przy `link` z degradacja. */
  readonly content: Uint8Array | null;
  /**
   * Dla wpisu katalogowego (skill z plikami pomocniczymi): pelna zawartosc katalogu, sciezki
   * wzgledem `relPath`. Wtedy `content` jest null, a `link` dotyczy calego katalogu.
   */
  readonly files: readonly { readonly relPath: string; readonly bytes: Uint8Array }[] | null;
  /** Bajty pliku przed zapisem, null gdy plik nie istnieje; podstawa podgladu i weryfikacji. */
  readonly previous: Uint8Array | null;
  readonly materialization: MaterializationMode | null;
  readonly warnings: readonly string[];
  /** Ustawiane przez `WriteGate.probe`; adapter zostawia null. */
  readonly recoverability: RecoverabilityVerdict | null;
}

/** Element, dla ktorego nie powstaje zaden plik (ADR 0020, kryterium 2 Etapu 4). */
export interface PlanRefusal {
  readonly itemId: ItemId;
  readonly kind: ItemKind;
  readonly slug: string;
  readonly reason: string;
}

/** Konflikt wymagajacy decyzji (np. komenda i skill o tej samej nazwie w Codeksie, ADR 0021). */
export interface PlanConflict {
  readonly itemIds: readonly ItemId[];
  readonly relPath: string;
  readonly reason: string;
}

/** Plik w narzedziu, ktorego biblioteka juz nie realizuje. Tylko raport, nigdy usuniecie. */
export interface PlanOrphan {
  readonly rootId: RootId;
  readonly relPath: string;
  readonly reason: string;
}

export interface WritePlan {
  readonly planId: string;
  readonly tool: ToolId;
  readonly createdAt: Timestamp;
  readonly entries: readonly WritePlanEntry[];
  readonly verdicts: readonly { readonly itemId: ItemId; readonly verdict: CompatibilityVerdict }[];
  readonly refusals: readonly PlanRefusal[];
  readonly conflicts: readonly PlanConflict[];
  readonly orphans: readonly PlanOrphan[];
  /** False, gdy ktorykolwiek wpis jest `blocked` albo jest nierozstrzygniety konflikt. */
  readonly applicable: boolean;
}

export type ApplyOutcome = 'written' | 'unchanged' | 'rolled-back' | 'failed';

export interface ApplyEntryReport {
  readonly rootId: RootId;
  readonly relPath: string;
  readonly outcome: ApplyOutcome;
  readonly message: string | null;
}

export interface ApplyReport {
  readonly planId: string;
  /** Wpis logu operacji i katalog `backups/<timestamp>/` z MANIFEST (ADR 0014, 0019). */
  readonly backupId: string;
  readonly entries: readonly ApplyEntryReport[];
  readonly verified: boolean;
  readonly rolledBack: boolean;
}
