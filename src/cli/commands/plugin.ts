import type { Command } from 'commander';

import {
  ID_NAME_PATTERN,
  gitRefProblem,
  gitUrlProblem,
  sanitizeGitUrl,
  validateResource,
  type Plugin,
} from '../../core/cwm';
import {
  addPluginToRegistry,
  directoryUnchanged,
  findPluginResource,
  GIT_PLUGIN_NAMESPACE,
  isGitPluginId,
  isPluginId,
  loadGlobalConfig,
  loadWorkspace,
  lookupGitSource,
  PLUGIN_NAMESPACE,
  PluginCommandError,
  pluginJsonVersion,
  pluginManifestDocument,
  pluginSourceDocument,
  precheckEnable,
  pruneUnusedGitSource,
  treeSha256,
  readTree,
  removePluginFromRegistry,
  resolveMarketplacePlugin,
  samePluginSource,
  SEMVER_PATTERN,
  setPluginEnabled,
  sha256Hex,
  updateGitPluginSource,
  WriteDeniedError,
  isSafeSegment,
  type TreeFile,
} from '../../infra/cwm';
import { fetchGitSource, type GitFetchResult } from '../../infra/cwm/git-fetch';
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
  readonly ref?: string;
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
      `Niepoprawne id pluginu "${id}": oczekiwano ${PLUGIN_NAMESPACE}/<nazwa> albo ${GIT_PLUGIN_NAMESPACE}/<nazwa> (male litery ASCII, cyfry, ., _, -).`,
    );
  }
}

