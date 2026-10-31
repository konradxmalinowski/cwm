import { createHash } from 'node:crypto';

import type { Sha256 } from '../../model/item';

// `node:crypto` nie jest zakazany w core: eslint.config.mjs blokuje fs, procesy, electron i sterownik bazy.
export function sha256Bytes(bytes: Uint8Array): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

export function sha256Text(text: string): Sha256 {
  return sha256Bytes(new TextEncoder().encode(text));
}
