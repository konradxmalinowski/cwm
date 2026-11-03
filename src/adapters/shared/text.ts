import { normalizeToLf } from '../../core/services/normalization/line-endings';

const UTF8_BOM = '﻿';

export class TextDecodeError extends Error {
  constructor() {
    super('Plik nie jest poprawnym tekstem UTF-8.');
    this.name = 'TextDecodeError';
  }
}

/**
 * Dekoduje w trybie `fatal`: plik binarny podany jako `.md` ma dac jasny blad, a nie tekst
 * z znakami zastepczymi, ktory zaimportowalby sie po cichu jako smiecie.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TextDecodeError();
  }
}

/** BOM zostaje w snapshocie (bajty), ale nie moze sie dostac do tresci ani zepsuc detekcji `---`. */
export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/** Tekst gotowy do parsowania: bez BOM, z koncami linii LF. Szkic jest wtedy taki sam dla CRLF i LF. */
export function toParsableText(bytes: Uint8Array): string {
  return normalizeToLf(stripBom(decodeUtf8(bytes)));
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
