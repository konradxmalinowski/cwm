/**
 * Blok miedzy markerami aplikacji w pliku instrukcji (ADR 0025). Funkcje sa czyste: dostaja tekst
 * pliku, zwracaja nowy tekst albo powod, dla ktorego nie wolno pisac. Tresc poza blokiem zostaje
 * bajt w bajt, bo kazdy zapis to podmiana zakresu albo dopisanie sufiksu.
 */

/** Markery sa przestrzenia nazw aplikacji. Zapis zawsze uzywa nazwy `cwm`. */
export const BLOCK_START = '<!-- cwm:start -->';
export const BLOCK_END = '<!-- cwm:end -->';

/** Nazwa z v0.1.0: odczyt ja rozpoznaje, zapis jej nie uzywa (ADR 0035). */
export const LEGACY_BLOCK_NAME = 'ai-skills-manager';

export type MarkerBlockResult =
  | { readonly kind: 'created' | 'appended' | 'replaced' | 'migrated'; readonly text: string }
  | { readonly kind: 'unchanged'; readonly text: string }
  /** Tresc zarzadzana jest w pliku bez markerow: wymaga decyzji uzytkownika (regula 3). */
  | { readonly kind: 'conflict'; readonly reason: string }
  /** Markery sa uszkodzone albo bloku nie wolno wstawic w tym miejscu. */
  | { readonly kind: 'refused'; readonly reason: string };

interface Marker {
  readonly name: string;
  readonly role: 'start' | 'end';
  /** Poczatek linii i jej koniec bez znaku konca linii. */
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Poczatek nastepnej linii (po znaku konca linii) albo dlugosc tekstu. */
  readonly next: number;
}

const MARKER_LINE = /^[ \t]*<!--[ \t]*([A-Za-z0-9._-]+):(start|end)[ \t]*-->[ \t]*$/;

function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 ? text.length : nl + 1;
    let end = nl === -1 ? text.length : nl;
    if (end > pos && text[end - 1] === '\r') end--;
    const m = MARKER_LINE.exec(text.slice(pos, end));
    if (m !== null) {
      out.push({
        name: m[1] ?? '',
        role: m[2] === 'start' ? 'start' : 'end',
        lineStart: pos,
        lineEnd: end,
        next,
      });
    }
    pos = next;
  }
  return out;
}

const OUR_NAME = 'cwm';

export function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function withEol(content: string, eol: string): string {
  const lf = content.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** Tresc, ktora aplikacja wstawia: znormalizowana do LF, bez koncowych pustych linii. */
export function blockBody(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/**
 * Heurystyka reguly 3: ta sama tresc jest juz w pliku. Cala tresc jako ciagly fragment albo,
 * dla trzech i wiecej linii, kazda niepusta linia obecna w pliku.
 */
export function containsManagedContent(existing: string, content: string): boolean {
  const wanted = normalize(content);
  if (wanted === '') return false;
  const haystack = normalize(existing);
  if (haystack.includes(wanted)) return true;
  const lines = wanted
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 3) return false;
  const present = new Set(haystack.split('\n').map((l) => l.trim()));
  return lines.every((l) => present.has(l));
}

const BOM = '\uFEFF';

/** Czy plik ma ktorykolwiek znacznik aplikacji, nowy albo z v0.1.0 (nawet uszkodzona para). */
export function hasOurMarkers(text: string): boolean {
  return findMarkers(text).some((m) => m.name === OUR_NAME || m.name === LEGACY_BLOCK_NAME);
}

export interface ManagedFragment {
  readonly start: number;
  readonly end: number;
  /** Ile razy fragment wystepuje w pliku; zamiana jest jednoznaczna tylko dla 1. */
  readonly count: number;
  readonly lines: number;
}

/**
 * Regula 3 (ADR 0025): fragment pliku, ktory jest trescia zaimportowana z tego pliku (snapshot
 * zrodla), a stoi poza znacznikami. Porownanie ignoruje rodzaj konca linii; zakres wraca
 * we wspolrzednych oryginalnego tekstu, zeby reszta pliku zostala bajt w bajt.
 */
export function findManagedFragment(
  existing: string,
  snapshotText: string,
): ManagedFragment | null {
  const wanted = snapshotText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (wanted === '') return null;
  const pattern = wanted
    .split('\n')
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\r\\n|\\r|\\n)');
  const all = [...existing.matchAll(new RegExp(pattern, 'g'))];
  const first = all[0];
  if (first === undefined) return null;
  return {
    start: first.index,
    end: first.index + first[0].length,
    count: all.length,
    lines: wanted.split('\n').length,
  };
}

