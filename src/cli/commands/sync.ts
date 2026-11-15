import { homedir } from 'node:os';

import type { Command } from 'commander';

import {
  applySyncPlan,
  buildSyncPlan,
  rebuildSyncSource,
  SyncError,
  type SyncPlan,
  type SyncRemoval,
  type SyncSourcePlan,
  denyNetwork,
} from '../../infra/cwm';
import { contextOf, failure, print, printJson, table, warn, type Context } from '../context';
import {
  approvalCount,
  describeWriteError,
  flaggedLine,
  packsJson,
  planJson,
  renderPacks,
  renderPlan,
} from '../import-render';
import { promptConfirm, promptMultiSelect } from '../prompts';
import { requireInitialized } from './shared';

interface SyncOptions {
  readonly source?: string;
  readonly dryRun?: boolean;
}

const changedItems = (source: SyncSourcePlan) =>
  source.plan?.items.filter((item) => item.status !== 'unchanged') ?? [];
const pendingPacks = (source: SyncSourcePlan) =>
  source.packs?.packs.filter((pack) => pack.pending) ?? [];

function hasChanges(plan: SyncPlan): boolean {
  return (
    plan.removals.length > 0 ||
    plan.sources.some(
      (source) => changedItems(source).length > 0 || pendingPacks(source).length > 0,
    )
  );
}

function sourceJson(source: SyncSourcePlan) {
  return {
    from: source.from,
    namespace: source.namespace,
    state: source.state,
    message: source.message,
    incomplete: source.incomplete,
    autoIncluded: source.autoIncluded,
    changedFlagged: source.changedFlagged,
    ...(source.plan === null ? {} : planJson(source.plan, source.from)),
    ...(source.packs === null ? {} : { packs: packsJson(source.packs) }),
  };
}

function removalJson(removal: SyncRemoval) {
  return {
    kind: removal.kind,
    id: removal.id,
    from: removal.from,
    reason: removal.reason,
    refs: removal.refs,
    blockedBy: removal.blockedBy,
  };
}

function planBody(plan: SyncPlan) {
  return {
    sources: plan.sources.map(sourceJson),
    removals: plan.removals.map(removalJson),
    warnings: plan.warnings,
    blocked: plan.blocked,
  };
}

function renderSource(source: SyncSourcePlan): void {
  print('');
  if (source.state !== 'ok' || source.plan === null || source.packs === null) {
    print(`Zrodlo: ${source.from}`);
    print(`Przestrzen: ${source.namespace === 'global' ? 'global' : `firma ${source.namespace}`}`);
    if (source.state === 'missing') {
      print(
        `${source.message ?? 'Katalog zrodlowy nie istnieje.'} Zasoby z tego zrodla trafiaja do sekcji usuniec.`,
      );
    } else print(`BLAD: ${source.message ?? 'zrodla nie da sie przejrzec'}; zasoby bez zmian.`);
    return;
  }
  const changed = changedItems(source);
  renderPlan({ ...source.plan, items: changed }, source.from, 'Brak zmian w zasobach.');
  const unchanged = source.plan.items.length - changed.length;
  if (unchanged > 0) print(`Bez zmian: ${unchanged} zasobow.`);
  if (source.message !== null) print(`UWAGA: ${source.message}`);
  if (source.autoIncluded.length > 0) {
    print('Oznaczone pliki dolaczone bez pytania (sa w rejestrze z tym samym skrotem):');
    for (const path of source.autoIncluded) {
      const entry = source.plan.flagged.find((f) => f.path === path);
      print(`  ${entry === undefined ? path : flaggedLine(entry)}`);
    }
  }
  if (source.changedFlagged.length > 0) {
    print(
      `Oznaczone pliki zmienione w zrodle od dolaczenia (wymagaja nowej decyzji, domyslnie pomijane): ${source.changedFlagged.join(', ')}`,
    );
  }
  renderPacks({ ...source.packs, packs: pendingPacks(source) });
}

