import { lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  buildChildEnv,
  buildEngineArgv,
  checkPassThroughArgs,
  diffFields,
  statusOf,
  type ApprovalsFile,
  type ApprovalSubject,
  type ChildEnv,
  type FieldChange,
} from '../../core/cwm';
import {
  acquireMutex,
  applyPlan,
  assertProjectDirAllowed,
  buildRuntimePlan,
  EXPECTED_ENGINE_VERSION,
  liveSessions,
  loadApprovals,
  makeScratchDir,
  loadWorkspace,
  openRuntimeRoot,
  peekRuntimeRoot,
  queryEngineVersion,
  recordApprovals,
  removeScratchDir,
  removeSessionMarker,
  resolveEngineBinary,
  runEngine,
  tmpDirFor,
  writeSessionMarker,
  type ProjectRecord,
  type RuntimePlan,
  type RuntimeRoot,
  type SessionMarker,
  type Workspace,
} from '../../infra/cwm';
import {
  CliError,
  contextOf,
  failure,
  formatProblem,
  print,
  printJson,
  safeText,
  usageError,
  warn,
  type Context,
} from '../context';
import { promptConfirm } from '../prompts';
import { resolveRecord } from '../resolve-flow';
import { requireInitialized } from './shared';

interface StartOptions {
  readonly project?: string;
  readonly strictMcp?: boolean;
  readonly dryRun?: boolean;
}

type Status = 'approved' | 'new' | 'changed';

interface PendingItem {
  readonly subject: ApprovalSubject;
  readonly status: Status;
  readonly changes: readonly FieldChange[];
}

/** Odmowa z kodem 1: w trybie JSON jako dokument, inaczej jako komunikat na stderr. */
function refuse(ctx: Context, message: string, extra: Record<string, unknown> = {}): never {
  if (ctx.json) {
    printJson({ ok: false, error: message, ...extra });
    throw new CliError('', 1);
  }
  throw failure(message);
}

async function locateProject(
  ctx: Context,
  workspace: Workspace,
  projectOption: string | undefined,
): Promise<ProjectRecord> {
  const dir = resolve(projectOption ?? process.cwd());
  const lookup =
    projectOption === undefined
      ? await workspace.index.enclosing(dir, true)
      : await workspace.index.at(dir);
  if (lookup.problems.length > 0) refuse(ctx, lookup.problems.map(formatProblem).join('\n'));
  if (lookup.record === null) {
    refuse(
      ctx,
      `Nie znaleziono manifestu projektu w ${dir}${projectOption === undefined ? ' ani wyzej' : ''}.`,
    );
  }
  return lookup.record;
}

async function probeVersion(path: string, root: RuntimeRoot | null): Promise<string | null> {
  const parent = root === null ? tmpdir() : await tmpDirFor(root);
  const scratch = await makeScratchDir(parent);
  try {
    return await queryEngineVersion(path, scratch);
  } finally {
    await removeScratchDir(scratch);
  }
}

function sessionConflicts(live: readonly SessionMarker[], plan: RuntimePlan): string[] {
  const out: string[] = [];
  for (const marker of live) {
    if (marker.pid === process.pid) continue;
    if (marker.profileHash !== plan.profileHash) {
      out.push(
        `Trwa sesja firmy ${plan.company} (PID ${marker.pid}, projekt ${marker.project}) z innym profilem. ` +
          'Regeneracja zmienilaby jej ustawienia na zywo (silnik przeladowuje settings.json). Zamknij ja albo uruchom z tymi samymi zasobami.',
      );
    } else if (marker.projectHash === plan.projectHash && marker.sessionHash !== plan.sessionHash) {
      out.push(
        `Trwa sesja tego projektu (PID ${marker.pid}) z innymi plikami uruchomienia. Zamknij ja i uruchom ponownie.`,
      );
    }
  }
  return out;
}

