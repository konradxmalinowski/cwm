/** Wzorce i stale uzywane w kilku warstwach CWM; jedno zrodlo, zeby walidatory nie rozjechaly sie. */

export const HASH64 = /^[0-9a-f]{64}$/;
export const HASH16 = /^[0-9a-f]{16}$/;

/** Zmienne ustawiane przez CWM w srodowisku silnika; zadna lista firmy ich nie przywraca. */
export const CWM_OWNED_ENV: ReadonlySet<string> = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
]);