function renderRemovals(plan: SyncPlan): void {
  if (plan.removals.length > 0) {
    print('');
    print(
      `Do usuniecia z rejestru (zrodlo zniklo, ${plan.removals.length}): kopia w rejestrze znika razem z wpisami w config.yaml, firmach, pakietach i zatwierdzeniach. Zrodlo natywne nie jest zmieniane.`,
    );
    print(
      table([
        ['RODZAJ', 'ID', 'ZRODLO', 'ODWOLANIA'],
        ...plan.removals.map((removal) => [
          removal.kind,
          removal.id,
          removal.reason === 'directory' ? 'brak katalogu' : 'brak wpisu',
          removal.refs.join('; '),
        ]),
      ]),
    );
    for (const removal of plan.removals) {
      for (const reason of removal.blockedBy) {
        print(`  BLAD: ${removal.kind}:${removal.id}: ${reason}`);
      }
    }
  }
  for (const text of plan.warnings) print(`UWAGA: ${text}`);
}

function renderAll(plan: SyncPlan): void {
  for (const source of plan.sources) renderSource(source);
  renderRemovals(plan);
}

const problemText = (plan: SyncPlan): string | null => {
  if (plan.blocked) {
    return 'Usuniecie zablokowane (zob. BLAD wyzej): nic nie zapisano. Popraw odwolania i ponow cwm sync.';
  }
  if (plan.sources.some((source) => source.state === 'error')) {
    return 'Czesci zrodel nie dalo sie przejrzec (zob. BLAD wyzej).';
  }
  return null;
};

async function pickFlagged(ctx: Context, plan: SyncPlan): Promise<SyncPlan> {
  const sources: SyncSourcePlan[] = [];
  for (const source of plan.sources) {
    const choices = source.plan?.flagged.filter((f) => !f.hard && !f.included) ?? [];
    if (source.plan === null || choices.length === 0) {
      sources.push(source);
      continue;
    }
    print('');
    print(`Zrodlo ${source.from} (${source.namespace}):`);
    const picked = await promptMultiSelect(
      'Ktore oznaczone pliki dolaczyc? (domyslnie zaden)',
      choices.map((f) => ({ value: f.path, label: flaggedLine(f) })),
    );
    if (picked.length === 0) {
      sources.push(source);
      continue;
    }
    const rebuilt = await rebuildSyncSource(ctx.layout, source, new Set(picked), homedir());
    sources.push(rebuilt);
    print('\nPlan po dolaczeniu wybranych plikow:');
    renderSource(rebuilt);
  }
  return { ...plan, sources };
}

