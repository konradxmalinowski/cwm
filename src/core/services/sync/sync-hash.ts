import type { Sha256 } from '../../model/item';
import { sha256Bytes, sha256Text } from '../normalization/hash';

/**
 * Hash zawartosci materializacji dowiazania: plik to hash bajtow, katalog to hash spisu
 * `sciezka\0hash` posortowanego po sciezce (kolejnosc plikow w planie nie ma znaczenia).
 */
export function materialHash(
  content: Uint8Array | null,
  files: readonly { readonly relPath: string; readonly bytes: Uint8Array }[] | null,
): Sha256 {
  if (files === null) return sha256Bytes(content ?? new Uint8Array());
  const lines = files.map((f) => `${f.relPath}\0${sha256Bytes(f.bytes)}`).sort();
  return sha256Text(lines.join('\n'));
}

export function parentOf(relPath: string): string {
  const at = relPath.lastIndexOf('/');
  return at === -1 ? '' : relPath.slice(0, at);
}

export function nameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}
