import type { Command } from 'commander';

import { ID_NAME_PATTERN, validateResource } from '../../core/cwm';
import {
  addPluginToRegistry,
  directoryUnchanged,
  isPluginId,
  loadGlobalConfig,
  loadWorkspace,
  PLUGIN_NAMESPACE,
  PluginCommandError,
  pluginJsonVersion,
  pluginManifestDocument,
  readTree,
  removePluginFromRegistry,
  resolveMarketplacePlugin,
  SEMVER_PATTERN,
  setPluginEnabled,
  WriteDeniedError,
  isSafeSegment,
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
import { describeWriteError } from '../import-render';
import { requireInitialized } from './shared';

interface AddOptions {
  readonly id?: string;
  readonly pluginVersion?: string;
  readonly enable?: readonly string[];
}

/** Bledy domenowe i zapisu jako komunikat z kodem 1; reszta (bledy programu) leci dalej. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof PluginCommandError) throw failure(error.message);
    if (error instanceof WriteDeniedError) {
      throw failure(describeWriteError(error));
    }
    throw error;
  }
}

function checkCompany(company: string): void {
  if (!isSafeSegment(company)) throw usageError(`Niepoprawne id firmy "${company}".`);
}

function checkPluginId(id: string): void {
  if (!isPluginId(id)) {
    throw usageError(
      `Niepoprawne id pluginu "${id}": oczekiwano ${PLUGIN_NAMESPACE}/<nazwa> (male litery ASCII, cyfry, ., _, -).`,
    );
  }
}

async function addPlugin(ctx: Context, target: string, options: AddOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  const slash = target.indexOf('/');
  const marketplace = slash < 0 ? '' : target.slice(0, slash);
  const pluginArgument = slash < 0 ? '' : target.slice(slash + 1);
  if (!isSafeSegment(marketplace) || pluginArgument === '' || pluginArgument.includes('/')) {
    throw usageError('Oczekiwano <marketplace>/<plugin>, np. acme-tools/linter.');
  }
  if (options.pluginVersion !== undefined && !SEMVER_PATTERN.test(options.pluginVersion)) {
    throw usageError('Niepoprawna wersja: oczekiwano MAJOR.MINOR.PATCH.');
  }
  for (const company of options.enable ?? []) checkCompany(company);

  const config = await loadGlobalConfig(ctx.layout);
  if (!config.ok) throw failure(config.problems.map(formatProblem).join('\n'));
  // To samo rozwiazanie co `cwm start`: marketplace zarejestrowany, wpis uzywalny, katalog zaufany.
  const resolved = await resolveMarketplacePlugin(
    config.value.marketplaces,
    marketplace,
    pluginArgument,
  );
  if (!resolved.ok) throw failure(`Nie dodano pluginu: ${resolved.reason}.`);
  const plugin = resolved.facts.plugin.toLowerCase();
  if (!ID_NAME_PATTERN.test(plugin)) {
    throw failure(`Nie dodano pluginu: nazwa "${plugin}" nie nadaje sie na id zasobu.`);
  }

  const tree = await readTree(resolved.dir, undefined, { rejectHardlinks: true });
  if (!tree.ok) throw failure(`Nie dodano pluginu: ${tree.message}.`);
  if (!(await directoryUnchanged(resolved.dir))) {
    throw failure('Nie dodano pluginu: katalog pluginu zmienil sie w trakcie odczytu.');
  }
  const declared = pluginJsonVersion(tree.files);
  const notes: string[] = [];
  let version = '0.0.0';
  if (options.pluginVersion !== undefined) version = options.pluginVersion;
  else if (declared !== null && SEMVER_PATTERN.test(declared)) version = declared;
  else if (declared !== null) {
    notes.push(`wersja w plugin.json nie jest w formacie MAJOR.MINOR.PATCH, uzyto ${version}`);
  }

  const id = options.id ?? `${PLUGIN_NAMESPACE}/${plugin}`;
  checkPluginId(id);
  const checked = validateResource(pluginManifestDocument({ id, version, marketplace, plugin }));
  if (!checked.ok) throw failure('Nie dodano pluginu: manifest zasobu nie przechodzi walidacji.');

  const result = await guarded(() =>
    addPluginToRegistry(ctx.layout, {
      id,
      version,
      marketplace,
      plugin,
      companies: options.enable ?? [],
    }),
  );

  if (ctx.json) return printJson({ ok: true, ...result, notes });
  print(
    result.status === 'created'
      ? `Dodano plugin ${result.id} ${result.version} (${marketplace}/${plugin}) do rejestru.`
      : `Plugin ${result.id} jest juz w rejestrze (${marketplace}/${plugin}), bez zmian.`,
  );
  for (const company of result.enabled) print(`Wlaczono w firmie ${company} (plugins.enable).`);
  for (const company of result.alreadyEnabled) print(`Firma ${company} juz go wlacza.`);
  for (const note of notes) warn(`uwaga: ${note}`);
  print('Zatwierdzenie pluginu nastapi przy cwm start (tresc pluginu i blok marketplace).');
}

async function toggle(ctx: Context, id: string, company: string, enabled: boolean): Promise<void> {
  await requireInitialized(ctx.layout);
  checkPluginId(id);
  checkCompany(company);
  const changed = await guarded(() => setPluginEnabled(ctx.layout, company, id, enabled));
  if (ctx.json) return printJson({ ok: true, id, company, enabled, changed });
  const verb = enabled ? 'Wlaczono' : 'Wylaczono';
  print(
    changed
      ? `${verb} ${id} w firmie ${company}.`
      : `Bez zmian: ${id} ${enabled ? 'jest juz wlaczony' : 'nie byl wlaczony'} w firmie ${company}.`,
  );
}

async function listPlugins(ctx: Context): Promise<void> {
  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  const rows = workspace.registry.entries
    .flatMap((entry) =>
      entry.resource.kind === 'plugin' ? [{ entry, plugin: entry.resource }] : [],
    )
    .map(({ plugin }) => ({
      id: plugin.id,
      version: plugin.version,
      source:
        plugin.source.type === 'marketplace'
          ? `marketplace ${plugin.source.marketplace}/${plugin.source.plugin}`
          : plugin.source.type === 'local'
            ? `local ${plugin.source.path}`
            : 'git',
      companies: [...workspace.companies]
        .filter(([, loaded]) => loaded.ok && loaded.value.plugins.enable.includes(plugin.id))
        .map(([company]) => company)
        .sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ctx.json) return printJson({ ok: true, plugins: rows });
  if (rows.length === 0)
    return print('Brak pluginow w rejestrze. Dodaj: cwm plugin add <marketplace>/<plugin>');
  print(
    table([
      ['PLUGIN', 'WERSJA', 'ZRODLO', 'FIRMY'],
      ...rows.map((r) => [r.id, r.version, r.source, r.companies.join(', ') || '-']),
    ]),
  );
}

async function removePlugin(ctx: Context, id: string): Promise<void> {
  await requireInitialized(ctx.layout);
  checkPluginId(id);
  const result = await guarded(() => removePluginFromRegistry(ctx.layout, id));
  if (ctx.json) return printJson({ ok: true, ...result });
  print(`Usunieto plugin ${id} z rejestru.`);
  for (const text of result.listEdits) print(`  wycieto: ${text}`);
  if (result.approvalCompanies.length > 0) {
    print(`Zatwierdzenia wyczyszczone w firmach: ${result.approvalCompanies.join(', ')}`);
  }
  for (const project of result.projectWarnings) {
    warn(`UWAGA: projekt ${project} nadal wymienia ${id} w plugins.enable (popraw reczne).`);
  }
}

export function registerPlugin(program: Command): void {
  const plugin = program
    .command('plugin')
    .description("Pluginy z marketplace'ow w rejestrze i ich wlaczanie w firmach");

  plugin
    .command('add <marketplace/plugin>')
    .description(
      "Dodaje plugin z zarejestrowanego marketplace'u do rejestru (opcjonalnie wlacza go w firmach)",
    )
    .option('--id <id>', `id zasobu (domyslnie ${PLUGIN_NAMESPACE}/<plugin>)`)
    .option('--plugin-version <wersja>', 'wersja zasobu (domyslnie z plugin.json, inaczej 0.0.0)')
    .option('--enable <firma...>', 'dopisuje id do plugins.enable wskazanych firm')
    .action(async (target: string, options: AddOptions, command: Command) =>
      addPlugin(contextOf(command), target, options),
    );

  plugin
    .command('enable <id>')
    .description('Dopisuje plugin do plugins.enable firmy')
    .requiredOption('--company <firma>', 'firma')
    .action(async (id: string, options: { company: string }, command: Command) =>
      toggle(contextOf(command), id, options.company, true),
    );

  plugin
    .command('disable <id>')
    .description('Usuwa plugin z plugins.enable firmy')
    .requiredOption('--company <firma>', 'firma')
    .action(async (id: string, options: { company: string }, command: Command) =>
      toggle(contextOf(command), id, options.company, false),
    );

  plugin
    .command('list')
    .description('Wypisuje pluginy z rejestru, ich zrodlo i firmy, ktore je wlaczaja')
    .action(async (_options: unknown, command: Command) => listPlugins(contextOf(command)));

  plugin
    .command('remove <id>')
    .description('Usuwa plugin z rejestru i zatwierdzen (odmawia, gdy firma go wlacza)')
    .action(async (id: string, _options: unknown, command: Command) =>
      removePlugin(contextOf(command), id),
    );
}
