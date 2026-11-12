import { resolve } from 'node:path';

import type { Command } from 'commander';

import { effectiveDocument, loadWorkspace, toYaml } from '../../infra/cwm';
import {
  CliError,
  contextOf,
  failure,
  formatProblem,
  print,
  printJson,
  warn,
  type Context,
} from '../context';
import { resolveRecord } from '../resolve-flow';
import { requireInitialized } from './shared';

async function resolveCommand(ctx: Context, projectOption: string | undefined): Promise<void> {
  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  const dir = resolve(projectOption ?? process.cwd());
  const lookup =
    projectOption === undefined
      ? await workspace.index.enclosing(dir, true)
      : await workspace.index.at(dir);

  if (lookup.problems.length > 0) return fail(ctx, lookup.problems.map(formatProblem));
  if (lookup.record === null) {
    throw failure(
      `Nie znaleziono manifestu projektu w ${dir}${projectOption === undefined ? ' ani wyzej' : ''} (.cwm/project.yaml albo manifest w ${ctx.layout.companiesDir}).`,
    );
  }

  const outcome = await resolveRecord(workspace, lookup.record);
  if (outcome.effective === null) return fail(ctx, outcome.problems.map(formatProblem));

  for (const problem of workspace.registry.problems) warn(`Ostrzezenie: ${formatProblem(problem)}`);
  const document = effectiveDocument(outcome.effective);
  if (ctx.json) printJson(document);
  else print(toYaml(document));
}

function fail(ctx: Context, errors: readonly string[]): never {
  if (ctx.json) {
    printJson({ ok: false, errors });
    throw new CliError('', 1);
  }
  throw failure(errors.join('\n'));
}

export function registerResolve(program: Command): void {
  program
    .command('resolve')
    .description(
      'Wypisuje EffectiveConfiguration projektu jako YAML albo bledy z plikiem i pozycja',
    )
    .option('--project <katalog>', 'katalog projektu (domyslnie biezacy, z szukaniem w gore)')
    .action(async (options: { project?: string }, command: Command) =>
      resolveCommand(contextOf(command), options.project),
    );
}