function classify(subjects: readonly ApprovalSubject[], file: ApprovalsFile): PendingItem[] {
  return subjects.map((subject) => {
    const status = statusOf(subject, file);
    if (status.state === 'changed') {
      return {
        subject,
        status: 'changed',
        changes: diffFields(status.previous.fields, subject.fields),
      };
    }
    return { subject, status: status.state, changes: [] };
  });
}

/** Klucz do pokazania: para projekt-firma ma klucz ze skrotu, wiec dopisujemy sciezke. */
function labelOf(subject: ApprovalSubject): string {
  return subject.kind === 'project'
    ? `${subject.key.slice(0, 20)}... (${subject.id})`
    : subject.key;
}

function renderSubject(item: PendingItem): void {
  const { subject } = item;
  const version = subject.version === null ? '' : ` @${subject.version}`;
  print('');
  print(
    `${item.status === 'changed' ? 'ZMIENIONE' : 'NOWE'}: ${labelOf(subject)}${version} (sha256 ${subject.hash.slice(0, 12)})`,
  );
  if (item.status === 'changed') {
    for (const change of item.changes) {
      print(`  ${change.name}`);
      if (change.detail !== undefined) {
        for (const line of change.detail) print(`    ${line}`);
      } else {
        print(`    bylo: ${change.before ?? '(brak)'}`);
        print(`    jest: ${change.after ?? '(brak)'}`);
      }
    }
  } else {
    for (const [name, value] of Object.entries(subject.fields)) {
      print(`  ${name}: ${JSON.stringify(value)}`);
    }
  }
  for (const text of subject.warnings) print(`  UWAGA: ${text}`);
}

async function confirmPending(
  ctx: Context,
  workspace: Workspace,
  plan: RuntimePlan,
  pending: readonly PendingItem[],
  all: readonly PendingItem[],
): Promise<void> {
  print(
    `Zasoby firmy ${plan.company} wymagaja zatwierdzenia (kod, hooki, uprawnienia, serwery MCP).`,
  );
  for (const text of [...plan.warnings, ...plan.notes]) print(`Ostrzezenie planu: ${text}`);
  // Ostrzezenia zasobow juz zatwierdzonych tez (SEC-13): odpowiadajacy widzi pelny obraz planu.
  for (const item of all) {
    if (item.status !== 'approved') continue;
    for (const text of item.subject.warnings) {
      print(`Ostrzezenie (zatwierdzone ${labelOf(item.subject)}): ${text}`);
    }
  }
  for (const item of pending) {
    renderSubject(item);
    const yes = await promptConfirm(safeText(`Zatwierdzic ${labelOf(item.subject)}?`));
    if (!yes) {
      throw failure(
        `Nie zatwierdzono ${labelOf(item.subject)}. Start przerwany, nic nie zapisano.`,
      );
    }
  }
  const result = await recordApprovals(
    ctx.layout,
    plan.company,
    pending.map((item) => item.subject),
    {
      hasResource: (kind, id) => workspace.registry.candidates({ kind, id }).length > 0,
      projectExists: async (path) =>
        await lstat(path).then(
          () => true,
          () => false,
        ),
    },
  );
  for (const key of result.pruned) warn(`Usunieto nieaktualne zatwierdzenie: ${key}`);
}

function pendingMessage(pending: readonly PendingItem[]): string {
  const lines = pending.map(
    (item) =>
      `  ${labelOf(item.subject)} sha256:${item.subject.hash} (${item.status === 'new' ? 'nowe' : 'zmienione'})`,
  );
  return [
    'Niezatwierdzone zasoby (bez terminala nie ma pytania):',
    ...lines,
    'Uruchom cwm start w terminalu (cwm start --dry-run pokaze pola do zatwierdzenia).',
  ].join('\n');
}

interface Report {
  readonly blockers: string[];
  readonly warnings: string[];
}