/** Zamienia fragment na blok aplikacji; znaczniki zawsze stoja w osobnych liniach. */
export function replaceFragment(
  existing: string,
  fragment: ManagedFragment,
  content: string,
): string {
  const eol = dominantEol(existing);
  const before = existing.slice(0, fragment.start);
  const after = existing.slice(fragment.end);
  const atLineStart =
    fragment.start === 0 ||
    existing[fragment.start - 1] === '\n' ||
    (fragment.start === 1 && existing[0] === BOM);
  const atLineEnd = after === '' || after.startsWith('\n') || after.startsWith('\r');
  const block = `${BLOCK_START}${eol}${withEol(blockBody(content), eol)}${eol}${BLOCK_END}`;
  return `${before}${atLineStart ? '' : eol}${block}${atLineEnd ? '' : eol}${after}`;
}

export function applyMarkerBlock(
  existing: string | null,
  content: string,
  options: { readonly skipDuplicateCheck?: boolean } = {},
): MarkerBlockResult {
  const body = blockBody(content);
  if (existing === null || existing === '') {
    return { kind: 'created', text: `${BLOCK_START}\n${body}\n${BLOCK_END}\n` };
  }
  const eol = dominantEol(existing);
  const markers = findMarkers(existing);
  const ours = markers.filter((m) => m.name === OUR_NAME);
  const legacy = markers.filter((m) => m.name === LEGACY_BLOCK_NAME);

  if (ours.length > 0 && legacy.length > 0) {
    return {
      kind: 'conflict',
      reason:
        'Plik ma dwa bloki aplikacji: ze znacznikami cwm i ze starymi znacznikami ai-skills-manager. Aplikacja nie wybiera, który jest właściwy. Usuń jeden z nich ręcznie.',
    };
  }

  const found = ours.length > 0 ? ours : legacy;
  if (found.length > 0) {
    const starts = found.filter((m) => m.role === 'start');
    const ends = found.filter((m) => m.role === 'end');
    const start = starts[0];
    const end = ends[0];
    if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined) {
      return {
        kind: 'refused',
        reason:
          'Znaczniki aplikacji są uszkodzone albo powtórzone (powinna być jedna para). Aplikacja nie zgaduje, który blok jest właściwy.',
      };
    }
    if (end.lineStart < start.lineStart) {
      return {
        kind: 'refused',
        reason: 'Znacznik końca bloku stoi przed znacznikiem początku. Popraw plik ręcznie.',
      };
    }
    const innerStart = start.next;
    const innerEnd = end.lineStart;
    const inner = existing.slice(innerStart, innerEnd);
    const replacement = `${withEol(body, eol)}${eol}`;
    if (legacy.length > 0) {
      // Zmienia sie tylko nazwa w liniach znacznikow; wciecie i tekst za nimi zostaja.
      const renamed = (m: Marker): string =>
        existing.slice(m.lineStart, m.lineEnd).replace(LEGACY_BLOCK_NAME, OUR_NAME);
      return {
        kind: 'migrated',
        text:
          existing.slice(0, start.lineStart) +
          renamed(start) +
          existing.slice(start.lineEnd, innerStart) +
          replacement +
          renamed(end) +
          existing.slice(end.lineEnd),
      };
    }
    if (inner === replacement) return { kind: 'unchanged', text: existing };
    return {
      kind: 'replaced',
      text: existing.slice(0, innerStart) + replacement + existing.slice(innerEnd),
    };
  }

  if (options.skipDuplicateCheck !== true && containsManagedContent(existing, body)) {
    return {
      kind: 'conflict',
      reason:
        'Ta sama treść jest już w pliku, ale bez znaczników aplikacji. Zdecyduj, czy oznaczyć ją znacznikami, czy dopisać nowy blok.',
    };
  }

  // Obcy blok bez zamkniecia: dopisanie na koncu trafiloby do jego srodka.
  const open = new Map<string, number>();
  for (const m of markers) {
    open.set(m.name, (open.get(m.name) ?? 0) + (m.role === 'start' ? 1 : -1));
  }
  const unclosed = [...open].find(([, depth]) => depth > 0);
  if (unclosed !== undefined) {
    return {
      kind: 'refused',
      reason: `Plik ma niezamknięty blok obcego narzędzia ("${unclosed[0]}"). Aplikacja nie zapisze swojego bloku w jego środku.`,
    };
  }

  const tail = existing.endsWith('\n') ? '' : eol;
  const gap = /(\r?\n){2}$/.test(existing) ? '' : eol;
  const block = `${BLOCK_START}${eol}${withEol(body, eol)}${eol}${BLOCK_END}${eol}`;
  return { kind: 'appended', text: existing + tail + gap + block };
}

/** Czy plik ma blok aplikacji (do raportu sierot). */
export function hasManagedBlock(text: string): boolean {
  const ours = findMarkers(text).filter((m) => m.name === OUR_NAME || m.name === LEGACY_BLOCK_NAME);
  return ours.some((m) => m.role === 'start') && ours.some((m) => m.role === 'end');
}
