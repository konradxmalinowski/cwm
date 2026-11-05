import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Kwarantanna pliku indeksu przed odbudowa (ADR 0029 punkt 2).
 *
 * Odbudowa nadpisuje plik, ktory moze zawierac dane, wiec jest operacja
 * destrukcyjna i obowiazuje ja warunek z ADR 0028: jesli nie da sie zrobic
 * kopii, operacja nie jest wykonywana. Dlatego ta funkcja rzuca, a wolajacy
 * ma wtedy **wstrzymac** odbudowe, a nie usunac plik i probowac dalej.
 *
 * Plik z kwarantanny nie jest nigdy usuwany automatycznie.
 */
export interface QuarantineResult {
  readonly directory: string;
  readonly movedFiles: readonly string[];
}

export class QuarantineError extends Error {
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'QuarantineError';
  }
}

const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export function quarantineIndex(
  dbPath: string,
  quarantineRoot: string,
  stamp: string,
): QuarantineResult {
  const target = join(quarantineRoot, `index-${stamp}.sqlite`);
  const moved: string[] = [];

  try {
    mkdirSync(quarantineRoot, { recursive: true });
    // ADR 0018: na POSIX zawezamy uprawnienia, na Windowsie nie udajemy chmod.
    if (process.platform !== 'win32') chmodSync(quarantineRoot, 0o700);

    renameSync(dbPath, target);
    moved.push(basename(target));
    if (process.platform !== 'win32') chmodSync(target, 0o600);

    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${dbPath}${suffix}`;
      if (!existsSync(sidecar)) continue;
      const sidecarTarget = `${target}${suffix}`;
      renameSync(sidecar, sidecarTarget);
      moved.push(basename(sidecarTarget));
      if (process.platform !== 'win32') chmodSync(sidecarTarget, 0o600);
    }
  } catch (error: unknown) {
    throw new QuarantineError(
      `nie udalo sie odlozyc indeksu do kwarantanny w ${quarantineRoot}`,
      error,
    );
  }

  return { directory: quarantineRoot, movedFiles: moved };
}

export interface QuarantineProbe {
  readonly indexFilePresent: boolean;
  readonly status: 'recoverable' | 'blocked';
  readonly reason: string | null;
}

/** Najblizszy istniejacy katalog nad `target`; tam zalozylibysmy brakujaca kwarantanne. */
function nearestExisting(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Sonda kwarantanny przed odbudowa (ADR 0030): sprawdza odczytem, czy plik indeksu da sie
 * przeniesc, bez przenoszenia i bez zakladania katalogow. Brak pliku nie blokuje: nie ma
 * czego odkladac. Sonda moze sie mylic w wyscigu z dyskiem, dlatego `apply` i tak idzie przez
 * `quarantineIndex`, ktory rzuca, gdy przeniesienie sie nie uda.
 */
export function probeQuarantine(dbPath: string, quarantineRoot: string): QuarantineProbe {
  const indexFilePresent = existsSync(dbPath);
  const blocked = (reason: string): QuarantineProbe => ({
    indexFilePresent,
    status: 'blocked',
    reason,
  });
  try {
    if (indexFilePresent) {
      accessSync(dbPath, constants.R_OK | constants.W_OK);
      accessSync(dirname(dbPath), constants.W_OK);
    }
    accessSync(nearestExisting(quarantineRoot), constants.W_OK);
  } catch {
    return blocked(
      'Nie można odłożyć obecnego indeksu do kwarantanny (brak uprawnień do zapisu w katalogu danych), więc odbudowa nie zostanie uruchomiona.',
    );
  }
  return { indexFilePresent, status: 'recoverable', reason: null };
}
