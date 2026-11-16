import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  emptyEngineChecks,
  ENGINE_CHECKS_FILE_NAME,
  evaluateEngineHelp,
  formatEngineChecks,
  MAX_ENGINE_CHECKS_BYTES,
  parseEngineChecks,
  withEngineCheck,
  type EngineBinaryId,
  type EngineCheckEntry,
  type EngineCheckReport,
  type EngineChecksFile,
  type EngineMetadata,
} from '../../core/cwm';
import { collectEngineMetadata } from './engine-process';
import type { CwmLayout } from './layout';
import { readTextWithin } from './read';
import { makeScratchDir, removeScratchDir } from './runtime-fs';
import { sha256Hex } from './runtime-sources';
import { ensureScopedDirectory, homeScope, writeScopedFile } from './writer';

/**
 * Wyniki sprawdzen silnika (ADR 0052) leza w `~/.cwm/runtime/engine-checks.json`: sa wspolne dla firm,
 * bo dotycza pliku silnika, nie profilu. Odczyt i zapis przechodza przez te same straze co reszta
 * `~/.cwm` (bez dowiazan, atomowo, 0600).
 */
export const engineChecksFile = (layout: CwmLayout): string =>
  join(layout.runtimeDir, ENGINE_CHECKS_FILE_NAME);

export type EngineChecksRead =
  | { readonly state: 'ok'; readonly file: EngineChecksFile }
  | { readonly state: 'missing'; readonly file: EngineChecksFile }
  | { readonly state: 'invalid'; readonly file: EngineChecksFile; readonly message: string };

/** Brak albo uszkodzony plik to pusty zbior (CWM tylko ostrzega czesciej), nigdy blad startu. */
export async function readEngineChecks(layout: CwmLayout): Promise<EngineChecksRead> {
  const empty = emptyEngineChecks();
  const read = await readTextWithin(layout.home, engineChecksFile(layout), MAX_ENGINE_CHECKS_BYTES);
  if (!read.ok) {
    return read.reason === 'missing'
      ? { state: 'missing', file: empty }
      : {
          state: 'invalid',
          file: empty,
          message: `Plik wynikow sprawdzen jest nieczytelny: ${read.message}`,
        };
  }
  const parsed = parseEngineChecks(read.text);
  if (!parsed.ok) {
    return { state: 'invalid', file: empty, message: 'Plik wynikow sprawdzen jest niepoprawny.' };
  }
  return { state: 'ok', file: parsed.value };
}

export async function recordEngineCheck(
  layout: CwmLayout,
  base: EngineChecksFile,
  version: string,
  entry: EngineCheckEntry,
): Promise<void> {
  const scope = homeScope(layout.home);
  await ensureScopedDirectory(scope, layout.runtimeDir);
  await writeScopedFile(
    scope,
    engineChecksFile(layout),
    formatEngineChecks(withEngineCheck(base, version, entry)),
  );
}

export interface EngineCheckRun {
  readonly report: EngineCheckReport;
  /** Wpis do zapisu: tylko dla wyniku `ok` z wersja i plikiem. */
  readonly entry: EngineCheckEntry | null;
}

const hashOf = (text: string | null): string | null => (text === null ? null : sha256Hex(text));

/** Tozsamosc pliku silnika (sciezka po `realpath`, rozmiar, mtime); null, gdy nie da sie jej ustalic. */
export async function engineBinaryId(path: string): Promise<EngineBinaryId | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function entryFrom(
  meta: EngineMetadata,
  report: EngineCheckReport,
  binary: EngineBinaryId | null,
): EngineCheckEntry | null {
  if (report.verdict !== 'ok' || meta.help === null || binary === null) return null;
  return {
    binary,
    checkedAt: new Date().toISOString(),
    helpSha256: sha256Hex(meta.help),
    pluginHelpSha256: hashOf(meta.pluginHelp),
    mcpHelpSha256: hashOf(meta.mcpHelp),
    newSubcommands: report.newSubcommands,
    suspiciousFlags: report.suspiciousFlags,
  };
}

export interface EngineCheckOptions {
  /** Katalog projektu wycinany z `PATH` proby; null, gdy projektu nie ma. */
  readonly projectDir: string | null;
  /** Wersja ustalona przed sprawdzeniem; inna z `--version` w trakcie to `unverified`. */
  readonly expectedVersion?: string | null;
  /** Zastepuje limity czasu polecen (testy). */
  readonly timeoutMs?: number;
}

/**
 * Uruchamia cztery polecenia metadanych w pustym katalogu 0700 w `scratchParent` i ocenia wynik. Wpis wiaze
 * wynik z plikiem (tozsamosc z przed uruchomienia; zmiana pliku w trakcie to brak wpisu).
 */
export async function runEngineCheck(
  binary: string,
  scratchParent: string,
  options: EngineCheckOptions,
): Promise<EngineCheckRun> {
  const before = await engineBinaryId(binary);
  const scratch = await makeScratchDir(scratchParent);
  try {
    const meta = await collectEngineMetadata(
      binary,
      scratch,
      options.projectDir,
      options.timeoutMs,
    );
    const report = evaluateEngineHelp(meta, options.expectedVersion);
    const after = await engineBinaryId(binary);
    const same =
      before !== null &&
      after !== null &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs;
    return { report, entry: same ? entryFrom(meta, report, before) : null };
  } finally {
    await removeScratchDir(scratch);
  }
}
