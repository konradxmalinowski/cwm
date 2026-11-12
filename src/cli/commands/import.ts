import { stat } from 'node:fs/promises';

import type { Command } from 'commander';

import {
  applyImportPlan,
  buildImportPlan,
  companyDir,
  isSafeSegment,
  listCompanyIds,
  scanClaudeSource,
  targetNamespace,
  WriteDeniedError,
  type ImportPlan,
  type ImportTarget,
  type PlanItem,
  type ReportItem,
} from '../../infra/cwm';
import { AtomicWriteError } from '../../infra/fs/atomic';
import { errnoCode } from '../../infra/fs/store-error';
import {
  contextOf,
  failure,
  print,
  printJson,
  table,
  usageError,
  warn,
  type Context,
} from '../context';
import { promptConfirm, promptSelect } from '../prompts';
import { requireInitialized } from './shared';

interface ImportOptions {
  readonly from?: string;
  readonly company?: string;
  readonly global?: boolean;
  readonly dryRun?: boolean;
}

const STATUS_LABEL = { new: 'nowy', changed: 'zmieniony', unchanged: 'bez zmian' } as const;
const REPORT_LIMIT = 40;

function describeWriteError(error: unknown): string {
  if (error instanceof WriteDeniedError) return error.message;
  if (error instanceof AtomicWriteError) return `zapis odrzucony: ${error.message}`;
  return `blad zapisu (${errnoCode(error) ?? 'nieznany'})`;
}

async function companyExists(ctx: Context, id: string): Promise<boolean> {
  try {
    return (await stat(companyDir(ctx.layout, id))).isDirectory();
  } catch {
    return false;
  }
}

/** IMP-11: bez terminala trzeba wskazac przestrzen; domyslne `global` udostepnialoby zasob wszystkim firmom. */
async function chooseTarget(ctx: Context, options: ImportOptions): Promise<ImportTarget> {
  if (options.company !== undefined && options.global === true) {
    throw usageError('Podaj --company <id> albo --global, nie oba naraz.');
  }
  if (options.global === true) return { scope: 'global' };
  if (options.company !== undefined) {
    if (!isSafeSegment(options.company)) throw usageError('Niepoprawne id firmy.');
    if (!(await companyExists(ctx, options.company))) {
      throw failure(`Firma "${options.company}" nie istnieje. Dodaj ja: cwm company add <id>`);
    }
    return { scope: 'company', company: options.company };
  }
  if (!ctx.interactive) {
    throw usageError(
      'Podaj --company <id> albo --global (bez terminala nie ma domyslnej przestrzeni).',
    );
  }
  const choice = await promptSelect('Dokad zaimportowac?', ['firma', 'global']);
  if (choice === 'global') return { scope: 'global' };
  const { ids } = await listCompanyIds(ctx.layout);
  if (ids.length === 0) throw failure('Brak firm. Dodaj firme: cwm company add <id>');
  return { scope: 'company', company: await promptSelect('Firma', ids) };
}

function remarks(item: PlanItem): string {
  const parts: string[] = [];
  if (item.status === 'changed' && item.changes.length > 0) {
    parts.push(`zmieniono: ${item.changes.join(', ')}`);
  }
  if (item.flags.allowedTools) parts.push('narzedzia (tools/allowed-tools)');
  if (item.flags.inlineCommands) parts.push('wstawki ! (polecenia przy wczytaniu)');
  return parts.join('; ');
}

function renderPlan(plan: ImportPlan, from: string): void {
  const where = plan.target.scope === 'global' ? 'global' : `firma ${plan.target.company}`;
  print(`Zrodlo: ${from}`);
  print(`Przestrzen: ${where}`);
  if (plan.items.length === 0) print('Brak zasobow do zaimportowania.');
  else {
    print('');
    print(
      table([
        ['RODZAJ', 'ID', 'STATUS', 'UWAGI'],
        ...plan.items.map((item) => [item.kind, item.id, STATUS_LABEL[item.status], remarks(item)]),
      ]),
    );
  }
  if (plan.items.length > 0) {
    print('');
    print('Pochodzenie (zrodlo po realpath, skrot kopiowanego drzewa):');
    for (const item of plan.items) {
      print(`  ${item.id}: ${item.source} sha256:${item.sha256}`);
    }
  }
  const report: ReportItem[] = [...plan.items.flatMap((item) => item.notes), ...plan.skipped];
  if (report.length > 0) {
    print('');
    print(`Raport (${report.length}):`);
    for (const entry of report.slice(0, REPORT_LIMIT)) print(`  ${entry.item}: ${entry.reason}`);
    if (report.length > REPORT_LIMIT)
      print(`  ... i ${report.length - REPORT_LIMIT} wiecej (uzyj --json)`);
  }
}

