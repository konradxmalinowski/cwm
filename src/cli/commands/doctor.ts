import { basename, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { dependenciesOf, forEachId, forEachRef, refKey, type ResourceRef } from '../../core/cwm';
import {
  homeDirectories,
  loadWorkspace,
  lstatLoose,
  PathCheckError,
  problemAt,
  problemWithoutPosition,
  companyDir,
  type Problem,
  type ProjectRecord,
  type Workspace,
} from '../../infra/cwm';
import { CliError, contextOf, formatProblem, print, printJson, type Context } from '../context';
import { resolveRecord } from '../resolve-flow';

/** Ten sam blad zgloszony z kilku miejsc (np. zepsuty manifest firmy przy kazdym projekcie) liczy sie raz. */
class Report {
  readonly errors: Problem[] = [];
  readonly warnings: Problem[] = [];
  private readonly seen = new Set<string>();

  error(...problems: readonly Problem[]): void {
    this.add(this.errors, 'E', problems);
  }

  warning(...problems: readonly Problem[]): void {
    this.add(this.warnings, 'W', problems);
  }

  private add(target: Problem[], level: string, problems: readonly Problem[]): void {
    for (const problem of problems) {
      const key = `${level}\u0000${problem.file}\u0000${problem.path}\u0000${problem.message}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      target.push(problem);
    }
  }
}

/** Blad dostepu do jednej sciezki nie przerywa przegladu: staje sie ostrzezeniem bez surowego errno. */
async function guarded(report: Report, file: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error: unknown) {
    const reason =
      error instanceof PathCheckError ? error.message : 'blad dostepu do systemu plikow';
    report.warning(problemWithoutPosition(file, '$', `Sprawdzenie pominiete: ${reason}.`));
  }
}

const posix = process.platform !== 'win32';

async function checkPermissions(report: Report, path: string): Promise<void> {
  if (!posix) return;
  const info = await lstatLoose(path);
  if (info === null || !info.isDirectory() || (info.mode & 0o077) === 0) return;
  report.warning(
    problemWithoutPosition(
      path,
      '$',
      `Katalog ma uprawnienia ${(info.mode & 0o777).toString(8)} dla grupy lub innych (oczekiwane 700). Popraw: chmod 700`,
    ),
  );
}

function checkReferences(workspace: Workspace, report: Report): void {
  const missing = (file: string, text: string) => (ref: ResourceRef, path: string) => {
    if (workspace.registry.candidates(ref).length === 0) {
      report.error(problemAt(file, text, path, `Zasob ${refKey(ref)} nie istnieje w rejestrze.`));
    }
  };
  const global = workspace.global;
  if (global.ok) {
    const check = missing(global.file, global.text);
    forEachRef(global.value.resources.mandatory, 'resources.mandatory', check);
    forEachRef(global.value.resources.optional, 'resources.optional', check);
  }
  for (const [id, company] of workspace.companies) {
    if (!company.ok) {
      report.error(...company.problems);
      continue;
    }
    if (company.value.metadata.id !== id) {
      report.error(
        problemAt(
          company.file,
          company.text,
          'metadata.id',
          `Id "${company.value.metadata.id}" nie zgadza sie z nazwa katalogu "${id}".`,
        ),
      );
    }
    const check = missing(company.file, company.text);
    forEachRef(company.value.resources.enable, 'resources.enable', check);
    forEachRef(company.value.exports, 'exports', check);
    forEachId('plugin', company.value.plugins.enable, 'plugins.enable', check);
    forEachId('mcp', company.value.mcp.enable, 'mcp.enable', check);
  }
}

async function checkRegistry(workspace: Workspace, report: Report): Promise<void> {
  const { registry } = workspace;
  report.error(...registry.problems);
  for (const key of registry.conflicts()) {
    const files = registry.entries
      .filter((e) => `${e.resource.kind}:${e.resource.id}` === key)
      .map((e) => e.file);
    for (const file of files) {
      report.error(
        problemWithoutPosition(
          file,
          'metadata.id',
          `Identyfikator ${key} ma ${files.length} definicji (konflikt).`,
        ),
      );
    }
  }
  for (const entry of registry.entries) {
    for (const dependency of dependenciesOf(entry.resource)) {
      if (registry.candidates(dependency).length === 0) {
        report.error(
          problemWithoutPosition(
            entry.file,
            'spec',
            `Zasob ${refKey(entry.resource)} zalezy od ${refKey(dependency)}, ktorego brak w rejestrze.`,
          ),
        );
      }
    }
    const { resource } = entry;
    if (resource.kind === 'files') {
      await guarded(report, entry.file, async () => {
        const info = await lstatLoose(join(entry.dir, resource.path));
        if (info === null) {
          report.warning(
            problemWithoutPosition(
              entry.file,
              'spec.path',
              `Sciezka ${resource.path} nie istnieje obok definicji.`,
            ),
          );
        }
      });
    }
    if (resource.kind === 'skill' || resource.kind === 'agent' || resource.kind === 'workflow') {
      await guarded(report, entry.file, async () => {
        const info = await lstatLoose(join(entry.dir, resource.source));
        if (info === null || !info.isFile()) {
          report.warning(
            problemWithoutPosition(
              entry.file,
              'spec.source',
              `Plik zrodlowy ${resource.source} nie istnieje obok definicji.`,
            ),
          );
        }
      });
    }
  }
}

async function checkProject(
  workspace: Workspace,
  record: ProjectRecord,
  report: Report,
): Promise<void> {
  if (!record.loaded.ok) return report.error(...record.loaded.problems);
  const { file, text, value } = record.loaded;
  if (record.store === 'home') {
    if (record.storedUnder !== value.metadata.company) {
      report.error(
        problemAt(
          file,
          text,
          'metadata.company',
          `Manifest lezy w katalogu firmy "${record.storedUnder ?? '?'}", a wskazuje firme "${value.metadata.company}".`,
        ),
      );
    }
    if (basename(file) !== `${value.metadata.id}.yaml`) {
      report.error(
        problemAt(
          file,
          text,
          'metadata.id',
          `Nazwa pliku nie zgadza sie z id projektu "${value.metadata.id}".`,
        ),
      );
    }
  }
  const outcome = await resolveRecord(workspace, record);
  report.error(...outcome.problems);
}

async function doctor(ctx: Context, projectOption: string | undefined): Promise<void> {
  const report = new Report();
  const { layout } = ctx;
  let companies = 0;
  let projects = 0;
  let resources = 0;

  let homeExists = false;
  await guarded(report, layout.home, async () => {
    homeExists = (await lstatLoose(layout.home)) !== null;
    if (!homeExists) {
      report.error(
        problemWithoutPosition(layout.home, '$', 'Katalog danych nie istnieje. Uruchom: cwm init'),
      );
      return;
    }
    for (const dir of homeDirectories(layout)) {
      if ((await lstatLoose(dir)) === null) {
        report.warning(problemWithoutPosition(dir, '$', 'Brakuje katalogu (cwm init go utworzy).'));
      }
    }
    await checkPermissions(report, layout.home);
  });

  if (homeExists) {
    const workspace = await loadWorkspace(layout);
    companies = workspace.companyIds.length;
    resources = workspace.registry.entries.length;
    if (!workspace.global.ok) report.error(...workspace.global.problems);
    report.warning(...workspace.problems);
    report.error(...workspace.homeProjectProblems);
    for (const id of workspace.companyIds) {
      const dir = companyDir(layout, id);
      await guarded(report, dir, () => checkPermissions(report, dir));
    }
    checkReferences(workspace, report);
    await checkRegistry(workspace, report);

    const records: ProjectRecord[] = [...workspace.homeProjects];
    const dir = resolve(projectOption ?? process.cwd());
    await guarded(report, dir, async () => {
      const lookup =
        projectOption === undefined
          ? await workspace.index.enclosing(dir, true)
          : await workspace.index.at(dir);
      report.error(...lookup.problems);
      if (lookup.record !== null && !records.some((r) => r.file === lookup.record?.file)) {
        records.push(lookup.record);
      }
      if (projectOption !== undefined && lookup.record === null && lookup.problems.length === 0) {
        report.error(problemWithoutPosition(dir, '$', 'Nie znaleziono manifestu projektu.'));
      }
    });
    projects = records.length;
    for (const record of records) {
      await guarded(report, record.file, () => checkProject(workspace, record, report));
    }
  }

  const ok = report.errors.length === 0;
  if (ctx.json) {
    printJson({
      ok,
      checked: { companies, projects, resources },
      errors: report.errors,
      warnings: report.warnings,
    });
  } else {
    for (const p of report.errors) print(`BLAD ${formatProblem(p)}`);
    for (const p of report.warnings) print(`OSTRZEZENIE ${formatProblem(p)}`);
    print(
      `Sprawdzono: firm ${companies}, projektow ${projects}, zasobow ${resources}. Bledy: ${report.errors.length}, ostrzezenia: ${report.warnings.length}.`,
    );
  }
  if (!ok) throw new CliError('', 1);
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Sprawdza manifesty, zasoby, braki zaleznosci i konflikty id; blad zwraca kod 1')
    .option(
      '--project <katalog>',
      'dodatkowo projekt z tego katalogu (domyslnie biezacy, z szukaniem w gore)',
    )
    .action(async (options: { project?: string }, command: Command) =>
      doctor(contextOf(command), options.project),
    );
}