function renderDryRun(
  ctx: Context,
  plan: RuntimePlan,
  engine: { path: string; version: string | null },
  items: readonly PendingItem[],
  argv: readonly string[],
  env: ChildEnv,
  conflicts: readonly string[],
  report: Report,
  store: string,
): void {
  const byArea = {
    profile: plan.files.filter((f) => f.rel.startsWith('claude/')).map((f) => f.rel),
    session: plan.files.filter((f) => f.rel.startsWith('sessions/')).map((f) => f.rel),
    plugins: plan.files.filter((f) => f.rel.startsWith('plugins/')).map((f) => f.rel),
  };
  if (ctx.json) {
    printJson({
      ok: report.blockers.length === 0,
      dryRun: true,
      company: plan.company,
      project: plan.projectDir,
      projectStore: store,
      engine: { ...engine, expectedVersion: EXPECTED_ENGINE_VERSION },
      approvals: items.map((item) => ({
        key: item.subject.key,
        version: item.subject.version,
        sha256: item.subject.hash,
        status: item.status,
        warnings: item.subject.warnings,
        changes: item.changes,
        ...(item.status === 'approved' ? {} : { fields: item.subject.fields }),
      })),
      files: byArea,
      argv,
      env: { removed: env.removed, added: env.added, missing: env.missing, reserved: env.reserved },
      sessionConflicts: conflicts,
      warnings: report.warnings,
      notes: plan.notes,
      rewrittenReferences: plan.summary.rewrittenReferences,
      blockers: report.blockers,
    });
    return;
  }
  print(`Firma: ${plan.company}`);
  print(`Projekt: ${plan.projectDir} (manifest: ${store})`);
  print(
    `Silnik: ${engine.path} (wersja ${engine.version ?? 'nieustalona'}, oczekiwana ${EXPECTED_ENGINE_VERSION})`,
  );
  print(`Profil (CLAUDE_CONFIG_DIR): ${plan.configDir}`);
  print('');
  print('Zatwierdzenia:');
  for (const item of items) {
    const label = { approved: 'zatwierdzone', new: 'NOWE', changed: 'ZMIENIONE' }[item.status];
    print(
      `  ${label.padEnd(12)} ${labelOf(item.subject)} sha256:${item.subject.hash.slice(0, 12)}`,
    );
    if (item.status !== 'approved') {
      for (const change of item.changes) print(`    zmiana pola: ${change.name}`);
      for (const text of item.subject.warnings) print(`    UWAGA: ${text}`);
    }
  }
  print('');
  print(
    `Pliki do wygenerowania: profil ${byArea.profile.length}, uruchomienie ${byArea.session.length}, migawki pluginow ${byArea.plugins.length}`,
  );
  for (const rel of [...byArea.profile, ...byArea.session, ...byArea.plugins]) print(`  ${rel}`);
  print('');
  print('Argumenty silnika:');
  for (const arg of argv) print(`  ${arg}`);
  print('');
  print(`Srodowisko: usuniete ${env.removed.length}, dodane ${env.added.length}`);
  if (env.removed.length > 0) print(`  usuniete (nazwy): ${env.removed.join(', ')}`);
  if (env.added.length > 0) print(`  dodane (nazwy): ${env.added.join(', ')}`);
  if (env.missing.length > 0) print(`  BRAK wymaganych zmiennych: ${env.missing.join(', ')}`);
  for (const text of conflicts) print(`Blokada profilu: ${text}`);
  for (const text of [...report.warnings, ...plan.notes]) print(`Ostrzezenie: ${text}`);
  print('');
  print(
    report.blockers.length === 0
      ? 'Plan poprawny: cwm start (bez --dry-run) uruchomi silnik.'
      : `Start zostalby odrzucony (${report.blockers.length}):`,
  );
  for (const text of report.blockers) print(`  - ${text}`);
}

