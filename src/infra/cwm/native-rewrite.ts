import { join } from 'node:path';

import { nativeDirPattern, rewriteNativeConfigRefs } from '../../core/cwm';
import { realpathLoose } from './paths';
import type { TreeFile } from './runtime-sources';

const encoder = new TextEncoder();

export interface NativeRewriter {
  /**
   * Zmienione bajty i liczba odwolan (katalog domowy oraz katalog natywny zapisany w zasobie);
   * pliki wykonywalne i nietekstowe zostaja bez zmian.
   */
  apply(file: TreeFile, origin?: string): { file: TreeFile; count: number };
}

/**
 * Przepisywanie odwolan do natywnego `~/.claude` na `profileDir` w kopiach zasobow. Ten sam kod
 * dziala w `cwm start` (prawdziwy profil firmy) i przy wyprowadzaniu pol pakietu (znacznik
 * profilu), zeby oba widzialy ten sam tekst z dokladnoscia do sciezki profilu.
 */
export async function createNativeRewriter(
  homeDir: string,
  profileDir: string,
): Promise<NativeRewriter> {
  const nativeDir = join(homeDir, '.claude');
  const homeDirs = [nativeDir, await realpathLoose(nativeDir)];
  const patterns = new Map<string, RegExp>();
  const patternFor = (origin: string | undefined): RegExp => {
    const key = origin ?? '';
    let pattern = patterns.get(key);
    if (pattern === undefined) {
      pattern = nativeDirPattern(origin === undefined ? homeDirs : [...homeDirs, origin]);
      patterns.set(key, pattern);
    }
    return pattern;
  };
  return {
    apply(file, origin) {
      if (file.executable) return { file, count: 0 };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
      } catch {
        return { file, count: 0 };
      }
      if (text.includes('\0')) return { file, count: 0 };
      const result = rewriteNativeConfigRefs(text, patternFor(origin), profileDir);
      return result.count === 0
        ? { file, count: 0 }
        : { file: { ...file, bytes: encoder.encode(result.text) }, count: result.count };
    },
  };
}
