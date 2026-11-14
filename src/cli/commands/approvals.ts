import type { Command } from 'commander';

import {
  acquireMutex,
  invalidateGenerated,
  isSafeSegment,
  listApprovalCompanies,
  liveSessions,
  dropPackRecords,
  listTrustedPackIds,
  trustedExecKeys,
  loadApprovals,
  loadPackTrust,
  loadWorkspace,
  peekRuntimeRoot,
  revokeApprovals,
  revokePackTrust,
  splitPackId,
} from '../../infra/cwm';
import { packTrustDigest } from '../../core/cwm';
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
  const packRows: { pack: string; hash: string; approvedAt: string; members: number }[] = [];
  if (options.company === undefined) {
    for (const id of await listTrustedPackIds(ctx.layout)) {
      const loaded = await loadPackTrust(ctx.layout, id);
      if (loaded.state === 'corrupt') corrupt.push(`pakiet ${id}: ${loaded.message}`);
      if (loaded.state !== 'ok') continue;
      packRows.push({
        pack: id,
        hash: packTrustDigest(loaded.file),
        approvedAt:
          loaded.file.members
            .map((m) => m.approvedAt)
            .sort()
            .pop() ?? '',
        members: loaded.file.members.length,
      });
    }
  }
  if (ctx.json) {
    return printJson({ ok: corrupt.length === 0, approvals: rows, packs: packRows, corrupt });
  }
  if (rows.length === 0 && packRows.length === 0) print('Brak zatwierdzen.');
  else {
    print(
      table([
        ['FIRMA', 'KLUCZ', 'SHA256', 'WERSJA', 'DATA', 'SCIEZKA'],
        ...packRows.map((r) => [
          '(wszystkie)',
          `pack:${r.pack}`,
          r.hash.slice(0, 12),
          '-',
          r.approvedAt,
          `${r.members} zasobow`,
        ]),
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
  const packKey = key?.startsWith('pack:') === true ? key.slice('pack:'.length) : null;
  if (packKey !== null) {
    if (options.company !== undefined) {
      throw usageError('Zgoda pakietu nie nalezy do firmy: bez --company.');
    }
    if (splitPackId(packKey) === null)
      throw usageError('Niepoprawne id pakietu (pack:<przestrzen>/<nazwa>).');
  }
  await requireInitialized(ctx.layout);

  // Zgoda pakietu jest wspolna dla firm: odwolanie dotyka profili wszystkich firm.
  const revokedPacks: string[] = [];
  if (packKey !== null) {
    if (await revokePackTrust(ctx.layout, packKey)) revokedPacks.push(`pack:${packKey}`);
  } else if (options.all === true) {
    for (const id of await listTrustedPackIds(ctx.layout)) {
      if (await revokePackTrust(ctx.layout, id)) revokedPacks.push(`pack:${id}`);
    }
  }
  // Zasob zatwierdzony przez pakiet zostaje zatwierdzony po odwolaniu samego wpisu firmy (F2):
  // `revoke <klucz>` usuwa tez jego zaufany wpis w pakiecie, a `--company` ostrzega.
  const droppedFrom: string[] = [];
  if (key !== undefined && packKey === null && options.company === undefined) {
    droppedFrom.push(...(await dropPackRecords(ctx.layout, [key])));
  }
  const { outcomes, corrupt } =
    packKey !== null
      ? { outcomes: [], corrupt: [] as string[] }
      : await revokeApprovals(ctx.layout, {
          ...(key === undefined ? {} : { key }),
          ...(options.company === undefined ? {} : { company: options.company }),
          ...(options.all === true ? { all: true } : {}),
        });
  const affected = new Set(outcomes.map((o) => o.company));
  if (options.company !== undefined) affected.add(options.company);
  if (options.all === true || revokedPacks.length > 0 || droppedFrom.length > 0) {
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
    printJson({
      ok: !failed,
      revoked: outcomes,
      revokedPacks,
      revokedFromPacks: droppedFrom,
      invalidated,
      corrupt,
    });
    if (failed) throw new CliError('', 1);
    return;
  }
  const total =
    outcomes.reduce((sum, o) => sum + o.removed.length, 0) +
    revokedPacks.length +
    droppedFrom.length;
  for (const id of droppedFrom) print(`  (pakiet) zaufany wpis ${key ?? ''} usuniety z ${id}`);
  if (packKey === null && key === undefined && options.all !== true) {
    const covered = await trustedExecKeys(ctx.layout);
    if (covered.length > 0) {
      warn(
        `Uwaga: ${covered.length} zasobow z polami wykonawczymi nadal objetych zgoda pakietow (np. ${covered.slice(0, 5).join(', ')}). Odwolaj: cwm approvals revoke pack:<id> albo <klucz zasobu>.`,
      );
    }
  }
  if (packKey === null && key !== undefined && options.company !== undefined) {
    const covered = (await trustedExecKeys(ctx.layout)).filter((k) => k === key);
    if (covered.length > 0) {
      warn(`Uwaga: ${key} nadal objety zgoda pakietu; odwolaj bez --company albo pack:<id>.`);
    }
  }
  print(total === 0 ? 'Brak pasujacych zatwierdzen.' : `Odwolano zatwierdzen: ${total}.`);
  for (const pack of revokedPacks) print(`  (pakiet) ${pack}`);
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
    .description('Zatwierdzenia zasobow z polami wykonawczymi i pakietow (~/.cwm/approvals)');

  approvals
    .command('list')
    .description('Wypisuje zatwierdzenia (klucz, skrot, wersja, data) i zgody pakietow (pack:<id>)')
    .option('--company <id>', 'tylko jedna firma')
    .action(async (options: { company?: string }, command: Command) =>
      listCommand(contextOf(command), options),
    );

  approvals
    .command('revoke [klucz]')
    .description(
      'Odwoluje zatwierdzenie (klucz, takze pack:<id>), wszystkie firmy (--company) albo wszystko (--all) i uniewaznia wygenerowany profil',
    )
    .option('--company <id>', 'firma, ktorej zatwierdzenia odwolac (z kluczem: tylko ta firma)')
    .option('--all', 'odwoluje wszystkie zatwierdzenia wszystkich firm')
    .action(async (key: string | undefined, options: RevokeOptions, command: Command) =>
      revokeCommand(contextOf(command), key, options),
    );
}
