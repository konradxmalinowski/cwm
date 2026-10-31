import type { LineEnding } from '../../model/item';

/**
 * Samotne `\r` jest koncem linii (jak w CommonMark) i przy normalizacji staje sie `\n`.
 * Oryginal zostaje w snapshocie zrodla bajt w bajt (ADR 0016, 0023), wiec nic nie ginie.
 * Plik z samymi `\r` jest zglaszany jako `mixed`: ADR 0016 zna tylko trzy style.
 */
interface LineEndingCounts {
  readonly lf: number;
  readonly crlf: number;
  readonly cr: number;
}

function countLineEndings(text: string): LineEndingCounts {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (code === 0x0a) {
      lf++;
    }
  }
  return { lf, crlf, cr };
}

/** Tekst bez zadnego konca linii jest `lf`: nie ma czego przywracac. */
export function detectLineEnding(text: string): LineEnding {
  const { lf, crlf, cr } = countLineEndings(text);
  if (cr > 0) return 'mixed';
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
