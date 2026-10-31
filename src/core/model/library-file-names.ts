/** Wzorzec pliku tymczasowego zapisu atomowego: `.<nazwa>.<pid>.<sufiks>.tmp`. Pid i sufiks odroznia go od `notes.tmp`. */
const ATOMIC_TEMP_NAME = /^\..+\.\d+\.[0-9a-z]{6,16}\.tmp$/;

export function isAtomicTempName(name: string): boolean {
  return ATOMIC_TEMP_NAME.test(name);
}

const JUNK_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/** Pliki, ktore system tworzy sam po otwarciu folderu; nie sa trescia elementu. */
export function isJunkFileName(name: string): boolean {
  return JUNK_FILE_NAMES.has(name.toLowerCase());
}

/** Nazwa pliku ze sciezki z `/`. */
export function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/**
 * Wpisy, ktore nie sa trescia elementu: pliki systemowe i osierocone pliki tymczasowe zapisu (dowolny segment).
 * Nie wchodza do draftu z dysku ani do odcisku stanu, ale kopia przed usunieciem je obejmuje.
 */
export function isIgnoredPath(relPath: string): boolean {
  return isJunkFileName(baseName(relPath)) || relPath.split('/').some(isAtomicTempName);
}
