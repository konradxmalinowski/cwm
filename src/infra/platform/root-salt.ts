import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { writeFileAtomic } from '../fs/atomic';
import { readBounded } from '../fs/bounded-read';
import { errnoCode } from '../fs/store-error';

const SALT_BYTES = 32;

/**
 * Sol identyfikatorow lokalizacji (`rootId`), trwala w `userData`. Stan synchronizacji i kopie w
 * `backups/` zapisuja `rootId`, wiec bez stalej soli po restarcie nie wskazywalyby zadnego roota.
 * Przy bledzie zapisu wraca sol jednorazowa: aplikacja dziala, ale zapisane `rootId` sie nie
 * odnajda (stan synchronizacji wygladalby na utracony, co ADR 0014 dopuszcza).
 */
export async function loadRootSalt(userDataDir: string): Promise<Uint8Array> {
  const file = join(userDataDir, 'root-salt');
  try {
    const { bytes, truncated } = await readBounded(file, SALT_BYTES + 1);
    if (!truncated && bytes.length === SALT_BYTES) return bytes;
  } catch (error: unknown) {
    if (errnoCode(error) !== 'ENOENT') return new Uint8Array(randomBytes(SALT_BYTES));
  }
  const fresh = new Uint8Array(randomBytes(SALT_BYTES));
  try {
    await writeFileAtomic(file, fresh, { mode: 0o600 });
  } catch {
    // Sol jednorazowa: patrz komentarz funkcji.
  }
  return fresh;
}
