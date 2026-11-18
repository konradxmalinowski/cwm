/**
 * Projekt z rejestru projektow (ADR 0059). Core zna tylko identyfikator i nazwe; katalog projektu
 * zna wylacznie rejestr w infra, a renderer nigdy go nie dostaje.
 */

/** `proj-` i 16 znakow szesnastkowych; nadaje rejestr przy dodaniu, nie zmienia sie przy zmianie nazwy. */
export type ProjectId = string;

const PROJECT_ID = /^proj-[0-9a-f]{16}$/;

export function isProjectId(value: unknown): value is ProjectId {
  return typeof value === 'string' && PROJECT_ID.test(value);
}

export const PROJECT_NAME_MAX = 80;

// eslint-disable-next-line no-control-regex -- kontrolujemy dokladnie znaki sterujace
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Nazwa projektu to etykieta dla uzytkownika: niepusta, bez znakow sterujacych, do 80 znakow. */
export function projectNameProblem(name: string): string | null {
  if (name.trim().length === 0) return 'Nazwa projektu nie może być pusta.';
  if (name.length > PROJECT_NAME_MAX) {
    return `Nazwa projektu może mieć najwyżej ${PROJECT_NAME_MAX} znaków.`;
  }
  if (CONTROL_CHARS.test(name)) return 'Nazwa projektu zawiera niedozwolony znak sterujący.';
  return null;
}
