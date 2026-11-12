import type { Command } from 'commander';

import {
  acquireMutex,
  invalidateGenerated,
  isSafeSegment,
  listApprovalCompanies,
  liveSessions,
  loadApprovals,
  loadWorkspace,
  peekRuntimeRoot,
  revokeApprovals,
} from '../../infra/cwm';
import {
  CliError,
  contextOf,
  print,
  printJson,
  table,
  usageError,
  warn,
  failure,
  type Context,
} from '../context';
import { requireInitialized } from './shared';

function checkCompany(id: string | undefined): void {
  if (id !== undefined && !isSafeSegment(id)) throw usageError('Niepoprawne id firmy.');
}

/** Sciezka projektu z pol zatwierdzenia pary projekt-firma (klucz ma tylko jej skrot). */
function pathOf(fields: unknown): string | null {
  const path = (fields as { path?: unknown } | null)?.path;
  return typeof path === 'string' ? path : null;
}

async function listCommand(ctx: Context, options: { company?: string }): Promise<void> {
  checkCompany(options.company);
  await requireInitialized(ctx.layout);
  const companies =
    options.company === undefined ? await listApprovalCompanies(ctx.layout) : [options.company];
  const rows: {
    company: string;
    key: string;
    hash: string;
    approvedAt: string;
    version: string | null;
    path: string | null;
  }[] = [];
  const corrupt: string[] = [];
  for (const company of companies) {
    const loaded = await loadApprovals(ctx.layout, company);
    if (loaded.state === 'corrupt') corrupt.push(`${company}: ${loaded.message}`);
    if (loaded.state !== 'ok') continue;
    for (const entry of loaded.file.entries) {
      rows.push({
        company,
        key: entry.key,
        hash: entry.hash,
        approvedAt: entry.approvedAt,
        version: entry.version,
        path: pathOf(entry.fields),
      });
    }
  }
  if (ctx.json) return printJson({ ok: corrupt.length === 0, approvals: rows, corrupt });
  if (rows.length === 0) print('Brak zatwierdzen.');
  else {
    print(
      table([
        ['FIRMA', 'KLUCZ', 'SHA256', 'WERSJA', 'DATA', 'SCIEZKA'],
        ...rows.map((r) => [
          r.company,
          r.key,
          r.hash.slice(0, 12),
          r.version ?? '-',
          r.approvedAt,
          r.path ?? '',
        ]),
      ]),
    );
  }
  for (const text of corrupt) warn(`Blad: ${text}`);
  if (corrupt.length > 0)
    throw failure('Uszkodzone pliki zatwierdzen: nic w nich nie jest zatwierdzone.');
}

interface RevokeOptions {
  readonly company?: string;
  readonly all?: boolean;
}

async function revokeCommand(
  ctx: Context,
  key: string | undefined,
  options: RevokeOptions,
): Promise<void> {
  checkCompany(options.company);
  if (options.all === true && (key !== undefined || options.company !== undefined)) {
    throw usageError('--all nie laczy sie z kluczem ani z --company.');
  }
  if (key === undefined && options.company === undefined && options.all !== true) {
    throw usageError('Podaj <klucz>, --company <id> albo --all.');
  }
  await requireInitialized(ctx.layout);

  const { outcomes, corrupt } = await revokeApprovals(ctx.layout, {
    ...(key === undefined ? {} : { key }),
    ...(options.company === undefined ? {} : { company: options.company }),
    ...(options.all === true ? { all: true } : {}),
  });
  const affected = new Set(outcomes.map((o) => o.company));
  if (options.company !== undefined) affected.add(options.company);
  if (options.all === true) {
    const workspace = await loadWorkspace(ctx.layout);
    for (const id of workspace.companyIds) affected.add(id);
  }

  const invalidated: {
    company: string;
    removed: number;
    cleaned: readonly string[];
    kept: readonly string[];
    liveSessions: number;
  }[] = [];
  for (const company of [...affected].sort()) {
    const root = await peekRuntimeRoot(ctx.layout, company);
    if (root === null) continue;
    const release = await acquireMutex(root);
    try {
      const live = (await liveSessions(root, true)).length;
      const result = await invalidateGenerated(root);
      invalidated.push({
        company,
        removed: result.removed,
        cleaned: result.cleaned,
        kept: result.kept,
        liveSessions: live,
      });
    } finally {
      await release();
    }
  }

  const incomplete = invalidated.some((item) => item.kept.length > 0);
  const failed = corrupt.length > 0 || incomplete;
  if (ctx.json) {
    printJson({ ok: !failed, revoked: outcomes, invalidated, corrupt });
    if (failed) throw new CliError('', 1);
    return;
  }
  const total = outcomes.reduce((sum, o) => sum + o.removed.length, 0);
  print(total === 0 ? 'Brak pasujacych zatwierdzen.' : `Odwolano zatwierdzen: ${total}.`);
  for (const outcome of outcomes) {
    for (const removed of outcome.removed) print(`  ${outcome.company}: ${removed}`);
  }
  for (const item of invalidated) {
    print(`Profil firmy ${item.company}: usunieto wygenerowanych plikow: ${item.removed}.`);
    for (const path of item.cleaned) {
      print(
        `  usunieto klucze CWM (hooks, permissions, env) z ${path}; kopia w generated/revoked/`,
      );
    }
    for (const path of item.kept) warn(`  ZOSTAJE (tresc CWM, nie dalo sie usunac): ${path}`);
    if (item.liveSessions > 0) {
      warn(
        `  Uwaga: dzialajaca sesja (${item.liveSessions}) nie traci wczytanych hookow ani serwerow MCP; zamknij ja.`,
      );
    }
  }
  for (const company of corrupt) warn(`Blad: plik zatwierdzen firmy ${company} jest uszkodzony.`);
  if (corrupt.length > 0) throw failure('Nie wszystkie pliki zatwierdzen dalo sie odczytac.');
  if (incomplete) {
    throw failure(
      'Odwolanie niepelne: w profilu zostaly tresci CWM (zob. wyzej). Usun je recznie.',
    );
  }
}

export function registerApprovals(program: Command): void {
  const approvals = program
    .command('approvals')
    .description('Zatwierdzenia zasobow z polami wykonawczymi (~/.cwm/approvals)');

  approvals
    .command('list')
    .description('Wypisuje zatwierdzenia (klucz, skrot, wersja, data)')
    .option('--company <id>', 'tylko jedna firma')
    .action(async (options: { company?: string }, command: Command) =>
      listCommand(contextOf(command), options),
    );

  approvals
    .command('revoke [klucz]')
    .description(
      'Odwoluje zatwierdzenie (klucz), wszystkie firmy (--company) albo wszystko (--all) i uniewaznia wygenerowany profil',
    )
    .option('--company <id>', 'firma, ktorej zatwierdzenia odwolac (z kluczem: tylko ta firma)')
    .option('--all', 'odwoluje wszystkie zatwierdzenia wszystkich firm')
    .action(async (key: string | undefined, options: RevokeOptions, command: Command) =>
      revokeCommand(contextOf(command), key, options),
    );
}
