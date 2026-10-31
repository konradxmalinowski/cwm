import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { CodedStoreError, StoreFailureCode } from '../../core/ports/store-failure';

import { lstatOrNull } from './stat';

export class NotRegularFileError extends Error implements CodedStoreError {
  constructor(
    readonly failureCode: StoreFailureCode = 'not-a-file',
    message = 'wpis nie jest zwyklym plikiem',
  ) {
    super(message);
    this.name = 'NotRegularFileError';
  }
}

/**
 * Jedyna funkcja odczytu plikow w infra. Czyta co najwyzej `limit` bajtow (alokacja zalezy od
 * limitu, nie od pliku na dysku); `truncated` mowi, ze plik byl wiekszy. Plik specjalny (FIFO)
 * nie moze zawiesic odczytu: `O_NONBLOCK` sprawia, ze `open` wraca od razu, a typ sprawdza `fstat`
 * na otwartym uchwycie, bez okna miedzy sprawdzeniem a otwarciem.
 *
 * Dowiazanie podlozone po `lstat`: na POSIX `O_NOFOLLOW` sprawia, ze `open` konczy sie ELOOP
 * (kod `symlink`). Windows nie ma `O_NOFOLLOW` w Node, wiec tam porownujemy tozsamosc (dev, ino)
 * pliku z `lstat` sprzed otwarcia z tozsamoscia otwartego uchwytu; podmiana na dowiazanie
 * w tym oknie wychodzi jako rozbieznosc. Nie jest to ochrona przed atakujacym z prawem zapisu
 * w katalogu, tylko przed przypadkowa zmiana, bo okno miedzy dwoma wywolaniami zostaje.
 */
export async function readBounded(
  path: string,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const posixFlags = (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const before = process.platform === 'win32' ? await lstatOrNull(path, { bigint: true }) : null;
  const handle = await open(path, constants.O_RDONLY | posixFlags);
  try {
    const info = await handle.stat();
    if (process.platform === 'win32' && before !== null) {
      const now = await handle.stat({ bigint: true });
      if (before.ino !== now.ino || before.dev !== now.dev) {
        throw new NotRegularFileError(
          'symlink',
          'wpis zmienil sie miedzy sprawdzeniem a otwarciem',
        );
      }
    }
    if (!info.isFile()) throw new NotRegularFileError();
    const { size } = info;
    const buffer = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      bytes: offset === buffer.length ? buffer : buffer.subarray(0, offset),
      truncated: size > limit,
    };
  } finally {
    await handle.close();
  }
}

export type CheckedRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'not-file' }
  | { readonly kind: 'too-large'; readonly size: number }
  | { readonly kind: 'other-size'; readonly size: number }
  | {
      readonly kind: 'ok';
      readonly bytes: Uint8Array;
      readonly truncated: boolean;
      readonly size: number;
    };

/**
 * Odczyt po `lstat` wspolny dla magazynow: wynik nazywa, co stoi pod sciezka, a wywolujacy mapuje to
 * na swoj typ bledu. `strict` odrzuca plik wiekszy niz `limit` bez czytania; `expectedSize` pomija
 * odczyt pliku o innym rozmiarze (nie moze miec tej samej tresci).
 */
export async function readChecked(
  path: string,
  limit: number,
  options: { readonly strict?: boolean; readonly expectedSize?: number } = {},
): Promise<CheckedRead> {
  const info = await lstatOrNull(path);
  if (info === null) return { kind: 'missing' };
  if (info.isSymbolicLink()) return { kind: 'symlink' };
  if (!info.isFile()) return { kind: 'not-file' };
  if (options.expectedSize !== undefined && info.size !== options.expectedSize) {
    return { kind: 'other-size', size: info.size };
  }
  if (options.strict === true && info.size > limit) return { kind: 'too-large', size: info.size };
  const { bytes, truncated } = await readBounded(path, limit);
  if (options.strict === true && truncated) return { kind: 'too-large', size: info.size };
  return { kind: 'ok', bytes, truncated, size: info.size };
}