async function startCommand(
  ctx: Context,
  options: StartOptions,
  engineArgs: readonly string[],
): Promise<void> {
  if (process.platform === 'win32') {
    throw failure('cwm start nie dziala na Windowsie w tym etapie (silnik wymaga powloki .cmd).');
  }
  const argErrors = checkPassThroughArgs(engineArgs);
  if (argErrors.length > 0) throw usageError(argErrors.join('\n'));

  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  const record = await locateProject(ctx, workspace, options.project);
  if (record.dir === null) refuse(ctx, 'Manifest projektu jest bledny; napraw go (cwm doctor).');
  const projectDir = await assertProjectDirAllowed(record.dir, ctx.layout.home);

  const outcome = await resolveRecord(workspace, record);
  if (outcome.effective === null) refuse(ctx, outcome.problems.map(formatProblem).join('\n'));
  const effective = outcome.effective;
  const companyLoaded = workspace.companies.get(effective.profile.company);
  if (companyLoaded?.ok !== true)
    refuse(ctx, 'Manifest firmy jest bledny; napraw go (cwm doctor).');
  const company = companyLoaded.value;

  const plan = await buildRuntimePlan({
    layout: ctx.layout,
    workspace,
    company,
    effective,
    projectDir,
    projectStore: record.store,
    homeDir: homedir(),
    userArgs: engineArgs,
  });
  if (plan.errors.length > 0) refuse(ctx, plan.errors.join('\n'), { errors: plan.errors });

  const lookup = await resolveEngineBinary({
    configuredPath: company.runtime.claudePath,
    pathEnv: process.env['PATH'],
    projectDir,
  });
  if (!lookup.ok)
    refuse(ctx, `Nie znaleziono bezpiecznego pliku silnika:\n${lookup.reasons.join('\n')}`);
  // Katalog firmy (0700, wlasciciel) powstaje przed probą wersji; sama proba dziala w pustym katalogu tymczasowym (SEC-14).
  const root: RuntimeRoot | null =
    options.dryRun === true ? null : await openRuntimeRoot(ctx.layout, plan.company);
  const version = await probeVersion(lookup.path, root);
  const engine = { path: lookup.path, version };

  const childEnv = buildChildEnv({
    parent: process.env,
    configDir: plan.configDir,
    tmpDir: plan.tmpDir,
    ownRefs: plan.ownEnvRefs,
    otherCompanyRefs: plan.otherCompanyRefs,
    passthrough: company.runtime.envPassthrough,
    settingsEnvRefs: plan.settingsEnvRefs,
    projectDir,
  });

  const argvResult = buildEngineArgv({
    settingsFile: plan.settingsFile,
    mcpConfigFile: plan.mcpConfigFile,
    pluginDirs: plan.pluginDirs,
    strictMcp: options.strictMcp === true,
    userArgs: engineArgs,
  });
  if (!argvResult.ok) throw usageError(argvResult.errors.join('\n'));

  const approvals = await loadApprovals(ctx.layout, plan.company);
  if (approvals.state === 'corrupt') {
    refuse(
      ctx,
      `${approvals.message} Nic nie jest zatwierdzone; napraw lub usun plik zatwierdzen.`,
    );
  }
  const existing = approvals.state === 'ok' ? approvals.file : null;
  const items = classify(plan.subjects, existing ?? { company: plan.company, entries: [] });
  const pending = items.filter((item) => item.status !== 'approved');

  const peek = await peekRuntimeRoot(ctx.layout, plan.company);
  const live = peek === null ? [] : await liveSessions(peek, false);
  const conflicts = sessionConflicts(live, plan);

  const warnings = [...plan.warnings];
  if (version === null) warnings.push('Nie udalo sie ustalic wersji silnika (claude --version).');
  else if (version !== EXPECTED_ENGINE_VERSION) {
    warnings.push(
      `Wersja silnika ${version} rozni sie od przetestowanej ${EXPECTED_ENGINE_VERSION}; flagi i zachowanie moga sie roznic.`,
    );
  }
  if (process.env['CLAUDECODE'] !== undefined) {
    warnings.push(
      'cwm start wywolano z wnetrza sesji silnika; zmienne CLAUDE* nie sa dziedziczone.',
    );
  }

  const blockers: string[] = [];
  if (childEnv.reserved.length > 0) {
    blockers.push(
      `envRef o nazwie zarezerwowanej dla silnika (dodaj do runtime.env.passthrough): ${childEnv.reserved.join(', ')}`,
    );
  }
  if (childEnv.missing.length > 0) {
    blockers.push(
      `brak wymaganych zmiennych srodowiska (puste lub nieustawione): ${childEnv.missing.join(', ')}`,
    );
  }
  if (pending.length > 0) {
    blockers.push(`niezatwierdzone zasoby: ${pending.map((p) => labelOf(p.subject)).join(', ')}`);
  }
  blockers.push(...conflicts);

  if (options.dryRun === true) {
    renderDryRun(
      ctx,
      plan,
      engine,
      items,
      argvResult.argv,
      childEnv,
      conflicts,
      { blockers, warnings },
      record.store,
    );
    if (blockers.length > 0) throw new CliError('', 1);
    return;
  }

  if (childEnv.reserved.length > 0 || childEnv.missing.length > 0 || conflicts.length > 0) {
    refuse(ctx, blockers.filter((b) => !b.startsWith('niezatwierdzone')).join('\n'));
  }
  if (pending.length > 0) {
    if (!ctx.interactive) {
      refuse(ctx, pendingMessage(pending), {
        pending: pending.map((p) => ({
          key: p.subject.key,
          id: p.subject.id,
          sha256: p.subject.hash,
        })),
      });
    }
    await confirmPending(ctx, workspace, plan, pending, items);
  }

  for (const text of warnings) warn(`Ostrzezenie: ${text}`);
  const profileRoot = root ?? (await openRuntimeRoot(ctx.layout, plan.company));
  const marker: SessionMarker = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    profileHash: plan.profileHash,
    projectHash: plan.projectHash,
    sessionHash: plan.sessionHash,
    project: plan.projectDir,
    plugins: plan.pluginSnapshots,
  };
  const release = await acquireMutex(profileRoot);
  try {
    const sessions = await liveSessions(profileRoot, true);
    const again = sessionConflicts(sessions, plan);
    if (again.length > 0) refuse(ctx, again.join('\n'));
    const livePlugins = new Set(
      sessions.filter((m) => m.pid !== process.pid).flatMap((m) => m.plugins ?? []),
    );
    const applied = await applyPlan(profileRoot, plan, { livePlugins });
    for (const text of applied.warnings) warn(`Ostrzezenie: ${text}`);
    await writeSessionMarker(profileRoot, marker);
  } finally {
    await release();
  }

  let childMarker: Promise<void> = Promise.resolve();
  try {
    process.exitCode = await runEngine(lookup.path, argvResult.argv, {
      cwd: plan.projectDir,
      env: childEnv.env,
      onSpawn: (childPid) => {
        childMarker = writeSessionMarker(profileRoot, { ...marker, childPid }).catch(
          () => undefined,
        );
      },
    });
  } finally {
    await childMarker;
    await removeSessionMarker(profileRoot, process.pid);
  }
}

export function registerStart(program: Command): void {
  program
    .command('start')
    .description(
      'Generuje profil firmy i uruchamia silnik (Claude Code) w katalogu projektu; argumenty silnika po "--"',
    )
    .option('--project <katalog>', 'katalog projektu (domyslnie biezacy, z szukaniem w gore)')
    .option('--strict-mcp', 'dodaje --strict-mcp-config: tylko serwery MCP wygenerowane przez CWM')
    .option('--dry-run', 'wypisuje plan i stan zatwierdzen bez zapisu i bez uruchamiania silnika')
    .argument('[argumenty-silnika...]', 'argumenty przekazane silnikowi (po "--")')
    .action(async (args: string[], options: StartOptions, command: Command) =>
      startCommand(contextOf(command), options, args),
    );
}
