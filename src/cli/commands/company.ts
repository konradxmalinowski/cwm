import type { Command } from 'commander';

import { join } from 'node:path';

import { RESOURCE_SET_KEYS, validateCompanyManifest } from '../../core/cwm';
import {
  companyDir,
  companyManifestFile,
  companyProjectsDir,
  ensureScopedDirectory,
  homeScope,
  isSafeSegment,
  lstatLoose,
  loadWorkspace,
  newCompanyDocument,
  toYaml,
  writeScopedFile,
} from '../../infra/cwm';
import {
  contextOf,
  failure,
  formatProblem,
  print,
  printJson,
  table,
  usageError,
  warn,
  type Context,
} from '../context';
import { promptText } from '../prompts';
import { requireInitialized } from './shared';

interface AddOptions {
  readonly name?: string;
  readonly instructions?: string;
}

const ID_HINT = 'male litery, cyfry i -, od litery lub cyfry, do 63 znakow.';

async function addCompany(
  ctx: Context,
  idArgument: string | undefined,
  options: AddOptions,
): Promise<void> {
  await requireInitialized(ctx.layout);

  let id = idArgument;
  if (id === undefined) {
    if (!ctx.interactive)
      throw usageError('Podaj id firmy: cwm company add <id> [--name <nazwa>].');
    id = await promptText('Id firmy (male litery, cyfry, -)', {
      placeholder: 'acme-a',
      validate: (v) => (isSafeSegment(v) ? undefined : ID_HINT),
    });
  }
  if (!isSafeSegment(id)) throw usageError(`Niepoprawne id firmy: ${ID_HINT}`);
  let name = options.name;
  if (name === undefined && ctx.interactive && idArgument === undefined) {
    name = await promptText('Nazwa firmy', { placeholder: id });
  }
  const document = newCompanyDocument(id, name ?? id, options.instructions);
  const checked = validateCompanyManifest(document);
  if (!checked.ok) {
    throw usageError(
      ['Niepoprawne dane firmy:', ...checked.errors.map((e) => `  ${e.path}: ${e.message}`)].join(
        '\n',
      ),
    );
  }

  const manifest = companyManifestFile(ctx.layout, id);
  if ((await lstatLoose(companyDir(ctx.layout, id))) !== null) {
    throw failure(`Firma "${id}" juz istnieje: ${companyDir(ctx.layout, id)}`);
  }
  const scope = homeScope(ctx.layout.home);
  const base = companyDir(ctx.layout, id);
  for (const dir of [
    base,
    join(base, RESOURCE_SET_KEYS.skill),
    join(base, RESOURCE_SET_KEYS.agent),
    join(base, RESOURCE_SET_KEYS.workflow),
    join(base, RESOURCE_SET_KEYS.command),
    join(base, RESOURCE_SET_KEYS.settings),
    companyProjectsDir(ctx.layout, id),
  ]) {
    await ensureScopedDirectory(scope, dir);
  }
  await writeScopedFile(scope, manifest, toYaml(document));

  if (ctx.json)
    return printJson({ ok: true, company: { id, name: checked.value.metadata.name, manifest } });
  print(`Dodano firme "${id}": ${manifest}`);
}

async function listCompanies(ctx: Context): Promise<void> {
  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  const records = workspace.homeProjects;

  const rows = workspace.companyIds.map((id) => {
    const loaded = workspace.companies.get(id);
    const projects = records.filter((r) => r.storedUnder === id).length;
    return {
      id,
      name: loaded?.ok === true ? loaded.value.metadata.name : null,
      projects,
      problems: loaded?.ok === true ? [] : (loaded?.problems ?? []),
    };
  });

  if (ctx.json) {
    return printJson({
      ok: true,
      companies: rows.map((r) => ({
        id: r.id,
        name: r.name,
        valid: r.name !== null,
        homeProjects: r.projects,
      })),
    });
  }
  if (rows.length === 0) return print('Brak firm. Dodaj: cwm company add <id>');
  print(
    table([
      ['ID', 'NAZWA', 'PROJEKTY W ~/.cwm'],
      ...rows.map((r) => [r.id, r.name ?? '(bledny manifest)', String(r.projects)]),
    ]),
  );
  for (const row of rows)
    for (const problem of row.problems) warn(`Blad: ${formatProblem(problem)}`);
}

export function registerCompany(program: Command): void {
  const company = program.command('company').description('Firmy w ~/.cwm/companies');

  company
    .command('add [id]')
    .description('Dodaje firme (manifest company.yaml); bez id pyta interaktywnie na terminalu')
    .option('--name <nazwa>', 'nazwa firmy (domyslnie id)')
    .option('--instructions <plik>', 'plik instrukcji firmy, sciezka wzgledna (np. CLAUDE.md)')
    .action(async (id: string | undefined, options: AddOptions, command: Command) =>
      addCompany(contextOf(command), id, options),
    );

  company
    .command('list')
    .description('Wypisuje firmy')
    .action(async (_options: unknown, command: Command) => listCompanies(contextOf(command)));
}