function planJson(plan: ImportPlan, from: string) {
  return {
    from,
    target: plan.target.scope === 'global' ? { scope: 'global' } : plan.target,
    namespace: targetNamespace(plan.target),
    items: plan.items.map((item) => ({
      kind: item.kind,
      id: item.id,
      status: item.status,
      changes: item.changes,
      flags: item.flags,
      notes: item.notes,
      source: item.source,
      sha256: item.sha256,
    })),
    skipped: plan.skipped,
  };
}

async function importClaude(ctx: Context, options: ImportOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  const target = await chooseTarget(ctx, options);

  const scan = await scanClaudeSource(options.from, { cwmHome: ctx.layout.home });
  if (!scan.ok) throw failure(scan.message);
  const plan = await buildImportPlan(ctx.layout, target, scan.candidates, scan.skipped);
  const pending = plan.items.filter((item) => item.status !== 'unchanged');

  if (options.dryRun === true) {
    if (ctx.json)
      return printJson({ ok: true, dryRun: true, written: false, ...planJson(plan, scan.from) });
    renderPlan(plan, scan.from);
    return print('\nTryb --dry-run: nic nie zapisano.');
  }

  if (pending.length > 0 && !ctx.interactive) {
    // Bez terminala nie ma kto zatwierdzic planu, a --yes nie istnieje: plan idzie na wyjscie, kod 1.
    const message =
      'Bez terminala import niczego nie zapisuje (plan wymaga zatwierdzenia). Uzyj --dry-run, by go zobaczyc.';
    if (ctx.json) {
      printJson({
        ok: false,
        dryRun: false,
        written: false,
        error: message,
        ...planJson(plan, scan.from),
      });
      process.exitCode = 1;
      return;
    }
    renderPlan(plan, scan.from);
    throw failure(message);
  }

  // Tu --json oznacza brak zmian do zapisania: z oczekujacymi zmianami zakonczylismy wyzej (ok:false, kod 1).
  if (ctx.json) {
    return printJson({ ok: true, dryRun: false, written: false, ...planJson(plan, scan.from) });
  }
  renderPlan(plan, scan.from);
  if (pending.length === 0) return print('\nBrak zmian do zapisania.');

  const written = pending.filter((item) => item.status === 'new').length;
  const replaced = pending.length - written;
  print('');
  const accepted = await promptConfirm(
    `Zapisac ${pending.length} zasobow do rejestru (${written} nowych, ${replaced} zmienionych)?`,
  );
  if (!accepted) throw failure('Przerwano, nic nie zapisano.');

  const results = await applyImportPlan(ctx.layout, plan, describeWriteError);
  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    if (result.ok) {
      print(`Zapisano ${result.kind} ${result.id}`);
      for (const warning of result.warnings) warn(`  uwaga: ${warning}`);
    } else warn(`Blad zapisu ${result.kind} ${result.id}: ${result.message ?? 'nieznany'}`);
  }
  print('');
  print(
    'Zasoby sa w rejestrze, ale nieaktywne: dodaj ich id do resources.optional (config.yaml) albo resources.enable (company.yaml), by weszly do konfiguracji.',
  );
  if (failed.length > 0)
    throw failure(`Nie zapisano ${failed.length} z ${results.length} zasobow.`);
}

export function registerImport(program: Command): void {
  const importCommand = program
    .command('import')
    .description('Import natywnej konfiguracji narzedzi do rejestru CWM (zrodlo tylko do odczytu)');
  importCommand
    .command('claude')
    .description(
      'Importuje skille, agentow, komendy i settings.json z katalogu Claude Code; nic nie jest uruchamiane',
    )
    .option(
      '--from <katalog>',
      'katalog zrodlowy (domyslnie ~/.claude), poza katalogiem danych CWM',
    )
    .option('--company <id>', 'zapisz w katalogu tej firmy (id <firma>/<nazwa>)')
    .option(
      '--global',
      'zapisz w rejestrze wspolnym (id global/<nazwa>), widocznym dla wszystkich firm',
    )
    .option('--dry-run', 'pokaz plan i raport, nic nie zapisuj')
    .action(async (options: ImportOptions, command: Command) =>
      importClaude(contextOf(command), options),
    );
}
