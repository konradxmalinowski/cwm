import { SourceReadError } from '../../core/ports/source-reader';
import { deriveDescription } from './slug';
import type { ScanContext } from './scan-context';
import { TextDecodeError, toParsableText } from './text';

/**
 * Instrukcja globalna to jeden plik na narzedzie, a root jest tym plikiem (locations.ts). Bierzemy caly plik jako tresc i nie wycinamy
 * bloku miedzy markerami (ADR 0025): decyzja, co jest zarzadzane, nalezy do eksportu.
 */
export async function scanInstructionFile(
  ctx: ScanContext,
  fileName: string,
  slug: string,
): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.read('');
  } catch (error) {
    // Brak pliku to zwykly stan (narzedzie bez instrukcji), nie problem do pokazania.
    if (error instanceof SourceReadError && error.failure === 'not-found') return;
    ctx.skipFromError(error, fileName);
    return;
  }
  let text: string;
  try {
    text = toParsableText(bytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    ctx.skip(fileName, 'malformed', `Plik "${fileName}" nie jest poprawnym tekstem UTF-8.`);
    return;
  }
  if (text.trim() === '') {
    ctx.skip(fileName, 'not-an-element', `Plik "${fileName}" jest pusty.`);
    return;
  }
  ctx.add({
    relPath: fileName,
    kind: 'global-instruction',
    draft: {
      kind: 'global-instruction',
      identity: { slug, declaredName: null, aliases: [] },
      content: {
        title: fileName,
        description: deriveDescription(text),
        descriptionOrigin: 'derived',
        body: text,
      },
      assets: [],
      source: {
        snapshots: [
          {
            tool: ctx.tool,
            files: [{ relPath: fileName, bytes, mode: await ctx.mode('') }],
            unmappedKeys: [],
          },
        ],
        importedFrom: null,
      },
    },
    warnings: [],
    aliasKey: null,
  });
}
