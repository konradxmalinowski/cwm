import type { Clock } from './clock';
import type { ItemId } from '../model/item';

export interface IdGenerator {
  next(): ItemId;
}

/** Zrodlo losowosci wstrzykiwane z zewnatrz, zeby testy byly deterministyczne. */
export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

function encodeBase32(value: bigint, length: number): string {
  let rest = value;
  let out = '';
  for (let i = 0; i < length; i++) {
    out = CROCKFORD.charAt(Number(rest & 31n)) + out;
    rest >>= 5n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

const RANDOM_BITS_MAX = (1n << 80n) - 1n;

/**
 * ULID z monotonicznoscia w obrebie jednej milisekundy: dwa id z tej samej
 * milisekundy rosna, wiec sortowanie po id zachowuje kolejnosc utworzenia.
 */
export function createUlidGenerator(clock: Clock, random: RandomBytes): IdGenerator {
  let lastTime = -1;
  let lastRandom = 0n;

  return {
    next(): ItemId {
      const time = clock.now().getTime();
      let randomPart: bigint;
      if (time <= lastTime) {
        // Zegar cofniety o kilka ms traktujemy jak te sama milisekunde.
        randomPart = lastRandom + 1n;
        if (randomPart > RANDOM_BITS_MAX) throw new Error('przepelnienie czesci losowej ULID');
      } else {
        randomPart = bytesToBigInt(random(10));
        lastTime = time;
      }
      lastRandom = randomPart;
      return (encodeBase32(BigInt(lastTime), 10) + encodeBase32(randomPart, 16)) as ItemId;
    },
  };
}
