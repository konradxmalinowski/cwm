import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { extractHookPathTokens, type HookPathToken } from '../../core/cwm';
import { readChecked } from '../fs/bounded-read';

/** Skrypt hooka wiekszy niz to nie jest przypinany (IMP-08). */
export const MAX_PINNED_FILE_BYTES = 1024 * 1024;
const MAX_PINS = 200;

export type UnpinnedReason = 'variable' | 'missing' | 'not-file' | 'too-large' | 'symlink' | 'io';

export type PinStatus =
  | { readonly state: 'pinned'; readonly sha256: string }
  | { readonly state: 'unpinned'; readonly reason: UnpinnedReason };

export interface PinnedPath {
  readonly token: HookPathToken;
  readonly status: PinStatus;
}

const REASON_TEXT: Record<UnpinnedReason, string> = {
  variable: 'sciezka wyliczana ze zmiennej',
  missing: 'brak pliku',
  'not-file': 'to nie jest zwykly plik',
  'too-large': 'plik wiekszy niz 1 MiB',
  symlink: 'dowiazanie symboliczne',
  io: 'blad odczytu',
};

export function describeUnpinned(reason: UnpinnedReason): string {
  return `nieprzypiete: zatwierdzasz sciezke, nie tresc (${REASON_TEXT[reason]})`;
}

async function pinOne(token: HookPathToken, homeDir: string): Promise<PinStatus> {
  if (token.base === 'variable') return { state: 'unpinned', reason: 'variable' };
  const path = token.base === 'home' ? join(homeDir, token.rest) : resolve(token.rest);
  try {
    const read = await readChecked(path, MAX_PINNED_FILE_BYTES, { strict: true });
    switch (read.kind) {
      case 'missing':
        return { state: 'unpinned', reason: 'missing' };
      case 'symlink':
        return { state: 'unpinned', reason: 'symlink' };
      case 'not-file':
        return { state: 'unpinned', reason: 'not-file' };
      case 'too-large':
      case 'other-size':
        return { state: 'unpinned', reason: 'too-large' };
      case 'ok':
        return { state: 'pinned', sha256: createHash('sha256').update(read.bytes).digest('hex') };
    }
  } catch {
    return { state: 'unpinned', reason: 'io' };
  }
}

/**
 * Sciezki z polecen hookow (IMP-08, czesc [B]): kazda istniejaca sciezka do zwyklego pliku
 * ponizej 1 MiB dostaje `sha256` tresci, reszta jest oznaczona jako nieprzypieta. Tylko odczyt.
 * Ten sam kod liczy skroty przy zatwierdzaniu, wiec skrypt zmieniony po imporcie zmienia skrot.
 */
export async function pinHookCommands(
  commands: readonly string[],
  homeDir: string,
): Promise<{ readonly pins: PinnedPath[]; readonly dropped: number }> {
  const seen = new Set<string>();
  const pins: PinnedPath[] = [];
  let dropped = 0;
  for (const command of commands) {
    const scan = extractHookPathTokens(command);
    dropped += scan.dropped;
    for (const token of scan.tokens) {
      if (seen.has(token.raw)) continue;
      seen.add(token.raw);
      if (pins.length >= MAX_PINS) dropped += 1;
      else pins.push({ token, status: await pinOne(token, homeDir) });
    }
  }
  return { pins, dropped };
}