async function addPlugin(
  ctx: Context,
  target: string,
  url: string | undefined,
  options: AddOptions,
): Promise<void> {
  if (target === 'git') return addGitPlugin(ctx, url, options);
  if (url !== undefined || options.ref !== undefined) {
    throw usageError(
      'Adres i --ref dotycza tylko pluginow z git: cwm plugin add git <url> --id <id>.',
    );
  }
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
      source: { type: 'marketplace', marketplace, plugin },
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

/** Kopia zrodla do wypisania: skrot adresu i commit zamiast sciezek. */
const shortCommit = (commit: string): string => commit.slice(0, 12);

function gitWarnings(fetched: Extract<GitFetchResult, { ok: true }>): string[] {
  const notes: string[] = [];
  if (fetched.submodules.length > 0) {
    notes.push(
      `repozytorium ma submoduly (${fetched.submodules.length}), nie sa pobierane i nie ma ich w kopii: ${fetched.submodules.slice(0, 5).join(', ')}`,
    );
  }
  return notes;
}

/** Wersja z `.claude-plugin/plugin.json` kopii (tylko poprawny format), inaczej null. */
async function declaredVersion(dir: string): Promise<string | null> {
  const tree = await readTree(dir, undefined, { rejectHardlinks: true });
  if (!tree.ok) return null;
  const declared = pluginJsonVersion(tree.files);
  return declared !== null && SEMVER_PATTERN.test(declared) ? declared : null;
}

async function addGitPlugin(
  ctx: Context,
  url: string | undefined,
  options: AddOptions,
): Promise<void> {
  await requireInitialized(ctx.layout);
  if (url === undefined) {
    throw usageError('Oczekiwano: cwm plugin add git <url> --id git/<nazwa> [--ref <ref>].');
  }
  if (options.id === undefined) {
    throw usageError(`Plugin z git wymaga --id ${GIT_PLUGIN_NAMESPACE}/<nazwa>.`);
  }
  const id = options.id;
  if (!isGitPluginId(id)) {
    throw usageError(
      `Niepoprawne id "${id}": plugin z git ma id ${GIT_PLUGIN_NAMESPACE}/<nazwa> (male litery ASCII, cyfry, ., _, -).`,
    );
  }
  const urlProblem = gitUrlProblem(url);
  if (urlProblem !== null) throw usageError(urlProblem);
  const refProblem = options.ref === undefined ? null : gitRefProblem(options.ref);
  if (refProblem !== null) throw usageError(refProblem);
  if (options.pluginVersion !== undefined && !SEMVER_PATTERN.test(options.pluginVersion)) {
    throw usageError('Niepoprawna wersja: oczekiwano MAJOR.MINOR.PATCH.');
  }
  for (const company of options.enable ?? []) checkCompany(company);
  const source = {
    type: 'git' as const,
    url,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
  };

  // Firma i `plugins.forbid` sa sprawdzane przed siecia (ta sama kontrola co zapis `--enable`).
  await guarded(() => precheckEnable(ctx.layout, options.enable ?? [], id));

  // Id zajete przez inne zrodlo to blad przed siecia; to samo zrodlo to brak pobierania.
  const existing = await findPluginResource(ctx.layout, id);
  if (existing !== null && !samePluginSource(existing.source, source)) {
    throw failure(
      `Id ${id} jest juz zajete przez inne zrodlo. Wybierz inne id (--id) albo najpierw: cwm plugin remove ${id}.`,
    );
  }
  if (existing !== null && existing.source.type === 'git') {
    const result = await guarded(() =>
      addPluginToRegistry(ctx.layout, {
        id,
        version: existing.version,
        source: existing.source,
        companies: options.enable ?? [],
      }),
    );
    if (ctx.json) return printJson({ ok: true, ...result, source: sanitizeGitUrl(url) });
    print(`Plugin ${id} jest juz w rejestrze (${sanitizeGitUrl(url)}), bez zmian.`);
    for (const company of result.enabled) print(`Wlaczono w firmie ${company} (plugins.enable).`);
    for (const company of result.alreadyEnabled) print(`Firma ${company} juz go wlacza.`);
    print(`Odswiezenie: cwm plugin fetch ${id} (ten sam commit) albo cwm plugin update ${id}.`);
    return;
  }

  const fetched = await fetchGitSource({
    layout: ctx.layout,
    url,
    ref: options.ref ?? null,
    commit: null,
  }).catch((error: unknown) => {
    if (error instanceof WriteDeniedError) throw failure(describeWriteError(error));
    throw error;
  });
  if (!fetched.ok) throw failure(`Nie dodano pluginu: ${fetched.message}.`);

  const declared = await declaredVersion(fetched.dir);
  const notes = gitWarnings(fetched);
  const version = options.pluginVersion ?? declared ?? '0.0.0';
  if (options.pluginVersion === undefined && declared === null) {
    notes.push('brak poprawnej wersji w plugin.json, uzyto 0.0.0');
  }
  const pinned = { ...source, commit: fetched.commit, tree: fetched.treeSha256 };
  const checked = validateResource(pluginSourceDocument(id, version, pinned));
  if (!checked.ok) {
    await pruneUnusedGitSource(ctx.layout, url, fetched.commit);
    throw failure('Nie dodano pluginu: manifest zasobu nie przechodzi walidacji.');
  }
  const result = await guarded(() =>
    addPluginToRegistry(ctx.layout, {
      id,
      version,
      source: pinned,
      companies: options.enable ?? [],
    }),
  ).catch(async (error: unknown) => {
    await pruneUnusedGitSource(ctx.layout, url, fetched.commit);
    throw error;
  });

  if (ctx.json) {
    return printJson({
      ok: true,
      ...result,
      source: sanitizeGitUrl(url),
      ref: options.ref ?? null,
      commit: fetched.commit,
      treeSha256: fetched.treeSha256,
      files: fetched.files,
      notes,
    });
  }
  print(
    `Dodano plugin ${result.id} ${result.version} (${sanitizeGitUrl(url)}${options.ref === undefined ? '' : `, ${options.ref}`}) do rejestru.`,
  );
  print(
    `Przypieto commit ${fetched.commit} (${fetched.files} plikow, skrot drzewa ${fetched.treeSha256.slice(0, 16)}).`,
  );
  for (const company of result.enabled) print(`Wlaczono w firmie ${company} (plugins.enable).`);
  for (const company of result.alreadyEnabled) print(`Firma ${company} juz go wlacza.`);
  for (const note of notes) warn(`uwaga: ${note}`);
  print('Zatwierdzenie pluginu nastapi przy cwm start. Start nie pobiera niczego z sieci.');
}

type ChangeKind = '+' | '~' | '-';

/** Sciezka z repozytorium do wypisania: znaki sterujace i formatujace jako \u{...}, zeby nie sterowaly terminalem. */
const escapeRel = (rel: string): string =>
  rel.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (ch) => `\\u{${ch.codePointAt(0)?.toString(16) ?? '?'}}`,
  );

