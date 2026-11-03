export type Route =
  | { readonly name: 'library' }
  | { readonly name: 'library-new' }
  | { readonly name: 'library-item'; readonly id: string }
  | { readonly name: 'library-edit'; readonly id: string }
  | { readonly name: 'import' }
  | { readonly name: 'diagnostics' }
  | { readonly name: 'not-found'; readonly path: string };

export const ROUTES = {
  library: '/biblioteka',
  libraryNew: '/biblioteka/nowy',
  import: '/import',
  diagnostics: '/diagnostyka',
  libraryItem: (id: string): string => `/biblioteka/${encodeURIComponent(id)}`,
  libraryEdit: (id: string): string => `/biblioteka/${encodeURIComponent(id)}/edycja`,
} as const;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Parsuje fragment adresu (`#/biblioteka/abc`) na trase. Nieznany adres to `not-found`, nie wyjatek. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const segments = path.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) return { name: 'library' };
  const [head, second, third] = segments;

  if (head === 'import' && segments.length === 1) return { name: 'import' };
  if (head === 'diagnostyka' && segments.length === 1) return { name: 'diagnostics' };

  if (head === 'biblioteka') {
    if (segments.length === 1) return { name: 'library' };
    if (second === 'nowy' && segments.length === 2) return { name: 'library-new' };
    const id = second === undefined ? null : decode(second);
    if (id !== null && id.length > 0) {
      if (segments.length === 2) return { name: 'library-item', id };
      if (third === 'edycja' && segments.length === 3) return { name: 'library-edit', id };
    }
  }
  return { name: 'not-found', path };
}
