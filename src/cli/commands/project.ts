import { realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { Option, type Command } from 'commander';

import { TOOL_IDS, type ToolId } from '../../core/model/item';
import { validateProjectManifest } from '../../core/cwm';
import {
  companyProjectsDir,
  createProjectDirectory,
  ensureScopedDirectory,
  findGitRoot,
  homeProjectFile,
  homeScope,
  inspectProjectDir,
  isSafeSegment,
  cwmIgnoreStatus,
  assertProjectDirAllowed,
  listCompanyIds,
  listHomeProjects,
  loadCompany,
  lstatLoose,
  loadLocalProject,
  loadGlobalConfig,
  localProjectFile,
  newProjectDocument,
  projectCwmDir,
  projectScope,
  ProjectIndex,
  scanLocalProjects,
  SCAN_LIMIT_MESSAGE,
  toYaml,
  writeScopedFile,
  type ProjectRecord,
  type ProjectStore,
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
import { promptSelect, promptText } from '../prompts';
import { requireInitialized } from './shared';

interface ProjectOptions {
  readonly company?: string;
  readonly id?: string;
  readonly engine?: ToolId;
  readonly store: ProjectStore;
}

const SEGMENT_HINT = 'male litery, cyfry i -, od litery lub cyfry, do 63 znakow.';

function deriveId(dir: string): string {
  return basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

async function makeProject(
  ctx: Context,
  mode: 'create' | 'attach',
  dirArgument: string,
  options: ProjectOptions,
): Promise<void> {
  if (options.company !== undefined && !isSafeSegment(options.company)) {
    throw usageError(`Niepoprawne id firmy w --company: ${SEGMENT_HINT}`);
  }
  if (options.id !== undefined && !isSafeSegment(options.id)) {
    throw usageError(`Niepoprawne id projektu w --id: ${SEGMENT_HINT}`);
  }
  await requireInitialized(ctx.layout);
  const dir = resolve(dirArgument);
  await assertProjectDirAllowed(dir, ctx.layout.home);
  const info = await inspectProjectDir(dir);

  if (mode === 'create') {
    if (info.exists && !info.isDirectory) throw failure(`${dir} istnieje i nie jest katalogiem.`);
    if (info.exists && !info.empty) {
      throw failure(
        `Katalog ${dir} nie jest pusty. Dla istniejacego projektu uzyj: cwm project attach`,
      );
    }
  } else if (!info.exists || !info.isDirectory) {
    throw failure(`Katalog ${dir} nie istnieje. Dla nowego projektu uzyj: cwm project create`);
  }

  const { ids: companyIds } = await listCompanyIds(ctx.layout);
  const index = await ProjectIndex.build(ctx.layout, companyIds);
  const parent = await index.enclosing(dir, false);
  if (parent.problems.length > 0) {
    throw failure(parent.problems.map(formatProblem).join('\n'));
  }
  const parentManifest = parent.record?.loaded;
  if (parentManifest?.ok === false)
    throw failure(parentManifest.problems.map(formatProblem).join('\n'));
  const parentCompany = parentManifest?.value.metadata.company;

  let company = options.company ?? parentCompany;
  if (company === undefined) {
    if (!ctx.interactive || companyIds.length === 0) {
      throw usageError('Podaj firme: --company <id> (lista: cwm company list).');
    }
    company = await promptSelect('Firma projektu', companyIds);
  }
  const companyManifest = await loadCompany(ctx.layout, company).catch(() => null);
  if (companyManifest === null || (!companyManifest.ok && companyManifest.reason === 'missing')) {
    throw failure(`Firma "${company}" nie istnieje. Dodaj: cwm company add ${company}`);
  }
  if (!companyManifest.ok) throw failure(companyManifest.problems.map(formatProblem).join('\n'));
  if (parentCompany !== undefined && parentCompany !== company) {
    throw failure(
      `Projekt zagniezdzony musi nalezec do firmy projektu nadrzednego ("${parentCompany}"), podano "${company}".`,
    );
  }

  let id = options.id ?? deriveId(dir);
  if (options.id === undefined && !isSafeSegment(id)) {
    if (!ctx.interactive)
      throw usageError('Nie da sie wyprowadzic id z nazwy katalogu. Podaj: --id <id>.');
    id = await promptText('Id projektu (male litery, cyfry, -)', {
      validate: (v) => (isSafeSegment(v) ? undefined : SEGMENT_HINT),
    });
  }

  let engine = options.engine;
  if (engine === undefined) {
    const global = await loadGlobalConfig(ctx.layout);
    engine = global.ok ? global.value.defaults.engine : TOOL_IDS[0];
  }

  const homeFile = homeProjectFile(ctx.layout, company, id);
  const existing = await index.at(dir);
  if (existing.record !== null || existing.problems.length > 0) {
    throw failure(`Katalog ${dir} ma juz manifest projektu: ${existing.record?.file ?? ''}`.trim());
  }
  if (options.store === 'home' && (await lstatLoose(homeFile)) !== null) {
    throw failure(`Projekt "${id}" firmy "${company}" juz istnieje: ${homeFile}`);
  }

  // Walidacja przed jakimkolwiek zapisem, zeby bledne id nie zostawilo pustego katalogu projektu.
  const draft = validateProjectManifest(
    newProjectDocument({
      id,
      company,
      engine,
      ...(options.store === 'home' ? { path: dir } : {}),
    }),
  );
  if (!draft.ok) {
    throw usageError(
      ['Niepoprawne dane projektu:', ...draft.errors.map((e) => `  ${e.path}: ${e.message}`)].join(
        '\n',
      ),
    );
  }

  if (mode === 'create') await createProjectDirectory(dir, ctx.layout.home);
  const realDir = await realpath(dir);
  const document = newProjectDocument({
    id,
    company,
    engine,
    ...(options.store === 'home' ? { path: realDir } : {}),
  });
  const checked = validateProjectManifest(document);
  if (!checked.ok) {
    throw usageError(checked.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
  }

  let manifest: string;
  if (options.store === 'local') {
    manifest = localProjectFile(realDir);
    const scope = projectScope(realDir);
    await ensureScopedDirectory(scope, projectCwmDir(realDir));
    await writeScopedFile(scope, manifest, toYaml(document));
  } else {
    manifest = homeFile;
    const scope = homeScope(ctx.layout.home);
    await ensureScopedDirectory(scope, companyProjectsDir(ctx.layout, company));
    await writeScopedFile(scope, manifest, toYaml(document));
  }

  let gitWarning: string | null = null;
  if (options.store === 'local') {
    const gitRoot = await findGitRoot(realDir);
    if (gitRoot !== null) {
      const status = await cwmIgnoreStatus(gitRoot, realDir);
      if (status === 'not-ignored') {
        gitWarning = `Ostrzezenie: ${join(realDir, '.cwm')} nie jest ignorowany przez git (repozytorium ${gitRoot}). Dopisz ".cwm/" do .gitignore albo uzyj --store home.`;
      } else if (status === 'unknown') {
        gitWarning = `Ostrzezenie: nie da sie sprawdzic, czy ${join(realDir, '.cwm')} jest ignorowany przez git (brak gita albo wzorce z negacja). Sprawdz recznie albo uzyj --store home.`;
      }
    }
  }

  if (ctx.json) {
    return printJson({
      ok: true,
      project: { id, company, engine, store: options.store, dir: realDir, manifest },
      native: info.native,
      parent:
        parent.record === null
          ? null
          : {
              dir: parent.record.dir,
              manifest: parent.record.file,
              company: parentCompany ?? null,
            },
      warnings: gitWarning === null ? [] : [gitWarning],
    });
  }
  print(
    `${mode === 'create' ? 'Utworzono' : 'Podlaczono'} projekt "${id}" (firma "${company}", silnik ${engine}).`,
  );
  print(`Manifest (${options.store}): ${manifest}`);
  const found = [
    info.native.claudeDir ? '.claude/' : null,
    info.native.claudeMd ? 'CLAUDE.md' : null,
    info.native.mcpJson ? '.mcp.json' : null,
  ].filter((x): x is string => x !== null);
  if (found.length > 0)
    print(`Wykryto natywna konfiguracje (CWM jej nie zmienia): ${found.join(', ')}`);
  if (parent.record !== null) {
    print(
      `Projekt nadrzedny: ${parent.record.dir ?? parent.record.file} (firma "${parentCompany ?? '?'}")`,
    );
  }
  if (gitWarning !== null) warn(gitWarning);
}

interface ListOptions {
  readonly company?: string;
  readonly scan?: string;
}

async function listProjects(ctx: Context, options: ListOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  const { ids } = await listCompanyIds(ctx.layout);
  const { records, problems } = await listHomeProjects(
    ctx.layout,
    options.company === undefined ? ids : ids.filter((id) => id === options.company),
  );
  const all: ProjectRecord[] = [...records];
  if (options.scan !== undefined) {
    const scanned = await scanLocalProjects(resolve(options.scan), 2);
    if (scanned.limited) warn(`${SCAN_LIMIT_MESSAGE} (--scan, wynik moze byc niepelny)`);
    for (const dir of scanned.dirs) {
      const record = await loadLocalProject(dir);
      if (record !== null) all.push(record);
    }
  }

  const rows = all.map((record) => ({
    store: record.store,
    company: record.loaded.ok ? record.loaded.value.metadata.company : (record.storedUnder ?? '?'),
    id: record.loaded.ok ? record.loaded.value.metadata.id : basename(record.file),
    dir: record.dir ?? '',
    valid: record.loaded.ok,
    file: record.file,
  }));
  const wanted =
    options.company === undefined ? rows : rows.filter((r) => r.company === options.company);

  if (ctx.json) return printJson({ ok: true, projects: wanted });
  if (wanted.length === 0) {
    print('Brak projektow w ~/.cwm. Projekty lokalne wskaz: --scan <katalog>.');
  } else {
    print(
      table([
        ['STORE', 'FIRMA', 'ID', 'KATALOG'],
        ...wanted.map((r) => [r.store, r.company, r.valid ? r.id : `${r.id} (blad)`, r.dir]),
      ]),
    );
  }
  for (const record of all) {
    if (!record.loaded.ok)
      for (const p of record.loaded.problems) warn(`Blad: ${formatProblem(p)}`);
  }
  for (const p of problems) warn(`Blad: ${formatProblem(p)}`);
}

export function registerProject(program: Command): void {
  const project = program.command('project').description('Projekty i ich manifesty');

  const withCreateOptions = (command: Command): Command =>
    command
      .option('--company <id>', 'firma projektu (domyslnie firma projektu nadrzednego)')
      .option('--id <id>', 'id projektu (domyslnie nazwa katalogu)')
      .addOption(new Option('--engine <silnik>', 'silnik narzedzia').choices([...TOOL_IDS]))
      .addOption(
        new Option('--store <miejsce>', 'gdzie trzymac manifest')
          .choices(['local', 'home'])
          .default('local'),
      );

  withCreateOptions(
    project
      .command('create <katalog>')
      .description(
        'Nowy pusty katalog projektu z manifestem (local: <katalog>/.cwm, home: ~/.cwm)',
      ),
  ).action(async (dir: string, options: ProjectOptions, command: Command) =>
    makeProject(contextOf(command), 'create', dir, options),
  );

  withCreateOptions(
    project
      .command('attach <katalog>')
      .description(
        'Podlacza istniejacy katalog; natywnej konfiguracji (.claude, CLAUDE.md, .mcp.json) nie zmienia',
      ),
  ).action(async (dir: string, options: ProjectOptions, command: Command) =>
    makeProject(contextOf(command), 'attach', dir, options),
  );

  project
    .command('list')
    .description('Projekty z manifestami w ~/.cwm; lokalne znajdzie --scan')
    .option('--company <id>', 'tylko ta firma')
    .option('--scan <katalog>', 'dodatkowo szuka .cwm/project.yaml do 2 poziomow w dol')
    .action(async (options: ListOptions, command: Command) =>
      listProjects(contextOf(command), options),
    );
}
