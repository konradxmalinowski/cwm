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
  targetNamespace,
  withIncluded,
  WriteDeniedError,
  type ImportPlan,
  type ImportTarget,
  type PackImportPlan,
  type PlanFlagged,
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
import { renderExec } from '../pack-render';
import { promptConfirm, promptMultiSelect, promptSelect } from '../prompts';
import { requireInitialized } from './shared';

interface ImportOptions {
  readonly from?: string;
  readonly company?: string;
  readonly global?: boolean;
  readonly dryRun?: boolean;
  readonly includeFlagged?: readonly string[];
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

function flaggedLine(entry: PlanFlagged): string {
  const where = entry.line === null ? '' : ` (wiersz ${entry.line})`;
  const state = entry.hard ? 'zawsze pominiety' : entry.included ? 'dolaczony' : 'pominiety';
  return `${entry.path}${where}: ${entry.reason} [${state}]`;
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
  if (plan.flagged.length > 0) {
    const open = plan.flagged.filter((f) => !f.hard && !f.included).length;
    print('');
    print(
      `Oznaczone pliki (mozliwy sekret, ${plan.flagged.length}; do przegladu ${open}, twardych ${plan.flagged.filter((f) => f.hard).length}):`,
    );
    for (const entry of plan.flagged.slice(0, REPORT_LIMIT)) print(`  ${flaggedLine(entry)}`);
    if (plan.flagged.length > REPORT_LIMIT) {
      print(`  ... i ${plan.flagged.length - REPORT_LIMIT} wiecej (uzyj --json)`);
    }
    if (open > 0) print('  Dolaczenie: --include-flagged <sciezka> albo wybor na terminalu.');
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

const TRUST_LABEL = { approved: 'zatwierdzony', new: 'nowy', changed: 'zmieniony' } as const;
const DEFINITION_LABEL = { new: 'nowy', changed: 'zmieniony', same: 'bez zmian' } as const;

/** Zasoby z polami wykonawczymi, ktorych zgoda przy imporcie jest jeszcze do udzielenia. */
function approvalCount(packs: PackImportPlan): number {
  return packs.packs
    .flatMap((pack) => pack.members)
    .filter((member) => member.derived.facts.required && member.trust !== 'approved').length;
}

/** Pakiety i pola wykonawcze ich czlonkow w calosci: potwierdzenie importu jest zgoda (ADR 0044). */
function renderPacks(packs: PackImportPlan): void {
  if (packs.packs.length === 0 && packs.problems.length === 0) return;
  print('');
  print(
    'Pakiety (potwierdzenie importu zatwierdza je; cwm start nie pyta o zasoby, ktorych tresc i pola wykonawcze sie nie zmienily).',
  );
  print(
    '/cwm-pack-profile w polach to katalog profilu firmy, na ktory cwm start przepisuje odwolania do ~/.claude.',
  );
  for (const pack of packs.packs) {
    const required = pack.members.filter((member) => member.derived.facts.required);
    const plain = pack.members.length - required.length;
    print('');
    print(
      `  ${pack.id}: ${pack.members.length} zasobow, definicja ${DEFINITION_LABEL[pack.definition]}${pack.pending ? '' : ', zgoda aktualna'}`,
    );
    if (pack.corrupt !== null) {
      print(`    UWAGA: ${pack.corrupt} Zgody tego pakietu nie da sie zapisac.`);
    }
    if (plain > 0) print(`    ${plain} zasobow bez pol wykonawczych (tylko skrot drzewa)`);
    for (const member of required) {
      print(
        `    ${member.key} [${TRUST_LABEL[member.trust]}] sha256:${member.derived.facts.fields.tree.slice(0, 12)}`,
      );
      renderExec(member.derived.facts, '      ');
      for (const text of member.derived.facts.blockers) {
        print(
          `      UWAGA: zgoda pakietu go nie obejmie (${text}); cwm start zapyta o zgode firmy`,
        );
      }
      for (const rel of member.derived.profileRels) {
        const bound = member.derived.facts.fields.bindings.find((b) => b.rel === rel);
        const who =
          bound === undefined
            ? 'wlasny plik zasobu'
            : bound.owner === null
              ? 'wlasciciel ustalany przy starcie (cwm start zapyta, jesli go nie ma w pakiecie)'
              : `wlasciciel ${bound.owner}`;
        print(`      skrypt hooka w profilu: ${rel}: ${who}`);
      }
    }
  }
  for (const problem of packs.problems.slice(0, REPORT_LIMIT)) print(`  Pakiety: ${problem}`);
}

function packsJson(packs: PackImportPlan) {
  return packs.packs.map((pack) => ({
    id: pack.id,
    definition: pack.definition,
    pending: pack.pending,
    members: pack.members.map((member) => ({
      key: member.key,
      status: member.status,
      trust: member.trust,
      required: member.derived.facts.required,
      tree: member.derived.facts.fields.tree,
      exec: member.derived.facts.fields.exec,
      warnings: member.derived.facts.warnings,
    })),
  }));
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
    flagged: plan.flagged,
  };
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
