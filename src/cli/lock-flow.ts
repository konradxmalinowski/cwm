import {
  buildLock,
  compareLocks,
  escapeControlChars,
  hasAnyDrift,
  hasResourceDrift,
  summarizeDrift,
  type EffectiveConfiguration,
  type LockDocument,
  type LockDrift,
  type LockFact,
} from '../core/cwm';
import { readLock, type CwmLayout, type ProjectRecord } from '../infra/cwm';

/**
 * Wspolna ocena lockfile dla `cwm start`, `cwm run`, `cwm diff` i `cwm lock` (ADR 0051). Nie zapisuje
 * niczego i nie uruchamia silnika: wersje silnika podaje wywolujacy.
 */
export type LockState = 'absent' | 'match' | 'drift' | 'invalid';

export interface LockReport {
  readonly state: LockState;
  /** `--frozen` albo `spec.lock: frozen`: dryf zasobow, brak i uszkodzenie lockfile to odmowa. */
  readonly frozen: boolean;
  readonly drift: LockDrift | null;
  readonly error: string | null;
  /** Powody odmowy startu. */
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface LockInput {
  readonly layout: CwmLayout;
  readonly record: ProjectRecord;
  readonly effective: EffectiveConfiguration;
  readonly facts: readonly LockFact[];
  readonly engineVersion: string | null;
  readonly frozenFlag: boolean;
}

export const isFrozen = (record: ProjectRecord, flag: boolean): boolean =>
  flag || (record.loaded.ok && record.loaded.value.spec.lock === 'frozen');

export const currentLock = (input: LockInput): LockDocument =>
  buildLock({
    effective: input.effective,
    facts: input.facts,
    engineVersion: input.engineVersion,
  });

export async function evaluateLock(input: LockInput): Promise<LockReport> {
  const frozen = isFrozen(input.record, input.frozenFlag);
  const read = await readLock(input.layout, input.record);
  if (read.state === 'missing') {
    return {
      state: 'absent',
      frozen,
      drift: null,
      error: null,
      blockers: frozen ? ['Tryb frozen wymaga lockfile, a go nie ma. Utworz go: cwm lock'] : [],
      warnings: [],
    };
  }
  if (read.state === 'invalid') {
    const hint = `${read.message} Usun plik recznie i uruchom cwm lock ponownie.`;
    return {
      state: 'invalid',
      frozen,
      drift: null,
      error: read.message,
      // Bez frozen uszkodzony lockfile tylko ostrzega (nie blokuje pracy); frozen odmawia (ADR 0051).
      blockers: frozen ? [hint] : [],
      warnings: frozen ? [] : [hint],
    };
  }
  const drift = compareLocks(read.doc, currentLock(input));
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (hasResourceDrift(drift)) {
    const text = `dryf wzgledem lockfile (${summarizeDrift(drift)})`;
    if (frozen) {
      blockers.push(
        `Lockfile zamrozony: ${text}. Lista: cwm lock --check; zapis aktualnego stanu: cwm lock`,
      );
    } else {
      warnings.push(`Lockfile: ${text}. Lista: cwm lock --check; zapis aktualnego stanu: cwm lock`);
    }
  }
  if (drift.engine !== null) {
    warnings.push(
      `Wersja silnika ${drift.engine.current} rozni sie od zapisanej w lockfile (${drift.engine.locked}).`,
    );
  }
  return {
    state: hasAnyDrift(drift) ? 'drift' : 'match',
    frozen,
    drift,
    error: null,
    blockers,
    warnings,
  };
}

/** Tekst z lockfile do terminala: znaki sterujace zapisane jawnie, dlugosc ograniczona. */
const shown = (text: string): string => {
  const safe = escapeControlChars(text);
  return safe.length > 120 ? `${safe.slice(0, 120)}...` : safe;
};

/** Linie opisu dryfu do terminala; pola z lockfile sa walidowane wzorcami, a tu dodatkowo czyszczone. */
export function driftLines(drift: LockDrift): string[] {
  const lines: string[] = [];
  for (const text of drift.identity) lines.push(`  ~ ${shown(text)}`);
  for (const change of drift.resources) {
    const mark = { added: '+', removed: '-', changed: '~' }[change.change];
    lines.push(
      shown(
        `  ${mark} ${change.key}${change.details.length === 0 ? '' : `: ${change.details.join('; ')}`}`,
      ),
    );
  }
  if (drift.engine !== null) {
    lines.push(shown(`  silnik: ${drift.engine.locked} -> ${drift.engine.current}`));
  }
  return lines;
}

/** Skrot stanu do dokumentow JSON. */
export function lockJson(report: LockReport): Record<string, unknown> {
  return {
    state: report.state,
    frozen: report.frozen,
    error: report.error,
    drift: report.drift,
    blockers: report.blockers,
    warnings: report.warnings,
  };
}

const STATE_TEXT: Record<LockState, string> = {
  absent: 'brak lockfile',
  match: 'zgodny',
  drift: 'dryf',
  invalid: 'uszkodzony',
};

export function lockSummaryLines(report: LockReport): string[] {
  const head = `Lockfile: ${STATE_TEXT[report.state]}${report.frozen ? ' (frozen)' : ''}`;
  const detail =
    report.drift === null || !hasAnyDrift(report.drift) ? [] : driftLines(report.drift);
  return [head, ...(report.error === null ? [] : [`  ${report.error}`]), ...detail];
}
