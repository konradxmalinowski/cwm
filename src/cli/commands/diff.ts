import type { Command } from 'commander';

import {
  diffRuntime,
  liveSessions,
  peekRuntimeRoot,
  type FileDiff,
  type PluginDiff,
  type RuntimeDiff,
  type RuntimePlan,
} from '../../infra/cwm';
import { CliError, contextOf, print, printJson, type Context } from '../context';
import {
  isPackPending,
  loadApprovalState,
  prepareRun,
  sessionConflicts,
  type PendingItem,
} from './start';

interface DiffOptions {
  readonly project?: string;
  readonly stat?: boolean;
}

interface ApprovalSummary {
  readonly total: number;
  readonly approved: number;
  readonly pending: number;
  /** Zasoby spoza pakietow albo wymagajace zgody tej firmy. */
  readonly pendingResources: readonly string[];
  /** Pakiety, w ktorych cos sie zmienilo od zaufanego skrotu: start zapyta raz na pakiet. */
  readonly packsToReapprove: readonly { pack: string; resources: number }[];
}

function summarizeApprovals(items: readonly PendingItem[]): ApprovalSummary {
  const pending = items.filter((item) => item.status !== 'approved');
  const packs = new Map<string, number>();
  for (const item of pending) {
    if (isPackPending(item) && item.verdict !== undefined) {
      packs.set(item.verdict.pack, (packs.get(item.verdict.pack) ?? 0) + 1);
    }
  }
  return {
    total: items.length,
    approved: items.length - pending.length,
    pending: pending.length,
    pendingResources: pending.filter((item) => !isPackPending(item)).map((i) => i.subject.key),
    packsToReapprove: [...packs].sort().map(([pack, resources]) => ({ pack, resources })),
  };
}

const size = (n: number | null): string => (n === null ? '-' : `${n} B`);
const short = (sha: string | null): string => (sha === null ? '-' : sha.slice(0, 12));

function counts(file: FileDiff): string {
  if (file.hidden !== null) return `tresc ukryta: ${file.hidden}`;
  if (file.modeOnly) return 'tylko tryb pliku';
  if (file.lines === null) return '';
  return `+${file.lines.added} -${file.lines.removed}${file.approximate ? ' (przyblizone)' : ''}`;
}

function renderFile(file: FileDiff, stat: boolean): void {
  const mark = { added: '+', changed: '~', removed: '-' }[file.status];
  const detail =
    file.status === 'added'
      ? `${size(file.newSize)}, sha256 ${short(file.newSha256)}`
      : file.status === 'removed'
        ? `${size(file.oldSize)}, sha256 ${short(file.oldSha256)}`
        : `${size(file.oldSize)} -> ${size(file.newSize)}, sha256 ${short(file.oldSha256)} -> ${short(file.newSha256)}`;
  print(`  ${mark} ${file.path}  (${detail})`);
  const extra = counts(file);
  if (extra !== '') print(`      ${extra}`);
  for (const note of file.notes) print(`      ${note}`);
  if (!stat && file.hunks !== null) for (const line of file.hunks) print(`      ${line}`);
}

function renderPlugin(plugin: PluginDiff): void {
  const mark = { added: '+', changed: '~', removed: '-' }[plugin.status];
  const name =
    plugin.status === 'added'
      ? (plugin.to ?? plugin.id)
      : plugin.status === 'removed'
        ? (plugin.from ?? plugin.id)
        : `${plugin.from ?? plugin.id} -> ${plugin.to ?? plugin.id}`;
  const { added, changed, removed } = plugin.files;
  print(`  ${mark} ${name}`);
  print(`      pliki: dodane ${added}, zmienione ${changed}, usuniete ${removed}`);
}

function group(title: string, files: readonly FileDiff[], stat: boolean): void {
  if (files.length === 0) return;
  print('');
  print(`${title} (${files.length}):`);
  for (const file of files) renderFile(file, stat);
}

