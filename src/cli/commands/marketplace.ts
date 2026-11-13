import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  API_VERSION,
  escapeControlChars,
  validateResource,
  type MarketplaceSource,
  type MarketplacePlugin,
} from '../../core/cwm';
import {
  editMarketplaces,
  FileResourceRegistry,
  isSafeSegment,
  listCompanyIds,
  loadGlobalConfig,
  loadMarketplace,
  resolveMarketplacePlugin,
  toYaml,
} from '../../infra/cwm';
import {
  contextOf,
  failure,
  formatProblem,
  print,
  printJson,
  table,
  usageError,
  type Context,
} from '../context';
import { requireInitialized } from './shared';

/** Tekst z pliku w jednej linii: znaki sterujace (takze nowa linia) i bidi jako `\xNN`. */
const esc = (text: string): string => escapeControlChars(text);

const NAME_HINT = 'male litery ASCII, cyfry i -, od litery lub cyfry, do 63 znakow.';

function checkName(name: string): void {
  if (!isSafeSegment(name)) throw usageError(`Niepoprawna nazwa marketplace'u: ${NAME_HINT}`);
}

async function registered(ctx: Context): Promise<Readonly<Record<string, MarketplaceSource>>> {
  await requireInitialized(ctx.layout);
  const config = await loadGlobalConfig(ctx.layout);
  if (!config.ok) throw failure(config.problems.map(formatProblem).join('\n'));
  return config.value.marketplaces ?? {};
}

function lookup(
  all: Readonly<Record<string, MarketplaceSource>>,
  name: string,
): MarketplaceSource | undefined {
  return Object.hasOwn(all, name) ? all[name] : undefined;
}

/** Powod nieuzywalnosci: z katalogu albo z rozwiazania sciezki (dowiazania, wlasciciel, uprawnienia); null dla uzywalnego. */
async function pluginProblem(
  all: Readonly<Record<string, MarketplaceSource>>,
  marketplace: string,
  plugin: MarketplacePlugin,
): Promise<string | null> {
  if (plugin.problem !== null) return plugin.problem;
  const resolved = await resolveMarketplacePlugin(all, marketplace, plugin.name);
  return resolved.ok ? null : resolved.reason;
}

async function addMarketplace(ctx: Context, name: string, pathArgument: string): Promise<void> {
  checkName(name);
  const all = await registered(ctx);
  if (lookup(all, name) !== undefined) {
    throw failure(
      `Marketplace "${name}" jest juz zarejestrowany (cwm marketplace remove ${name}).`,
    );
  }
  let path: string;
  try {
    path = await realpath(resolve(pathArgument));
  } catch {
    throw failure("Katalog marketplace'u nie istnieje albo jest nieczytelny.");
  }
  const source: MarketplaceSource = { type: 'local', path };
  // Te same kontrole co `cwm start`: katalog zaufany, marketplace.json poprawny, nazwa zgodna.
  const loaded = await loadMarketplace(name, source);
  if (!loaded.ok) throw failure(`Nie dodano marketplace'u "${name}": ${loaded.reason}.`);
  const result = await editMarketplaces(ctx.layout, (current) =>
    lookup(current, name) === undefined
      ? { ok: true, next: { ...current, [name]: source } }
      : { ok: false, reason: `Marketplace "${name}" jest juz zarejestrowany.` },
  );
  if (!result.ok) throw failure(result.reason);

  const plugins = loaded.marketplace.catalog.plugins;
  const count = { total: plugins.length, usable: plugins.filter((p) => p.problem === null).length };
  if (ctx.json)
    return printJson({ ok: true, marketplace: { name, type: 'local', path }, plugins: count });
  print(
    `Dodano marketplace "${name}": ${path} (pluginow: ${count.total}, uzywalnych: ${count.usable}).`,
  );
}

async function listMarketplaces(ctx: Context): Promise<void> {
  const all = await registered(ctx);
  const rows = await Promise.all(
    Object.keys(all)
      .sort()
      .map(async (name) => {
        const source = lookup(all, name);
        if (source === undefined) return null;
        const loaded = await loadMarketplace(name, source);
        return {
          name,
          type: source.type,
          path: source.path,
          problem: loaded.ok ? null : loaded.reason,
          plugins: loaded.ok ? loaded.marketplace.catalog.plugins.length : null,
        };
      }),
  );
  const present = rows.filter((row) => row !== null);
  if (ctx.json) return printJson({ ok: true, marketplaces: present });
  if (present.length === 0)
    return print("Brak marketplace'ow. Dodaj: cwm marketplace add <nazwa> <katalog>");
  print(
    table([
      ['NAZWA', 'TYP', 'STAN', 'SCIEZKA'],
      ...present.map((row) => [
        row.name,
        row.type,
        row.problem === null ? `ok (pluginow: ${row.plugins ?? 0})` : `BLAD: ${row.problem}`,
        row.path,
      ]),
    ]),
  );
}

