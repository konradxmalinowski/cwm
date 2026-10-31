import type { BigIntStats, Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';

import { errnoCode } from './store-error';

/** `null`, gdy wpisu nie ma; wszystkie inne bledy ida dalej. Jedyna definicja w infra. */
export async function lstatOrNull(
  path: string,
  options?: { bigint?: false },
): Promise<Stats | null>;
export async function lstatOrNull(
  path: string,
  options: { bigint: true },
): Promise<BigIntStats | null>;
export async function lstatOrNull(
  path: string,
  options: { bigint?: boolean } = {},
): Promise<Stats | BigIntStats | null> {
  try {
    return options.bigint === true ? await lstat(path, { bigint: true }) : await lstat(path);
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}
