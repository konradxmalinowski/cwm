import type { LibraryItem } from '../../model/item';
import type { ProjectId } from '../../model/project';

/**
 * Zakres elementu przy zapisie (ADR 0059). Element przypiety do projektu trafia wylacznie do swojego
 * projektu; element globalny trafia do projektu tylko wtedy, gdy uzytkownik to jawnie zaznaczyl.
 * Te same reguly sprawdza main na gotowym planie, niezaleznie od tej funkcji.
 */
export type ExportTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: ProjectId; readonly includeGlobal: boolean };

export const GLOBAL_TARGET: ExportTarget = { kind: 'global' };

export const SCOPE_REFUSAL = {
  projectToGlobal:
    'Element należy do projektu, więc nie trafia do katalogu globalnego narzędzia. Wyeksportuj go do jego projektu.',
  otherProject: 'Element należy do innego projektu i nie trafia do tego.',
  globalNotConfirmed:
    'Element globalny trafia do projektu tylko jawnie. Zaznacz „Dołącz elementy globalne” i przygotuj plan jeszcze raz.',
  privateToProject:
    'Element prywatny nie trafia do repozytorium projektu, także z zaznaczonym „Dołącz elementy globalne”.',
  secretToProject:
    'Element z możliwym sekretem nie trafia do repozytorium projektu, także z zaznaczonym „Dołącz elementy globalne”.',
} as const;

/**
 * Element globalny, ktorego nie wolno wypuscic do repozytorium: prywatny albo z trafieniem
 * klasyfikatora sekretow. Repozytorium trafia do Gita i dalej, wiec zgoda `includeGlobal` go nie obejmuje.
 */
export function restrictedFromRepository(item: LibraryItem): boolean {
  return item.classification.scope === 'private' || item.classification.secretFindings.length > 0;
}

export function boundProject(item: LibraryItem): ProjectId | null {
  return item.classification.projectId ?? null;
}

/** Powod odmowy albo `null`, gdy element moze trafic do celu. */
export function scopeRefusal(item: LibraryItem, target: ExportTarget): string | null {
  const bound = boundProject(item);
  if (target.kind === 'global') return bound === null ? null : SCOPE_REFUSAL.projectToGlobal;
  if (bound !== null) return bound === target.projectId ? null : SCOPE_REFUSAL.otherProject;
  if (!target.includeGlobal) return SCOPE_REFUSAL.globalNotConfirmed;
  if (item.classification.scope === 'private') return SCOPE_REFUSAL.privateToProject;
  if (item.classification.secretFindings.length > 0) return SCOPE_REFUSAL.secretToProject;
  return null;
}

/** Czy zapis elementu o tym przypieciu do tego projektu (`null`: katalog globalny) jest dozwolony. */
export function scopeAllows(
  itemProject: ProjectId | null,
  destination: ProjectId | null,
  includeGlobal: boolean,
  restricted: boolean,
): boolean {
  if (destination === null) return itemProject === null;
  if (itemProject !== null) return itemProject === destination;
  return includeGlobal && !restricted;
}
