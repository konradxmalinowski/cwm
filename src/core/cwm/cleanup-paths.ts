/**
 * Walidacja sciezek z manifestu generowania (PRF-02). Manifest to dane z dysku, wiec jego podmiana
 * nie moze rozszerzyc listy usuwanych ani zapisywanych plikow poza stala lista dozwolonych
 * przedrostkow. Sciezki sa wzgledne wobec `runtime/<firma>/`.
 */
export type CleanupArea = 'profile' | 'session' | 'plugin';

export type CleanupPathCheck =
  | { readonly ok: true; readonly area: CleanupArea }
  | { readonly ok: false; readonly reason: string };

const MAX_PATH_LENGTH = 512;
const MAX_SEGMENTS = 20;
/** Pierwszy segment pod `skills/` i `agents/` dla rodzaju Files: sciezki bywaja wielkimi literami (`Toolkit`). */
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const FLAT_MARKDOWN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.md$/;
import { foldName } from './names';
import { HASH16 } from './patterns';

const PLUGIN_SLUG = /^[a-z0-9][a-z0-9-]{0,62}@[0-9a-f]{16}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Nazwy w `claude/`, ktore naleza do silnika: CWM ich nie zapisuje ani nie usuwa. */
export const ENGINE_OWNED_NAMES: readonly string[] = [
  '.claude.json',
  '.credentials.json',
  'backups',
  'projects',
  'plugins',
  'history.jsonl',
  'file-history',
  'todos',
  'shell-snapshots',
  'plans',
  'ide',
  'statsig',
  'synced',
];

const PROTECTED_INSIDE = new Set(['.claude', '.mcp.json', 'claude.md']);

const bad = (reason: string): CleanupPathCheck => ({ ok: false, reason });

function treeRest(segments: readonly string[], from: number, protect = true): string | null {
  for (const segment of segments.slice(from)) {
    if (segment === '' || segment === '.' || segment === '..')
      return 'niedozwolony segment sciezki';
    if (protect && PROTECTED_INSIDE.has(foldName(segment))) {
      return 'chroniona nazwa wewnatrz drzewa';
    }
  }
  return null;
}

export function validateCleanupPath(rel: unknown): CleanupPathCheck {
  if (typeof rel !== 'string' || rel === '') return bad('sciezka nie jest tekstem');
  if (rel.length > MAX_PATH_LENGTH) return bad('sciezka jest za dluga');
  if (rel !== rel.normalize('NFC')) return bad('sciezka nie jest w formie NFC');
  if (CONTROL.test(rel)) return bad('sciezka zawiera znaki sterujace');
  if (rel.startsWith('/') || rel.includes('\\'))
    return bad('sciezka nie jest wzgledna w stylu POSIX');
  const segments = rel.split('/');
  if (segments.length > MAX_SEGMENTS) return bad('sciezka ma za wiele segmentow');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return bad('niedozwolony segment sciezki');
  }
  const [top, a, b, c] = segments;

  if (top === 'claude') {
    if (a === undefined) return bad('katalog profilu nie jest plikiem CWM');
    if (ENGINE_OWNED_NAMES.includes(foldName(a))) return bad('nazwa nalezy do silnika');
    if (segments.length === 2 && (a === 'settings.json' || a === 'CLAUDE.md')) {
      return { ok: true, area: 'profile' };
    }
    if (a === 'skills' && b !== undefined && segments.length === 3) {
      // Plik `.md` wprost w skills/ (rodzaj Files); katalog skilla bez pliku zostaje odrzucony.
      if (!FLAT_MARKDOWN.test(b) || PROTECTED_INSIDE.has(foldName(b))) {
        return bad('katalog skilla nie jest plikiem CWM');
      }
      return { ok: true, area: 'profile' };
    }
    if ((a === 'skills' || a === 'agents') && b !== undefined && segments.length >= 4) {
      if (!ENTRY.test(b))
        return bad(a === 'skills' ? 'nazwa skilla poza wzorcem' : 'nazwa katalogu poza wzorcem');
      if (a === 'skills' && foldName(b) === 'synced') return bad('nazwa nalezy do silnika');
      const rest = treeRest(segments, 3);
      return rest === null ? { ok: true, area: 'profile' } : bad(rest);
    }
    if ((a === 'agents' || a === 'commands') && b !== undefined && segments.length === 3) {
      return /^[a-z0-9][a-z0-9._-]{0,62}\.md$/.test(b)
        ? { ok: true, area: 'profile' }
        : bad('nazwa pliku poza wzorcem');
    }
    return bad('sciezka poza lista dozwolonych przedrostkow');
  }

  if (top === 'sessions') {
    if (a === undefined || !HASH16.test(a)) return bad('niepoprawny skrot projektu');
    if (segments.length === 3 && (b === 'settings.json' || b === 'mcp.json')) {
      return { ok: true, area: 'session' };
    }
    if (b === 'plugin' && c !== undefined) {
      const rest = treeRest(segments, 3);
      return rest === null ? { ok: true, area: 'session' } : bad(rest);
    }
    return bad('sciezka poza lista dozwolonych przedrostkow');
  }

  if (top === 'plugins') {
    if (a === undefined || !PLUGIN_SLUG.test(a)) return bad('niepoprawna nazwa migawki pluginu');
    if (b === undefined) return bad('katalog migawki nie jest plikiem CWM');
    // Migawka pluginu to jego tresc, a nie natywna konfiguracja: `.mcp.json` i `CLAUDE.md` sa tu zwyklymi plikami.
    const rest = treeRest(segments, 2, false);
    return rest === null ? { ok: true, area: 'plugin' } : bad(rest);
  }

  return bad('sciezka poza lista dozwolonych przedrostkow');
}
