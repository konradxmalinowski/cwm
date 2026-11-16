import { tmpdir } from 'node:os';

import {
  engineCheckWarnings,
  engineVersionState,
  missingFlagsMessage,
  uncheckedVersionWarning,
  type EngineCheckReport,
  type EngineVersionState,
} from '../core/cwm';
import {
  engineBinaryId,
  EXPECTED_ENGINE_VERSION,
  readEngineChecks,
  recordEngineCheck,
  runEngineCheck,
  tmpDirFor,
  type CwmLayout,
  type RuntimeRoot,
} from '../infra/cwm';

/**
 * Wspolna ocena wersji silnika dla `cwm start`, `cwm run`, `cwm diff` i `cwm lock` (ADR 0052). Wersja
 * przetestowana (`EXPECTED_ENGINE_VERSION`) i wersja z udanym sprawdzeniem nie dostaja ostrzezenia.
 * Tylko `start` i `run` bez `--dry-run` uruchamiaja sprawdzenie same i zapisuja wynik.
 */
export interface EngineGate {
  readonly state: EngineVersionState | null;
  readonly warnings: readonly string[];
  /** Powody odmowy startu: silnik nie ma flagi, ktora CWM mu podaje. */
  readonly blockers: readonly string[];
  readonly report: EngineCheckReport | null;
}

const NONE: EngineGate = { state: null, warnings: [], blockers: [], report: null };

/** Tylko odczyt: stan z zapisanych wynikow, bez uruchamiania silnika. */
export async function engineGateReadOnly(
  layout: CwmLayout,
  version: string | null,
  binary: string | null,
): Promise<EngineGate> {
  if (version === null) return NONE;
  const read = await readEngineChecks(layout);
  const id = binary === null ? null : await engineBinaryId(binary);
  const state = engineVersionState(version, EXPECTED_ENGINE_VERSION, read.file, id);
  const warnings =
    state === 'unchecked' || state === 'other-binary'
      ? [uncheckedVersionWarning(version, EXPECTED_ENGINE_VERSION)]
      : [];
  return { state, warnings, blockers: [], report: null };
}

/**
 * Jak `engineGateReadOnly`, a przy wersji bez wyniku uruchamia sprawdzenie (kilka sekund), zapisuje
 * wynik udanego i zwraca odmowe przy brakujacej fladze. Nieudane sprawdzenie nie jest zapisywane,
 * wiec nastepny start powtorzy je.
 */
export async function engineGateWithCheck(
  layout: CwmLayout,
  binary: string,
  version: string | null,
  root: RuntimeRoot | null,
  projectDir: string,
): Promise<EngineGate> {
  if (version === null) return NONE;
  const read = await readEngineChecks(layout);
  const id = await engineBinaryId(binary);
  const state = engineVersionState(version, EXPECTED_ENGINE_VERSION, read.file, id);
  if (state === 'expected' || state === 'checked')
    return { state, warnings: [], blockers: [], report: null };

  const unchecked = uncheckedVersionWarning(version, EXPECTED_ENGINE_VERSION);
  try {
    const parent = root === null ? tmpdir() : await tmpDirFor(root);
    const run = await runEngineCheck(binary, parent, { projectDir, expectedVersion: version });
    const { report } = run;
    if (report.verdict === 'missing-flags') {
      return { state, warnings: [], blockers: [missingFlagsMessage(report)], report };
    }
    const warnings = engineCheckWarnings(report);
    if (run.entry === null || report.version === null) {
      return { state, warnings: [...warnings, unchecked], blockers: [], report };
    }
    try {
      await recordEngineCheck(layout, read.file, report.version, run.entry);
    } catch {
      warnings.push(
        'Nie udalo sie zapisac wyniku sprawdzenia silnika; nastepny start powtorzy je.',
      );
    }
    return { state: 'checked', warnings, blockers: [], report };
  } catch {
    return { state, warnings: [unchecked], blockers: [], report: null };
  }
}