function renderText(
  plan: RuntimePlan,
  diff: RuntimeDiff,
  approvals: ApprovalSummary,
  conflicts: readonly string[],
  stat: boolean,
  differs: boolean,
): void {
  print(`Firma: ${plan.company}`);
  print(`Projekt: ${plan.projectDir}`);
  print(
    `Profil (CLAUDE_CONFIG_DIR): ${plan.configDir}${diff.rootExists ? '' : ' (jeszcze nie istnieje)'}`,
  );
  const packs = approvals.packsToReapprove;
  print(
    `Zatwierdzenia: do zatwierdzenia ${approvals.pending} z ${approvals.total}` +
      (packs.length === 0
        ? ''
        : `; pakiety do ponownej zgody: ${packs.map((p) => `${p.pack} (${p.resources})`).join(', ')}`),
  );
  const outside = diff.files.filter((f) => f.status === 'changed' && f.outsideCwm);
  const inside = (status: FileDiff['status']): FileDiff[] =>
    diff.files.filter((f) => f.status === status && !(f.status === 'changed' && f.outsideCwm));
  group('Dodane', inside('added'), stat);
  group('Zmienione', inside('changed'), stat);
  group('Zmienione poza CWM (start je nadpisze, kopia w generated/prev)', outside, stat);
  group('Usuniete', inside('removed'), stat);
  if (diff.plugins.length > 0) {
    print('');
    print(`Pluginy (${diff.plugins.length}):`);
    for (const plugin of diff.plugins) renderPlugin(plugin);
  }
  if (diff.kept.length > 0) {
    print('');
    print(`Zostaja na miejscu (${diff.kept.length}):`);
    for (const item of diff.kept) print(`  ${item.path}: ${item.reason}`);
  }
  const problems = [...diff.blockers, ...conflicts];
  if (problems.length > 0) {
    print('');
    print(`Start zostalby odrzucony (${problems.length}):`);
    for (const text of problems) print(`  - ${text}`);
  }
  for (const text of diff.warnings) print(`Ostrzezenie: ${text}`);
  print('');
  const added = diff.files.filter((f) => f.status === 'added').length;
  const changed = diff.files.filter((f) => f.status === 'changed').length;
  const removed = diff.files.filter((f) => f.status === 'removed').length;
  print(
    `Razem: dodane ${added}, zmienione ${changed} (poza CWM ${outside.length}), usuniete ${removed}, pluginy ${diff.plugins.length}, bez zmian ${diff.unchanged}.`,
  );
  print(differs ? 'Start cos zmieni.' : 'Brak roznic: start nic nie zmieni.');
}

async function diffCommand(ctx: Context, options: DiffOptions): Promise<void> {
  let result: {
    plan: RuntimePlan;
    diff: RuntimeDiff;
    approvals: ApprovalSummary;
    conflicts: string[];
  };
  try {
    const { plan } = await prepareRun(ctx, options.project, []);
    const { items } = await loadApprovalState(ctx, plan);
    // Tylko odczyt: bez tworzenia katalogu firmy, bez zamka, bez usuwania znacznikow sesji.
    const root = await peekRuntimeRoot(ctx.layout, plan.company);
    const live = root === null ? [] : await liveSessions(root, false);
    const others = live.filter((marker) => marker.pid !== process.pid);
    const livePlugins = new Set(others.flatMap((marker) => marker.plugins ?? []));
    const diff = await diffRuntime(root, plan, { stat: options.stat === true, livePlugins });
    result = {
      plan,
      diff,
      approvals: summarizeApprovals(items),
      conflicts: sessionConflicts(live, plan),
    };
  } catch (error: unknown) {
    // Kod 1 oznacza tu "start cos zmieni", wiec kazdy blad ustawienia to kod 2.
    if (error instanceof CliError && error.exitCode === 1) throw new CliError(error.message, 2);
    throw error;
  }
  const { plan, diff, approvals, conflicts } = result;
  const stat = options.stat === true;
  const differs =
    diff.files.length > 0 ||
    diff.plugins.length > 0 ||
    diff.blockers.length > 0 ||
    conflicts.length > 0;
  if (ctx.json) {
    printJson({
      ok: true,
      differs,
      company: plan.company,
      project: plan.projectDir,
      profile: { dir: plan.configDir, exists: diff.rootExists, manifest: diff.manifestState },
      approvals,
      files: diff.files.map((file) => (stat ? { ...file, hunks: null } : file)),
      plugins: diff.plugins,
      kept: diff.kept,
      unchanged: diff.unchanged,
      blockers: [...diff.blockers, ...conflicts],
      warnings: diff.warnings,
    });
  } else {
    renderText(plan, diff, approvals, conflicts, stat, differs);
  }
  if (differs) throw new CliError('', 1);
}

export function registerDiff(program: Command): void {
  program
    .command('diff')
    .description(
      'Pokazuje, co zmieni najblizszy cwm start w profilu firmy (tylko odczyt; kod 1 gdy cos sie zmieni)',
    )
    .option('--project <katalog>', 'katalog projektu (domyslnie biezacy, z szukaniem w gore)')
    .option('--stat', 'tylko liczniki zmian, bez wierszy diffu')
    .action(async (options: DiffOptions, command: Command) =>
      diffCommand(contextOf(command), options),
    );
}
