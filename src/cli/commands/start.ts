import { lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  buildChildEnv,
  buildEngineArgv,
  checkPassThroughArgs,
  diffFields,
  evaluatePackMembers,
  packMemberHash,
  removedMembers,
  statusOf,
  type ApprovalsFile,
  type ApprovalSubject,
  type ChildEnv,
  type FieldChange,
  type MemberFields,
  type PackMemberFacts,
  type PackTrustFile,
  type PackVerdict,
} from '../../core/cwm';
import {
  acquireMutex,
  applyPlan,
  assertProjectDirAllowed,
  buildRuntimePlan,
  EXPECTED_ENGINE_VERSION,
  liveSessions,
  loadApprovals,
  loadPackDefs,
  loadPackTrusts,
  makeScratchDir,
  loadWorkspace,
  openRuntimeRoot,
  peekRuntimeRoot,
  queryEngineVersion,
  recordApprovals,
  recordPackTrust,
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
import { promptConfirm, promptSelect } from '../prompts';
import { renderChanges, renderExec } from '../pack-render';
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
  /** Zasob nalezy do pakietu: ocena wobec zaufanego skrotu pakietu (ADR 0044). */
  readonly verdict?: PackVerdict;
}

const isPackPending = (item: PendingItem): boolean => item.verdict?.state === 'pending';

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

