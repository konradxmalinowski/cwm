import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { Command } from 'commander';

import {
  applyImportPlan,
  applyPackPlan,
  buildImportPlan,
  buildPackPlan,
  companyDir,
  isSafeSegment,
  listCompanyIds,
  scanClaudeSource,
  withIncluded,
  type ImportPlan,
  type ImportTarget,
  type PackImportPlan,
} from '../../infra/cwm';
import { contextOf, failure, print, printJson, usageError, warn, type Context } from '../context';
import {
  approvalCount,
  describeWriteError,
  flaggedLine,
  packsJson,
  planJson,
  renderPacks,
  renderPlan,
} from '../import-render';
import { promptConfirm, promptMultiSelect, promptSelect } from '../prompts';
import { requireInitialized } from './shared';

interface ImportOptions {
  readonly from?: string;
  readonly company?: string;
  readonly global?: boolean;
  readonly dryRun?: boolean;
  readonly includeFlagged?: readonly string[];
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

/** `--include-flagged` wskazuje plik z planu; nieznany albo twardy sekret to blad uzycia. */
function checkIncluded(
  requested: readonly string[],
  flagged: readonly { readonly path: string; readonly hard: boolean; readonly reason: string }[],
): ReadonlySet<string> {
  const byPath = new Map(flagged.map((f) => [f.path, f]));
  for (const path of requested) {
    const entry = byPath.get(path);
    if (entry === undefined) {
      throw usageError(
        `--include-flagged: "${path}" nie jest oznaczonym plikiem w tym planie (sciezka wzgledem --from, zobacz --dry-run).`,
      );
    }
    if (entry.hard) {
      throw usageError(
        `--include-flagged: "${path}" jest twardym sekretem (${entry.reason}) i nie moze byc dolaczony.`,
      );
    }
  }
  return new Set(requested);
}

async function importClaude(ctx: Context, options: ImportOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  const target = await chooseTarget(ctx, options);

  const scan = await scanClaudeSource(options.from, { cwmHome: ctx.layout.home });
  if (!scan.ok) throw failure(scan.message);
  const build = (included: ReadonlySet<string>): Promise<ImportPlan> =>
    buildImportPlan(
      ctx.layout,
      target,
      scan.candidates.map((candidate) => withIncluded(candidate, included)),
      scan.skipped,
    );
  const requested = options.includeFlagged ?? [];
  let included = checkIncluded(
    requested,
    scan.candidates.flatMap((candidate) =>
      candidate.flagged.map((f) => ({ path: f.path, hard: f.hard, reason: f.reason })),
    ),
  );
  let plan = await build(included);
  const buildPacks = (current: ImportPlan): Promise<PackImportPlan> =>
    buildPackPlan(ctx.layout, current, scan.from, homedir());
  let packs = await buildPacks(plan);
  let pending = plan.items.filter((item) => item.status !== 'unchanged');
  let packsPending = packs.packs.filter((pack) => pack.pending);
  const withPacks = (): ReturnType<typeof planJson> & { packs: ReturnType<typeof packsJson> } => ({
    ...planJson(plan, scan.from),
    packs: packsJson(packs),
  });

  if (options.dryRun === true) {
    if (ctx.json) return printJson({ ok: true, dryRun: true, written: false, ...withPacks() });
    renderPlan(plan, scan.from);
    renderPacks(packs);
    return print('\nTryb --dry-run: nic nie zapisano (ani zasobow, ani zgody pakietow).');
  }

  if ((pending.length > 0 || packsPending.length > 0) && !ctx.interactive) {
    // Bez terminala nie ma kto zatwierdzic planu, a --yes nie istnieje: plan idzie na wyjscie, kod 1.
    const message =
      'Bez terminala import niczego nie zapisuje (plan i zgoda pakietow wymagaja zatwierdzenia). Uzyj --dry-run, by go zobaczyc.';
    if (ctx.json) {
      printJson({ ok: false, dryRun: false, written: false, error: message, ...withPacks() });
      process.exitCode = 1;
      return;
    }
    renderPlan(plan, scan.from);
    renderPacks(packs);
    throw failure(message);
  }

  // Tu nie ma niczego do zapisania (ani zasobow, ani zgody pakietow).
  if (ctx.json) {
    return printJson({ ok: true, dryRun: false, written: false, ...withPacks() });
  }
  renderPlan(plan, scan.from);
  renderPacks(packs);
  if (!ctx.interactive) return print('\nBrak zmian do zapisania.');

  const choices = plan.flagged.filter((f) => !f.hard && !f.included);
  if (choices.length > 0) {
    print('');
    const picked = await promptMultiSelect(
      'Ktore oznaczone pliki dolaczyc do importu? (domyslnie zaden)',
      choices.map((f) => ({ value: f.path, label: flaggedLine(f) })),
    );
    if (picked.length > 0) {
      included = new Set([...included, ...picked]);
      plan = await build(included);
      packs = await buildPacks(plan);
      pending = plan.items.filter((item) => item.status !== 'unchanged');
      packsPending = packs.packs.filter((pack) => pack.pending);
      print('\nPlan po dolaczeniu wybranych plikow:');
      renderPlan(plan, scan.from);
      renderPacks(packs);
    }
  }
  if (pending.length === 0 && packsPending.length === 0) return print('\nBrak zmian do zapisania.');

  const approving = approvalCount(packs);
  const packText = `${packsPending.length} pakietow (${approving} zasobow z polami wykonawczymi do zatwierdzenia)`;
  const written = pending.filter((item) => item.status === 'new').length;
  const replaced = pending.length - written;
  print('');
  const accepted = await promptConfirm(
    pending.length === 0
      ? `Utworzyc i zatwierdzic ${packText}? Zasoby w rejestrze zostaja bez zmian.`
      : `Zapisac ${pending.length} zasobow do rejestru (${written} nowych, ${replaced} zmienionych)` +
          (packsPending.length === 0 ? '?' : ` i zatwierdzic ${packText}?`),
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
  let packFailure: string | null = null;
  try {
    for (const outcome of await applyPackPlan(ctx.layout, packs, homedir())) {
      print(`Pakiet ${outcome.id}: zatwierdzono ${outcome.approved} zasobow`);
      for (const key of outcome.skipped) {
        warn(
          `  bez zgody pakietu (tresc w rejestrze rozni sie od planu albo zapis sie nie udal): ${key}`,
        );
      }
    }
  } catch (error: unknown) {
    packFailure = `Nie zapisano zgody pakietow: ${describeWriteError(error)}`;
    warn(packFailure);
  }
  print('');
  print(
    'Zasoby sa w rejestrze, ale nieaktywne: dodaj ich id do resources.optional (config.yaml) albo resources.enable (company.yaml), by weszly do konfiguracji.',
  );
  if (failed.length > 0)
    throw failure(`Nie zapisano ${failed.length} z ${results.length} zasobow.`);
  if (packFailure !== null) throw failure(packFailure);
}

export function registerImport(program: Command): void {
  const importCommand = program
    .command('import')
    .description('Import natywnej konfiguracji narzedzi do rejestru CWM (zrodlo tylko do odczytu)');
  importCommand
    .command('claude')
    .description(
      'Importuje skille, agentow, komendy, wspolne pliki i settings.json z katalogu Claude Code; nic nie jest uruchamiane',
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
    .option(
      '--include-flagged <sciezka>',
      'dolacz plik oznaczony jako mozliwy sekret (sciezka wzgledem --from, powtarzalne); twardych sekretow nie da sie dolaczyc',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--dry-run', 'pokaz plan i raport, nic nie zapisuj')
    .action(async (options: ImportOptions, command: Command) =>
      importClaude(contextOf(command), options),
    );
}