async function syncCommand(ctx: Context, options: SyncOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  let plan: SyncPlan;
  try {
    plan = await buildSyncPlan(ctx.layout, {
      ...(options.source === undefined ? {} : { source: options.source }),
      homeDir: homedir(),
    });
  } catch (error: unknown) {
    if (error instanceof SyncError) throw failure(error.message);
    throw error;
  }
  const problem = problemText(plan);
  const dryRun = options.dryRun === true;

  if (dryRun || problem !== null) {
    if (ctx.json) {
      printJson({
        ok: problem === null,
        dryRun,
        written: false,
        error: problem,
        ...planBody(plan),
      });
      if (problem !== null) process.exitCode = 1;
      return;
    }
    renderAll(plan);
    if (problem !== null) throw failure(problem);
    return print(
      '\nTryb --dry-run: nic nie zapisano (ani zasobow, ani usuniec, ani zgody pakietow).',
    );
  }

  if (!hasChanges(plan)) {
    if (ctx.json) return printJson({ ok: true, dryRun: false, written: false, ...planBody(plan) });
    renderAll(plan);
    return print('\nBrak zmian do zapisania.');
  }
  if (!ctx.interactive) {
    const message =
      'Bez terminala sync niczego nie zapisuje (plan wymaga zatwierdzenia). Uzyj --dry-run, by go zobaczyc.';
    if (ctx.json) {
      printJson({ ok: false, dryRun: false, written: false, error: message, ...planBody(plan) });
      process.exitCode = 1;
      return;
    }
    renderAll(plan);
    throw failure(message);
  }

  renderAll(plan);
  plan = await pickFlagged(ctx, plan);
  const items = plan.sources.flatMap(changedItems);
  const packs = plan.sources.flatMap(pendingPacks);
  if (items.length === 0 && packs.length === 0 && plan.removals.length === 0) {
    return print('\nBrak zmian do zapisania.');
  }
  const created = items.filter((item) => item.status === 'new').length;
  const approving = plan.sources.reduce(
    (sum, source) => sum + (source.packs === null ? 0 : approvalCount(source.packs)),
    0,
  );
  const parts: string[] = [];
  if (items.length > 0) {
    parts.push(
      `zapisac ${items.length} zasobow (${created} nowych, ${items.length - created} zmienionych)`,
    );
  }
  if (plan.removals.length > 0) {
    parts.push(
      `usunac ${plan.removals.length} zasobow z rejestru (i z config.yaml, firm, pakietow, zatwierdzen)`,
    );
  }
  if (packs.length > 0) {
    parts.push(`zatwierdzic ${packs.length} pakietow (${approving} z polami wykonawczymi)`);
  }
  print('');
  const accepted = await promptConfirm(`${parts.join(', ')}?`);
  if (!accepted) throw failure('Przerwano, nic nie zapisano.');

  const result = await applySyncPlan(ctx.layout, plan, homedir(), describeWriteError);
  for (const entry of result.imports) {
    if (entry.ok) {
      print(`Zapisano ${entry.kind} ${entry.id}`);
      for (const text of entry.warnings) warn(`  uwaga: ${text}`);
    } else warn(`Blad zapisu ${entry.kind} ${entry.id}: ${entry.message ?? 'nieznany'}`);
  }
  for (const outcome of result.packs) {
    print(`Pakiet ${outcome.id}: zatwierdzono ${outcome.approved} zasobow`);
    for (const key of outcome.skipped) {
      warn(
        `  bez zgody pakietu (tresc w rejestrze rozni sie od planu albo zapis sie nie udal): ${key}`,
      );
    }
  }
  for (const edit of result.listEdits) {
    print(`${edit.label}: wycieto ${edit.removed.length} odwolan (${edit.removed.join(', ')})`);
  }
  if (result.packRemoval !== null) {
    for (const id of result.packRemoval.changed) print(`Pakiet ${id}: usunieto zasoby`);
    for (const id of result.packRemoval.emptied) print(`Pakiet ${id}: pusty, usuniety`);
  }
  if (result.approvalCompanies.length > 0) {
    print(`Zatwierdzenia firm wyczyszczone: ${result.approvalCompanies.join(', ')}`);
  }
  for (const entry of result.removed) if (entry.ok) print(`Usunieto ${entry.key}`);
  if (created > 0) {
    print('');
    print(
      'Nowe zasoby sa w rejestrze, ale nieaktywne: dodaj ich id do resources.optional (config.yaml) albo resources.enable (company.yaml), by weszly do konfiguracji.',
    );
  }
  for (const text of result.failures) warn(`Blad: ${text}`);
  if (result.failures.length > 0)
    throw failure(`Sync zakonczony z bledami (${result.failures.length}).`);
  const leftover = problemText(plan);
  if (leftover !== null) throw failure(leftover);
}

export function registerSync(program: Command): void {
  program
    .command('sync')
    .description(
      'Odswieza rejestr z natywnych katalogow, z ktorych zasoby zaimportowano (zmiany, nowe, usuniete); zrodlo tylko do odczytu',
    )
    .option('--source <katalog>', 'tylko zasoby zaimportowane z tego katalogu (--from importu)')
    .option('--dry-run', 'pokaz plan, nic nie zapisuj')
    .action(async (options: SyncOptions, command: Command) => {
      denyNetwork();
      return syncCommand(contextOf(command), options);
    });
}