function classify(
  subjects: readonly ApprovalSubject[],
  file: ApprovalsFile,
  verdicts: ReadonlyMap<string, PackVerdict>,
): PendingItem[] {
  return subjects.map((subject) => {
    const status = statusOf(subject, file);
    const verdict = verdicts.get(subject.key);
    // Zgoda per firma obowiazuje jak dotad; zgoda pakietu dochodzi tylko tam, gdzie tamtej brak.
    if (status.state === 'approved') return { subject, status: 'approved', changes: [] };
    if (verdict?.state === 'covered') return { subject, status: 'approved', changes: [], verdict };
    const base: PendingItem =
      status.state === 'changed'
        ? {
            subject,
            status: 'changed',
            changes: diffFields(status.previous.fields, subject.fields),
          }
        : { subject, status: 'new', changes: [] };
    return verdict === undefined ? base : { ...base, verdict };
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

/** Opis zasobu w zmianach pakietu: dodany, zmieniony albo wymagajacy zgody tylko dla tej firmy. */
function renderPackItem(item: PendingItem, plan: RuntimePlan): void {
  const verdict = item.verdict;
  if (verdict?.state !== 'pending') return;
  const key = item.subject.key;
  const facts = plan.packMembers.find((f) => f.key === key);
  const head =
    verdict.reason === 'blocked'
      ? 'WYMAGA ZGODY FIRMY'
      : verdict.reason === 'new'
        ? 'DODANY'
        : 'ZMIENIONY';
  print('');
  print(`  ${head}: ${key}`);
  for (const text of verdict.blockers) print(`    powod: ${text}`);
  if (verdict.reason === 'new' || verdict.reason === 'blocked') {
    if (facts !== undefined) renderExec(facts, '    ');
  }
  renderChanges(verdict.changes, '    ');
}

/**
 * Jedno pytanie na pakiet z lista zmian (ADR 0044). Zwraca zasoby, ktorych zgoda nie moze trafic do
 * pakietu (pola zalezne od firmy), zeby zapisac je jak zwykle zatwierdzenia tej firmy.
 */
interface PackWrite {
  readonly id: string;
  readonly members: readonly { readonly key: string; readonly fields: MemberFields }[];
}

async function confirmPacks(
  workspace: Workspace,
  plan: RuntimePlan,
  items: readonly PendingItem[],
  trust: ReadonlyMap<string, PackTrustFile>,
): Promise<{ companyOnly: ApprovalSubject[]; writes: PackWrite[] }> {
  const companyOnly: ApprovalSubject[] = [];
  const writes: PackWrite[] = [];
  const pending = new Map<string, Map<string, MemberFields>>();
  const packs = [...new Set(items.map((item) => (item.verdict as { pack: string }).pack))].sort();
  for (const id of packs) {
    const own = items.filter((item) => (item.verdict as { pack: string }).pack === id);
    const file = trust.get(id);
    const last = file?.members
      .map((m) => m.approvedAt)
      .sort()
      .pop();
    print('');
    print(
      `PAKIET ${id}: ${last === undefined ? 'nigdy nie zatwierdzony' : `ostatnia zgoda ${last}`}; do decyzji: ${own.length}.`,
    );
    for (const item of own) renderPackItem(item, plan);
    const removed = removedMembers(file, (key) => {
      const colon = key.indexOf(':');
      const kind = key.slice(0, colon) as 'skill';
      return workspace.registry.candidates({ kind, id: key.slice(colon + 1) }).length > 0;
    });
    for (const key of removed) print(`  USUNIETY z rejestru: ${key}`);
    print('');
    const yes = await promptConfirm(
      safeText(`Zatwierdzic zmiany w pakiecie ${id} (${own.length} zasobow)?`),
    );
    if (!yes) throw failure(`Nie zatwierdzono pakietu ${id}. Start przerwany, nic nie zapisano.`);
    const blocked = new Set(
      own
        .filter((item) => item.verdict?.state === 'pending' && item.verdict.reason === 'blocked')
        .map((item) => item.subject.key),
    );
    for (const item of own) if (blocked.has(item.subject.key)) companyOnly.push(item.subject);
    // Zgode dostaja tylko zasoby pokazane w tym pytaniu (i skrypty hookow z ich listy zmian):
    // reszta pakietu zostaje, jak byla, zeby niezauwazona zmiana nie trafila do zaufanych skrotow.
    const members = plan.packMembers.filter(
      (f) =>
        f.pack === id &&
        !blocked.has(f.key) &&
        f.blockers.length === 0 &&
        own.some((item) => item.subject.key === f.key),
    );
    // Zasob ze skryptem hooka musi miec zaufany skrot tez w swoim pakiecie, inaczej pytanie wracaloby.
    const queue = (f: PackMemberFacts): void => {
      const record = trust.get(f.pack)?.members.find((m) => m.key === f.key);
      if (record?.hash === packMemberHash(f.key, f.fields)) return;
      const bucket = pending.get(f.pack) ?? new Map<string, MemberFields>();
      bucket.set(f.key, f.fields);
      pending.set(f.pack, bucket);
    };
    for (const f of members) {
      queue(f);
      for (const dep of f.deps) {
        const owner = plan.packMembers.find((m) => m.key === dep.owner);
        // Tylko wlasciciel bez pol wykonawczych: ten z polami ma wlasne pytanie w swoim pakiecie.
        if (owner !== undefined && owner.blockers.length === 0 && !owner.required) queue(owner);
      }
    }
  }
  for (const [pack, bucket] of pending) {
    writes.push({
      id: pack,
      members: [...bucket].map(([key, fields]) => ({ key, fields })),
    });
  }
  return { companyOnly, writes };
}

async function confirmPending(
  ctx: Context,
  workspace: Workspace,
  plan: RuntimePlan,
  pending: readonly PendingItem[],
  all: readonly PendingItem[],
  trust: ReadonlyMap<string, PackTrustFile>,
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
  // Zasoby z pakietow: jedno pytanie na pakiet z lista zmian (ADR 0044).
  const ordinary = pending.filter((item) => !isPackPending(item));
  const { companyOnly, writes } = await confirmPacks(
    workspace,
    plan,
    pending.filter(isPackPending),
    trust,
  );
  // Zbiorczo tylko nowe zasoby bez ostrzezen; zmienione i ostrzegane zawsze pytaja osobno.
  const bulk = ordinary.filter(
    (item) => item.status === 'new' && item.subject.warnings.length === 0,
  );
  const single = ordinary.filter((item) => !bulk.includes(item));
  let asked = ordinary;
  if (bulk.length > 1) {
    for (const item of ordinary) renderSubject(item);
    print('');
    const all = `Zatwierdz wszystkie ${bulk.length} nowe zasoby bez ostrzezen (wypisane wyzej)`;
    const each = 'Pytaj o kazdy zasob osobno';
    const stop = 'Przerwij';
    const choice = await promptSelect(safeText(`Zasobow do zatwierdzenia: ${ordinary.length}.`), [
      all,
      each,
      stop,
    ]);
    if (choice === stop) throw failure('Przerwano, nic nie zapisano.');
    if (choice === all) asked = single;
  }
  for (const item of asked) {
    renderSubject(item);
    const yes = await promptConfirm(safeText(`Zatwierdzic ${labelOf(item.subject)}?`));
    if (!yes) {
      throw failure(
        `Nie zatwierdzono ${labelOf(item.subject)}. Start przerwany, nic nie zapisano.`,
      );
    }
  }
  for (const write of writes) await recordPackTrust(ctx.layout, write.id, write.members, 'start');
  const result = await recordApprovals(
    ctx.layout,
    plan.company,
    [...ordinary.map((item) => item.subject), ...companyOnly],
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

/** Etykieta stanu: zasob zmieniony wzgledem zgody pakietu to ZMIENIONY, nawet gdy firma nie miala jego zgody. */
const stateLabel = (item: PendingItem): 'new' | 'changed' =>
  item.verdict?.state === 'pending'
    ? item.verdict.reason === 'changed'
      ? 'changed'
      : 'new'
    : item.status === 'changed'
      ? 'changed'
      : 'new';

/** Przyrostek z pakietem do list (bez terminala, --dry-run). */
function packNote(item: PendingItem): string {
  const v = item.verdict;
  if (v === undefined) return '';
  if (v.state === 'covered') return `; pakiet ${v.pack} zatwierdzony ${v.approvedAt}`;
  return `; pakiet ${v.pack}${v.reason === 'blocked' ? ', wymaga zgody firmy' : ''}`;
}

function pendingMessage(pending: readonly PendingItem[]): string {
  const lines = pending.map(
    (item) =>
      `  ${labelOf(item.subject)} sha256:${item.subject.hash} (${stateLabel(item) === 'new' ? 'nowe' : 'zmienione'}${packNote(item)})`,
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
        ...(item.verdict === undefined
          ? {}
          : {
              pack: item.verdict.pack,
              packState: item.verdict.state === 'covered' ? 'covered' : item.verdict.reason,
              ...(item.verdict.state === 'covered'
                ? { packApprovedAt: item.verdict.approvedAt, packVia: item.verdict.via }
                : { packChanges: item.verdict.changes, packBlockers: item.verdict.blockers }),
            }),
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
    const label = {
      approved: 'zatwierdzone',
      new: 'NOWE',
      changed: 'ZMIENIONE',
    }[item.status === 'approved' ? 'approved' : stateLabel(item)];
    print(
      `  ${label.padEnd(12)} ${labelOf(item.subject)} sha256:${item.subject.hash.slice(0, 12)}${packNote(item)}`,
    );
    if (item.verdict?.state === 'pending') {
      for (const text of item.verdict.blockers) print(`    powod: ${text}`);
      for (const change of item.verdict.changes) print(`    zmiana pola pakietu: ${change.name}`);
    }
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

  const packDefs = await loadPackDefs(ctx.layout);
  const plan = await buildRuntimePlan({
    layout: ctx.layout,
    workspace,
    company,
    effective,
    projectDir,
    projectStore: record.store,
    homeDir: homedir(),
    userArgs: engineArgs,
    packMembership: packDefs.membership,
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
  const packs = await loadPackTrusts(
    ctx.layout,
    plan.packMembers.map((member) => member.pack),
  );
  if (packs.corrupt.size > 0) {
    refuse(
      ctx,
      `${[...packs.corrupt].map(([id, message]) => `Pakiet ${id}: ${message}`).join('\n')} Nic z tych pakietow nie jest zatwierdzone; napraw lub usun plik zaufanych skrotow.`,
    );
  }
  const verdicts = evaluatePackMembers(plan.packMembers, packs.trust);
  const items = classify(
    plan.subjects,
    existing ?? { company: plan.company, entries: [] },
    verdicts,
  );
  const pending = items.filter((item) => item.status !== 'approved');

  const peek = await peekRuntimeRoot(ctx.layout, plan.company);
  const live = peek === null ? [] : await liveSessions(peek, false);
  const conflicts = sessionConflicts(live, plan);

  const warnings = [...plan.warnings, ...packDefs.problems.map((text) => `Pakiety: ${text}`)];
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
          ...(p.verdict === undefined ? {} : { pack: p.verdict.pack }),
        })),
      });
    }
    await confirmPending(ctx, workspace, plan, pending, items, packs.trust);
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
