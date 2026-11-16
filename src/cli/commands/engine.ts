import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  engineCheckWarnings,
  engineVersionState,
  missingFlagsMessage,
  type EngineCheckReport,
} from '../../core/cwm';
import {
  assertProjectDirAllowed,
  denyNetwork,
  engineBinaryId,
  EXPECTED_ENGINE_VERSION,
  loadWorkspace,
  queryEngineVersion,
  makeScratchDir,
  readEngineChecks,
  recordEngineCheck,
  removeScratchDir,
  resolveEngineBinary,
  runEngineCheck,
} from '../../infra/cwm';
import { CliError, contextOf, print, printJson, safeText, warn, type Context } from '../context';
import { locateProject, refuse } from './start';
import { requireInitialized } from './shared';

interface EngineOptions {
  readonly project?: string;
}

interface Located {
  readonly path: string;
  /** Katalog projektu (albo biezacy, gdy projektu nie ma): wycinany z `PATH` prob silnika. */
  readonly projectDir: string;
  /** Skad wziety plik silnika: `runtime.claude.path` firmy albo `PATH`. */
  readonly source: 'company' | 'path';
}

/**
 * Plik silnika jak w `cwm start`: `resolveEngineBinary` (`runtime.claude.path` firmy projektu albo
 * bezwzgledne elementy `PATH`, po `realpath`, z kontrola wlasciciela). Bez projektu tylko `PATH`.
 */
async function locateEngine(ctx: Context, options: EngineOptions): Promise<Located> {
  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  let configuredPath: string | null = null;
  let projectDir = resolve(process.cwd());
  if (options.project !== undefined) {
    const record = await locateProject(ctx, workspace, options.project);
    if (record.dir !== null)
      projectDir = await assertProjectDirAllowed(record.dir, ctx.layout.home);
    if (record.loaded.ok) {
      const company = workspace.companies.get(record.loaded.value.metadata.company);
      if (company?.ok === true) configuredPath = company.value.runtime.claudePath;
    }
  } else {
    const found = await workspace.index.enclosing(projectDir, true);
    if (found.record?.dir !== null && found.record?.dir !== undefined) {
      projectDir = found.record.dir;
      if (found.record.loaded.ok) {
        const company = workspace.companies.get(found.record.loaded.value.metadata.company);
        if (company?.ok === true) configuredPath = company.value.runtime.claudePath;
      }
    }
  }
  const lookup = await resolveEngineBinary({
    configuredPath,
    pathEnv: process.env['PATH'],
    projectDir,
  });
  if (!lookup.ok) {
    refuse(ctx, `Nie znaleziono bezpiecznego pliku silnika:\n${lookup.reasons.join('\n')}`);
  }
  return { path: lookup.path, projectDir, source: configuredPath === null ? 'path' : 'company' };
}

async function versionOf(located: Located): Promise<string | null> {
  const scratch = await makeScratchDir(tmpdir());
  try {
    return await queryEngineVersion(located.path, scratch, located.projectDir);
  } finally {
    await removeScratchDir(scratch);
  }
}

function reportJson(report: EngineCheckReport): Record<string, unknown> {
  return {
    verdict: report.verdict,
    missingFlags: report.missingFlags,
    newSubcommands: report.newSubcommands,
    suspiciousFlags: report.suspiciousFlags,
    goneFlags: report.goneFlags,
    unavailable: report.unavailable,
    problems: report.problems,
  };
}

async function checkCommand(ctx: Context, options: EngineOptions): Promise<void> {
  const located = await locateEngine(ctx, options);
  const detected = await versionOf(located);
  const run = await runEngineCheck(located.path, tmpdir(), {
    projectDir: located.projectDir,
    expectedVersion: detected,
  });
  const { report } = run;
  const warnings = engineCheckWarnings(report);
  let stored = false;
  if (run.entry !== null && report.version !== null) {
    const read = await readEngineChecks(ctx.layout);
    try {
      await recordEngineCheck(ctx.layout, read.file, report.version, run.entry);
      stored = true;
    } catch {
      warnings.push('Nie udalo sie zapisac wyniku sprawdzenia silnika.');
    }
  }
  const failed = report.verdict !== 'ok';
  if (ctx.json) {
    printJson({
      ok: !failed,
      engine: { path: located.path, source: located.source, version: report.version },
      expectedVersion: EXPECTED_ENGINE_VERSION,
      ...reportJson(report),
      stored,
      warnings,
    });
  } else {
    print(`Silnik: ${located.path}`);
    print(`Wersja: ${report.version ?? 'nieustalona'} (przetestowana: ${EXPECTED_ENGINE_VERSION})`);
    if (report.verdict === 'missing-flags') {
      print(`BLAD: ${missingFlagsMessage(report)}`);
    } else if (report.verdict === 'unverified') {
      print(`Nie udalo sie ocenic silnika: ${report.problems.join('; ')}.`);
    } else {
      print(
        `Flagi, ktore CWM podaje silnikowi, sa obecne w --help.${stored ? ' Wynik zapisany.' : ''}`,
      );
    }
    if (report.goneFlags.length > 0) {
      print(`Flagi znane CWM, ktorych silnik juz nie ma: ${report.goneFlags.join(', ')}`);
    }
    if (report.unavailable.length > 0) {
      print(`Bez wyniku (kod wyjscia, czas albo rozmiar): ${report.unavailable.join(', ')}`);
    }
    for (const text of warnings) warn(`Ostrzezenie: ${text}`);
  }
  if (failed) throw new CliError('', 1);
}