async function removeMarketplace(ctx: Context, name: string): Promise<void> {
  checkName(name);
  const all = await registered(ctx);
  if (lookup(all, name) === undefined)
    throw failure(`Marketplace "${name}" nie jest zarejestrowany.`);
  const { ids } = await listCompanyIds(ctx.layout);
  const registry = await FileResourceRegistry.load(ctx.layout, ids);
  const users = registry.entries
    .filter(
      (entry) =>
        entry.resource.kind === 'plugin' &&
        entry.resource.source.type === 'marketplace' &&
        entry.resource.source.marketplace === name,
    )
    .map((entry) => entry.resource.id)
    .sort();
  if (users.length > 0) {
    throw failure(
      `Marketplace "${name}" jest uzywany przez pluginy: ${users.join(', ')}. Usun najpierw te zasoby.`,
    );
  }
  const result = await editMarketplaces(ctx.layout, (current) => {
    if (lookup(current, name) === undefined) {
      return { ok: false, reason: `Marketplace "${name}" nie jest zarejestrowany.` };
    }
    const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== name));
    return { ok: true, next };
  });
  if (!result.ok) throw failure(result.reason);
  if (ctx.json) return printJson({ ok: true, removed: name });
  print(`Usunieto marketplace "${name}" z konfiguracji (katalog marketplace'u nietkniety).`);
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Gotowy manifest zasobu `Plugin` do wklejenia w `registry/plugins/marketplace/<plugin>/plugin.yaml`. */
function manifestFor(marketplace: string, plugin: MarketplacePlugin): string | null {
  const name = plugin.name.toLowerCase();
  const document = {
    apiVersion: API_VERSION,
    kind: 'Plugin',
    metadata: {
      id: `marketplace/${name}`,
      version: plugin.version !== null && SEMVER.test(plugin.version) ? plugin.version : '0.0.0',
    },
    spec: {
      source: { type: 'marketplace', marketplace, plugin: name },
      activation: { default: 'disabled' },
    },
  };
  return validateResource(document).ok ? toYaml(document) : null;
}

async function showMarketplace(
  ctx: Context,
  name: string,
  pluginArgument: string | undefined,
): Promise<void> {
  checkName(name);
  const all = await registered(ctx);
  const source = lookup(all, name);
  if (source === undefined) throw failure(`Marketplace "${name}" nie jest zarejestrowany.`);
  const loaded = await loadMarketplace(name, source);
  if (!loaded.ok) throw failure(`Marketplace "${name}": ${loaded.reason}.`);
  const catalog = loaded.marketplace.catalog;

  if (pluginArgument !== undefined) {
    const wanted = pluginArgument.toLowerCase();
    const plugin = catalog.plugins.find((p) => p.name.toLowerCase() === wanted);
    if (plugin === undefined)
      throw failure(`Marketplace "${name}" nie ma pluginu "${pluginArgument}".`);
    const problem = await pluginProblem(all, name, plugin);
    const manifest = problem === null ? manifestFor(name, plugin) : null;
    if (ctx.json) return printJson({ ok: true, plugin: { ...plugin, problem }, manifest });
    print(`Plugin ${esc(plugin.name)} (marketplace ${name})`);
    print(`  zrodlo: ${esc(plugin.declaredSource)}`);
    print(`  wersja: ${plugin.version ?? '(brak)'}`);
    print(`  stan:   ${problem === null ? 'uzywalny' : `NIEUZYWALNY: ${esc(problem)}`}`);
    if (manifest === null) return;
    print('');
    print(
      `Manifest zasobu (zapisz jako registry/plugins/marketplace/${esc(plugin.name.toLowerCase())}/plugin.yaml, potem dodaj id do plugins.enable w company.yaml):`,
    );
    print(manifest);
    return;
  }

  const problems = await Promise.all(catalog.plugins.map((p) => pluginProblem(all, name, p)));
  if (ctx.json) {
    return printJson({
      ok: true,
      marketplace: { name, path: loaded.marketplace.root, description: catalog.description },
      plugins: catalog.plugins.map((p, i) => ({ ...p, problem: problems[i] ?? null })),
    });
  }
  print(`Marketplace ${name}: ${loaded.marketplace.root}`);
  if (catalog.plugins.length === 0) return print('Brak pluginow w marketplace.json.');
  print(
    table([
      ['PLUGIN', 'WERSJA', 'ZRODLO', 'STAN'],
      ...catalog.plugins.map((p, i) => [
        esc(p.name),
        p.version ?? '-',
        esc(p.declaredSource),
        (problems[i] ?? null) === null ? 'ok' : `NIEUZYWALNY: ${esc(problems[i] ?? '')}`,
      ]),
    ]),
  );
}

export function registerMarketplace(program: Command): void {
  const marketplace = program
    .command('marketplace')
    .description("Lokalne marketplace'y pluginow (marketplaces w ~/.cwm/config.yaml)");

  marketplace
    .command('add <nazwa> <katalog>')
    .description(
      'Rejestruje lokalny marketplace; sprawdza katalog (wlasciciel, uprawnienia) i marketplace.json',
    )
    .action(async (name: string, path: string, _options: unknown, command: Command) =>
      addMarketplace(contextOf(command), name, path),
    );

  marketplace
    .command('list')
    .description("Wypisuje zarejestrowane marketplace'y wraz ze stanem")
    .action(async (_options: unknown, command: Command) => listMarketplaces(contextOf(command)));

  marketplace
    .command('remove <nazwa>')
    .description('Usuwa marketplace z konfiguracji (odmawia, gdy zasob Plugin go uzywa)')
    .action(async (name: string, _options: unknown, command: Command) =>
      removeMarketplace(contextOf(command), name),
    );

  marketplace
    .command('show <nazwa> [plugin]')
    .description(
      'Wypisuje pluginy z marketplace.json; z nazwa pluginu pokazuje szczegoly i gotowy manifest zasobu',
    )
    .action(async (name: string, plugin: string | undefined, _options: unknown, command: Command) =>
      showMarketplace(contextOf(command), name, plugin),
    );
}