/** Pliki dodane, zmienione i usuniete miedzy dwoma drzewami (po skrocie tresci i bicie wykonywania). */
function changedFiles(
  before: readonly TreeFile[],
  after: readonly TreeFile[],
): { kind: ChangeKind; rel: string }[] {
  const key = (file: TreeFile): string => `${file.executable ? 1 : 0}:${sha256Hex(file.bytes)}`;
  const old = new Map(before.map((file) => [file.rel, key(file)]));
  const next = new Map(after.map((file) => [file.rel, key(file)]));
  const changes: { kind: ChangeKind; rel: string }[] = [];
  for (const [rel, value] of next) {
    const previous = old.get(rel);
    if (previous === undefined) changes.push({ kind: '+', rel });
    else if (previous !== value) changes.push({ kind: '~', rel });
  }
  for (const rel of old.keys()) if (!next.has(rel)) changes.push({ kind: '-', rel });
  return changes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Zasob z rejestru, ktory musi byc pluginem z git. */
async function gitPluginOf(
  ctx: Context,
  id: string,
): Promise<{ plugin: Plugin; source: Extract<Plugin['source'], { type: 'git' }> }> {
  checkPluginId(id);
  const plugin = await guarded(() => findPluginResource(ctx.layout, id));
  if (plugin === null) throw failure(`Plugin ${id} nie istnieje w rejestrze.`);
  if (plugin.source.type !== 'git') {
    throw failure(`Plugin ${id} nie pochodzi z git (zrodlo: ${plugin.source.type}).`);
  }
  return { plugin, source: plugin.source };
}

async function runFetch(
  ctx: Context,
  input: { url: string; ref: string | null; commit: string | null },
  failPrefix: string,
): Promise<Extract<GitFetchResult, { ok: true }>> {
  const fetched = await fetchGitSource({ layout: ctx.layout, ...input }).catch((error: unknown) => {
    if (error instanceof WriteDeniedError) throw failure(describeWriteError(error));
    throw error;
  });
  if (!fetched.ok) throw failure(`${failPrefix}: ${fetched.message}.`);
  return fetched;
}

async function fetchPlugin(ctx: Context, id: string): Promise<void> {
  await requireInitialized(ctx.layout);
  const { source } = await gitPluginOf(ctx, id);

  if (source.commit === undefined) {
    // Pierwsze przypiecie (manifest bez commita): pobierz ref i zapisz commit.
    const fetched = await runFetch(
      ctx,
      { url: source.url, ref: source.ref ?? null, commit: null },
      'Nie pobrano',
    );
    const declared = await declaredVersion(fetched.dir);
    const updated = await guarded(() =>
      updateGitPluginSource(ctx.layout, {
        id,
        commit: fetched.commit,
        tree: fetched.treeSha256,
        ...(declared === null ? {} : { version: declared }),
      }),
    );
    if (ctx.json) return printJson({ ok: true, id, commit: fetched.commit, pinned: true });
    print(`Przypieto ${id} do commita ${fetched.commit} (${fetched.files} plikow).`);
    for (const note of gitWarnings(fetched)) warn(`uwaga: ${note}`);
    print(`Wersja zasobu: ${updated.version}. Zatwierdzenie nastapi przy cwm start.`);
    return;
  }

  const present = await lookupGitSource(ctx.layout, source.url, source.commit);
  if (present.ok) {
    const tree = await readTree(present.dir, undefined, { rejectHardlinks: true });
    if (tree.ok && source.tree !== undefined && treeSha256(tree.files) === source.tree) {
      if (ctx.json) return printJson({ ok: true, id, commit: source.commit, fetched: false });
      return print(
        `Kopia ${id} (commit ${source.commit}) jest na miejscu, nic nie pobrano. Nowszy commit: cwm plugin update ${id}.`,
      );
    }
  }
  const fetched = await runFetch(
    ctx,
    { url: source.url, ref: null, commit: source.commit },
    'Nie pobrano',
  );
  if (source.tree !== undefined && fetched.treeSha256 !== source.tree) {
    throw failure(
      `Nie pobrano: commit ${fetched.commit} daje inny skrot drzewa niz zapisany w manifescie. Zaakceptuj nowa tresc: cwm plugin update ${id}.`,
    );
  }
  if (source.tree === undefined) {
    await guarded(() =>
      updateGitPluginSource(ctx.layout, {
        id,
        commit: fetched.commit,
        tree: fetched.treeSha256,
      }),
    );
  }
  if (ctx.json) {
    return printJson({ ok: true, id, commit: fetched.commit, fetched: true, files: fetched.files });
  }
  print(
    `Pobrano ${id} (commit ${fetched.commit}, ${fetched.files} plikow, skrot drzewa ${fetched.treeSha256.slice(0, 16)}).`,
  );
  for (const note of gitWarnings(fetched)) warn(`uwaga: ${note}`);
}

async function updatePlugin(ctx: Context, id: string, options: { ref?: string }): Promise<void> {
  await requireInitialized(ctx.layout);
  const refProblem = options.ref === undefined ? null : gitRefProblem(options.ref);
  if (refProblem !== null) throw usageError(refProblem);
  const { plugin, source } = await gitPluginOf(ctx, id);
  const ref = options.ref ?? source.ref ?? null;

  const fetched = await runFetch(ctx, { url: source.url, ref, commit: null }, 'Nie zaktualizowano');
  const refChanged = options.ref !== undefined && options.ref !== source.ref;
  if (fetched.commit === source.commit && !refChanged && source.tree === fetched.treeSha256) {
    if (ctx.json) return printJson({ ok: true, id, changed: false, commit: fetched.commit });
    return print(`Bez zmian: ${id} jest na najnowszym commicie ${fetched.commit}.`);
  }

  // Porownanie ze starym commitem, o ile jego kopia jest na dysku.
  let changes: { kind: ChangeKind; rel: string }[] | null = null;
  if (source.commit !== undefined) {
    const old = await lookupGitSource(ctx.layout, source.url, source.commit);
    const before = old.ok ? await readTree(old.dir, undefined, { rejectHardlinks: true }) : null;
    const after = await readTree(fetched.dir, undefined, { rejectHardlinks: true });
    if (before?.ok === true && after.ok) changes = changedFiles(before.files, after.files);
  }
  const declared = await declaredVersion(fetched.dir);
  const result = await guarded(() =>
    updateGitPluginSource(ctx.layout, {
      id,
      commit: fetched.commit,
      tree: fetched.treeSha256,
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...(declared === null ? {} : { version: declared }),
    }),
  ).catch(async (error: unknown) => {
    if (fetched.commit !== source.commit) {
      await pruneUnusedGitSource(ctx.layout, source.url, fetched.commit);
    }
    throw error;
  });

  if (ctx.json) {
    return printJson({
      ok: true,
      id,
      changed: true,
      previousCommit: source.commit ?? null,
      commit: fetched.commit,
      ref,
      version: result.version,
      files:
        changes === null ? null : changes.map((c) => ({ change: c.kind, path: escapeRel(c.rel) })),
      previousPruned: result.previousPruned,
    });
  }
  print(`Zaktualizowano ${id} (${sanitizeGitUrl(source.url)}${ref === null ? '' : `, ${ref}`}).`);
  print(`  stary commit: ${source.commit ?? '(brak)'}`);
  print(`  nowy commit:  ${fetched.commit}`);
  if (changes === null) {
    print('  lista zmian: niedostepna (brak lokalnej kopii starego commita).');
  } else if (changes.length === 0) {
    print('  lista zmian: brak roznic w plikach.');
  } else {
    print(`  zmienione pliki (${changes.length}):`);
    for (const change of changes.slice(0, 50)) print(`    ${change.kind} ${escapeRel(change.rel)}`);
    if (changes.length > 50) print(`    ... i ${changes.length - 50} wiecej`);
  }
  for (const note of gitWarnings(fetched)) warn(`uwaga: ${note}`);
  if (result.version !== plugin.version)
    print(`Wersja zasobu: ${plugin.version} -> ${result.version}.`);
  print(
    'Zatwierdzenie nastapi przy cwm start (skrot drzewa sie zmienil, wiec CWM zapyta ponownie).',
  );
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
            : `git ${sanitizeGitUrl(plugin.source.url)}${plugin.source.ref === undefined ? '' : ` ${plugin.source.ref}`}@${plugin.source.commit === undefined ? 'niepobrany' : shortCommit(plugin.source.commit)}`,
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
  if (result.sourcePruned) print('Usunieto tez pobrana kopie zrodla z sources/git.');
  for (const project of result.projectWarnings) {
    warn(`UWAGA: projekt ${project} nadal wymienia ${id} w plugins.enable (popraw reczne).`);
  }
}

export function registerPlugin(program: Command): void {
  const plugin = program
    .command('plugin')
    .description("Pluginy z marketplace'ow i z git w rejestrze oraz ich wlaczanie w firmach");

  plugin
    .command('add <marketplace/plugin|git> [url]')
    .description(
      "Dodaje plugin z zarejestrowanego marketplace'u albo z git (add git <url> --id git/<nazwa>; jedyne polecenie z siecia razem z fetch i update)",
    )
    .option(
      '--id <id>',
      `id zasobu (marketplace: domyslnie ${PLUGIN_NAMESPACE}/<plugin>; git: wymagane)`,
    )
    .option('--ref <ref>', 'git: galaz, tag albo pelny SHA (domyslnie HEAD repozytorium)')
    .option('--plugin-version <wersja>', 'wersja zasobu (domyslnie z plugin.json, inaczej 0.0.0)')
    .option('--enable <firma...>', 'dopisuje id do plugins.enable wskazanych firm')
    .action(
      async (target: string, url: string | undefined, options: AddOptions, command: Command) =>
        addPlugin(contextOf(command), target, url, options),
    );

  plugin
    .command('fetch <id>')
    .description('Pobiera kopie przypietego commita pluginu z git (siec); bez commita przypina ref')
    .action(async (id: string, _options: unknown, command: Command) =>
      fetchPlugin(contextOf(command), id),
    );

  plugin
    .command('update <id>')
    .description(
      'Pobiera nowszy commit pluginu z git (siec), pokazuje stary i nowy commit oraz zmienione pliki',
    )
    .option('--ref <ref>', 'nowy ref (galaz, tag albo pelny SHA); domyslnie dotychczasowy')
    .action(async (id: string, options: { ref?: string }, command: Command) =>
      updatePlugin(contextOf(command), id, options),
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
