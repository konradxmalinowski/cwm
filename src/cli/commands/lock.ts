import type { Command } from 'commander';

import { compareLocks, formatLock, hasAnyDrift, type LockDocument } from '../../core/cwm';
import { denyNetwork, lockFileFor, readLock, writeLock } from '../../infra/cwm';
import { CliError, contextOf, failure, print, printJson, warn, type Context } from '../context';
import { engineGateReadOnly } from '../engine-flow';
import { currentLock, driftLines } from '../lock-flow';
import { detectEngine, prepareRun } from './start';

interface LockOptions {
  readonly project?: string;
  readonly check?: boolean;
}

/**
 * Liczy lockfile z tego samego rozwiazania i planu co `cwm start` (bez zapisu profilu, bez zatwierdzen,
 * bez sieci). Bez `--check` zapisuje go atomowo obok manifestu projektu; z `--check` tylko porownuje.
 */
async function lockCommand(ctx: Context, options: LockOptions): Promise<void> {
  const check = options.check === true;
  let doc: LockDocument;
  let engineWarnings: readonly string[];
  let prepared: Awaited<ReturnType<typeof prepareRun>>;
  try {
    prepared = await prepareRun(ctx, options.project, []);
    const engine = await detectEngine(prepared.company, prepared.projectDir);
    const engineVersion = engine.version;
    engineWarnings = (await engineGateReadOnly(ctx.layout, engineVersion, engine.path)).warnings;
    doc = currentLock({
      layout: ctx.layout,
      record: prepared.record,
      effective: prepared.effective,
      facts: prepared.plan.lockFacts,
      engineVersion,
      frozenFlag: false,
    });
  } catch (error: unknown) {
    // W `--check` kod 1 znaczy dryf, wiec blad ustawienia to kod 2 (jak w `cwm diff`).
    if (check && error instanceof CliError && error.exitCode === 1) {
      throw new CliError(error.message, 2);
    }
    throw error;
  }
  const { record } = prepared;
  const read = await readLock(ctx.layout, record);

  if (check) {
    if (read.state === 'missing') {
      const message = 'Brak lockfile. Utworz go: cwm lock';
      if (ctx.json) printJson({ ok: false, state: 'absent', error: message });
      throw new CliError(ctx.json ? '' : message, 2);
    }
    if (read.state === 'invalid') {
      if (ctx.json) printJson({ ok: false, state: 'invalid', error: read.message });
      throw new CliError(ctx.json ? '' : read.message, 2);
    }
    const drift = compareLocks(read.doc, doc);
    const differs = hasAnyDrift(drift);
    if (ctx.json) {
      printJson({
        ok: !differs,
        state: differs ? 'drift' : 'match',
        drift,
        warnings: engineWarnings,
      });
    } else if (differs) {
      print('Lockfile rozni sie od aktualnego stanu:');
      for (const line of driftLines(drift)) print(line);
      print('Zapisz aktualny stan: cwm lock');
    } else {
      print('Lockfile zgodny z aktualnym stanem.');
    }
    if (!ctx.json) for (const text of engineWarnings) warn(`Ostrzezenie: ${text}`);
    if (differs) throw new CliError('', 1);
    return;
  }

  if (read.state === 'invalid') {
    // Nie nadpisujemy pliku, ktorego nie rozumiemy: moze pochodzic z nowszej wersji CWM.
    throw failure(`${read.message} Usun plik recznie i uruchom cwm lock ponownie.`);
  }
  const text = formatLock(doc);
  const changed = read.state === 'missing' || read.text !== text;
  if (changed) await writeLock(ctx.layout, record, doc);
  const previous = read.state === 'ok' ? compareLocks(read.doc, doc) : null;
  if (ctx.json) {
    printJson({
      ok: true,
      written: changed,
      created: read.state === 'missing',
      file: lockFileFor(record),
      resources: doc.resources.length,
      engine: doc.engine,
      drift: previous,
      warnings: engineWarnings,
    });
    return;
  }
  if (!ctx.json) for (const text of engineWarnings) warn(`Ostrzezenie: ${text}`);
  if (!changed) {
    print(`Lockfile bez zmian (${doc.resources.length} zasobow).`);
    return;
  }
  print(
    `${read.state === 'missing' ? 'Zapisano' : 'Zaktualizowano'} lockfile: ${lockFileFor(record)} (${doc.resources.length} zasobow, silnik ${doc.engine.version ?? 'nieustalony'}).`,
  );
  if (previous !== null && hasAnyDrift(previous)) {
    print('Zmiany wzgledem poprzedniego lockfile:');
    for (const line of driftLines(previous)) print(line);
  }
}

export function registerLock(program: Command): void {
  program
    .command('lock')
    .description(
      'Zapisuje lockfile projektu (cwm.lock: wersje i skroty zasobow, wersja silnika) albo z --check porownuje go z aktualnym stanem (kod 1 przy dryfie)',
    )
    .option('--project <katalog>', 'katalog projektu (domyslnie biezacy, z szukaniem w gore)')
    .option('--check', 'tylko porownuje, nic nie zapisuje; kod 0 zgodny, 1 dryf, 2 blad')
    .action(async (options: LockOptions, command: Command) => {
      denyNetwork();
      return lockCommand(contextOf(command), options);
    });
}
