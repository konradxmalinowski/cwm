import { validateSlug } from '../../core/services/library/validate';
import { sha256Text } from '../../core/services/normalization/hash';

export interface DerivedSlug {
  readonly slug: string;
  /** `true`, gdy nazwa zrodlowa nie jest poprawnym slugiem i trzeba ja bylo zmienic. */
  readonly changed: boolean;
}

const SLUG_MAX = 64;

// NFD nie rozklada tych liter, a gubienie ich zostawiloby w slugu same myslniki.
const LATIN_EXTRAS: Readonly<Record<string, string>> = {
  ł: 'l',
  Ł: 'L',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
};

/**
 * Slug jest ASCII (validate.ts), a nazwa zrodlowa moze miec spacje albo polskie litery. Poprawna
 * nazwa przechodzi bez zmian; inna dostaje przyblizenie, a wywolujacy trzyma oryginal w `aliases`.
 */
export function deriveSlug(source: string): DerivedSlug {
  if (validateSlug(source) === null) return { slug: source, changed: false };

  let s = source
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[łŁøØđĐßæÆœŒ]/g, (c) => LATIN_EXTRAS[c] ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  s = trimTail(s.slice(0, SLUG_MAX));

  if (s === '') return { slug: hashedSlug(source), changed: true };
  if (validateSlug(s) !== null) {
    // Jedyny pozostaly powod to nazwa zarezerwowana przez Windows (con, aux, ...).
    const suffixed = `${s}-item`.slice(0, SLUG_MAX);
    return validateSlug(suffixed) === null
      ? { slug: suffixed, changed: true }
      : { slug: hashedSlug(source), changed: true };
  }
  return { slug: s, changed: s !== source };
}

function trimTail(s: string): string {
  return s.replace(/[.-]+$/, '');
}

function hashedSlug(source: string): string {
  return `item-${sha256Text(source).slice(0, 8)}`;
}

const DESCRIPTION_MAX = 300;

/**
 * Opis wyliczony z pierwszego akapitu tresci. Pomija naglowki, ogrodzone bloki kodu, komentarze
 * HTML i linie poziome, bo zadne z nich nie jest opisem. To heurystyka, wiec wynik zawsze idzie
 * z `descriptionOrigin: 'derived'`.
 */
export function deriveDescription(body: string): string {
  const paragraph: string[] = [];
  let fence: string | null = null;
  let comment = false;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (fence !== null) {
      if (line.startsWith(fence)) fence = null;
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    const fenceStart = /^(```+|~~~+)/.exec(line);
    const isBreak =
      line === '' ||
      fenceStart !== null ||
      /^#{1,6}(\s|$)/.test(line) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(line) ||
      line.startsWith('<!--');
    if (!isBreak) {
      paragraph.push(line.replace(/^>\s?/, ''));
      continue;
    }
    if (paragraph.length > 0) break;
    if (fenceStart !== null) fence = fenceStart[1] ?? '```';
    else if (line.startsWith('<!--') && !line.includes('-->')) comment = true;
  }

  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= DESCRIPTION_MAX) return text;
  const cut = text.slice(0, DESCRIPTION_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/** Tytul z pierwszego naglowka `# ...` poza blokami kodu. */
export function firstHeading(body: string): string | null {
  let fence: string | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (fence !== null) {
      if (line.startsWith(fence)) fence = null;
      continue;
    }
    const fenceStart = /^(```+|~~~+)/.exec(line);
    if (fenceStart !== null) {
      fence = fenceStart[1] ?? '```';
      continue;
    }
    const m = /^#\s+(.+?)\s*#*$/.exec(line);
    const cleaned = cleanInline(m?.[1] ?? '');
    if (cleaned !== '') return cleaned;
  }
  return null;
}

/** Znaczniki Markdowna nie nadaja sie na tytul: zostaje sam tekst. */
function cleanInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
