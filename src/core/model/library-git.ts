/**
 * Opcjonalne wersjonowanie biblioteki w lokalnym repozytorium Git (ADR 0060). Git nigdy nie jest
 * wymagany do podstawowych operacji: ten model opisuje tylko ustawienia, tresc commitow i to, ktore
 * elementy wolno wlozyc do historii.
 */
export interface LibraryGitSettings {
  /** Wersjonowanie wlaczone: po kazdej operacji zapisujacej biblioteke powstaje commit. */
  readonly enabled: boolean;
  /** Jawna zgoda na elementy spoza zakresu `public` (`private`, `project`). Elementy z sekretami nie wchodza nigdy. */
  readonly includePrivate: boolean;
}

export const DEFAULT_LIBRARY_GIT_SETTINGS: LibraryGitSettings = {
  enabled: false,
  includePrivate: false,
};

export type LibraryGitParse =
  | { readonly ok: true; readonly value: LibraryGitSettings }
  | { readonly ok: false; readonly message: string };

/**
 * Walidacja niezaufanego wejscia (IPC albo plik na dysku). Wynik powstaje z dwoch znanych pol,
 * wiec inne klucze nigdzie nie docieraja; wartosc niebooleowska jest bledem, nie jest zgadywana.
 */
export function parseLibraryGitSettings(raw: unknown): LibraryGitParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Nieprawidłowe ustawienia wersjonowania.' };
  }
  const record = raw as Record<string, unknown>;
  for (const field of ['enabled', 'includePrivate'] as const) {
    if (typeof record[field] !== 'boolean') {
      return {
        ok: false,
        message: `Nieprawidłowe ustawienia wersjonowania. Pole „${field}” musi być wartością logiczną.`,
      };
    }
  }
  return {
    ok: true,
    value: {
      enabled: record['enabled'] === true,
      includePrivate: record['includePrivate'] === true,
    },
  };
}

/** Typ operacji w temacie commita. Nie zawiera nazw, slugow ani sciezek. */
export type LibraryGitOperation =
  'save' | 'delete' | 'repair' | 'import' | 'detach' | 'enable' | 'resync';

/** Autor neutralny: bez imienia, adresu ani innych danych uzytkownika. */
export const LIBRARY_GIT_AUTHOR = { name: 'cwm', email: 'cwm@localhost' } as const;

/** Temat commita: typ operacji i liczba elementow, np. `import: 3 items`. */
export function libraryGitSubject(operation: LibraryGitOperation, items: number): string {
  return `${operation}: ${items} ${items === 1 ? 'item' : 'items'}`;
}

/**
 * Dlaczego element nie wchodzi do historii; `included` to jedyny stan, ktory trafia do repozytorium.
 * `excluded-secrets` to wykrycie zapisane w `item.json` albo ponowny skan tresci w chwili commita
 * (ADR 0060, punkt 6); `excluded-git-entry` to plik albo katalog `.git` gdziekolwiek w elemencie.
 */
export type LibraryGitEligibility =
  | 'included'
  | 'excluded-private'
  | 'excluded-secrets'
  | 'excluded-git-entry'
  | 'excluded-unreadable';

const SCOPES: ReadonlySet<string> = new Set(['public', 'private', 'project']);

/**
 * Decyzja o jednym elemencie na podstawie sparsowanego `item.json`. Zawodzi na zamknieciu: wszystko,
 * czego ksztaltu nie da sie potwierdzic (brak klasyfikacji, nieznany zakres, `secretFindings` nie jest
 * lista), jest wykluczone jako `excluded-unreadable`. Element z wykryciami sekretow jest wykluczony
 * zawsze, niezaleznie od zgody; zgoda `includePrivate` obejmuje tylko zakresy inne niz `public`.
 */
export function libraryGitEligibility(
  itemJson: unknown,
  includePrivate: boolean,
): LibraryGitEligibility {
  if (typeof itemJson !== 'object' || itemJson === null || Array.isArray(itemJson)) {
    return 'excluded-unreadable';
  }
  const classification = (itemJson as Record<string, unknown>)['classification'];
  if (typeof classification !== 'object' || classification === null) return 'excluded-unreadable';
  const { scope, secretFindings } = classification as Record<string, unknown>;
  if (!Array.isArray(secretFindings) || typeof scope !== 'string' || !SCOPES.has(scope)) {
    return 'excluded-unreadable';
  }
  if (secretFindings.length > 0) return 'excluded-secrets';
  if (scope !== 'public' && !includePrivate) return 'excluded-private';
  return 'included';
}