async function statusCommand(ctx: Context, options: EngineOptions): Promise<void> {
  const located = await locateEngine(ctx, options);
  const version = await versionOf(located);
  const read = await readEngineChecks(ctx.layout);
  const id = await engineBinaryId(located.path);
  const state =
    version === null ? null : engineVersionState(version, EXPECTED_ENGINE_VERSION, read.file, id);
  const entry = version === null ? null : (read.file.checks[version] ?? null);
  const checkedVersions = Object.keys(read.file.checks);
  if (ctx.json) {
    printJson({
      ok: true,
      engine: { path: located.path, source: located.source, version },
      expectedVersion: EXPECTED_ENGINE_VERSION,
      state,
      check: entry,
      checkedVersions,
      ...(read.state === 'invalid' ? { warning: read.message } : {}),
    });
    return;
  }
  print(`Silnik: ${located.path}`);
  print(`Wersja: ${version ?? 'nieustalona'} (przetestowana: ${EXPECTED_ENGINE_VERSION})`);
  const label =
    state === 'expected'
      ? 'przetestowana w ADR 0036'
      : state === 'checked'
        ? `flagi sprawdzone ${entry?.checkedAt ?? ''} (skrot pomocy ${entry?.helpSha256.slice(0, 12) ?? ''})`
        : state === 'other-binary'
          ? 'wynik jest dla innego pliku (sciezka, rozmiar albo czas modyfikacji sie rozni); sprawdz: cwm engine check'
          : state === 'unchecked'
            ? 'niesprawdzona; sprawdz: cwm engine check'
            : 'nieustalona';
  print(`Stan: ${label}`);
  if (state === 'other-binary' && entry !== null) {
    print(`Zapisany plik: ${safeText(entry.binary.path)} (${entry.binary.size} B)`);
  }
  if (entry !== null && entry.newSubcommands.length > 0) {
    print(`Podpolecenia spoza listy CWM: ${entry.newSubcommands.join(', ')}`);
  }
  if (entry !== null && entry.suspiciousFlags.length > 0) {
    print(`Nowe flagi do przegladu: ${entry.suspiciousFlags.join(', ')}`);
  }
  print(`Sprawdzone wersje: ${checkedVersions.length === 0 ? 'brak' : checkedVersions.join(', ')}`);
  if (read.state === 'invalid') warn(`Ostrzezenie: ${safeText(read.message)}`);
}

export function registerEngine(program: Command): void {
  const engine = program
    .command('engine')
    .description('Wersja silnika (Claude Code) i sprawdzenie flag, na ktorych opiera sie CWM');
  const withProject = (command: Command): Command =>
    command.option(
      '--project <katalog>',
      'projekt, z ktorego firmy pochodzi plik silnika (domyslnie biezacy, z szukaniem w gore; bez projektu PATH)',
    );
  withProject(
    engine
      .command('check')
      .description(
        'Uruchamia --version, --help, plugin --help i mcp --help w pustym katalogu tymczasowym, ocenia flagi i zapisuje wynik (kod 1, gdy brakuje flagi albo nie da sie ocenic)',
      ),
  ).action(async (options: EngineOptions, command: Command) => {
    denyNetwork();
    return checkCommand(contextOf(command), options);
  });
  withProject(
    engine
      .command('status')
      .description('Pokazuje plik i wersje silnika oraz czy flagi tej wersji byly sprawdzone'),
  ).action(async (options: EngineOptions, command: Command) => {
    denyNetwork();
    return statusCommand(contextOf(command), options);
  });
}
