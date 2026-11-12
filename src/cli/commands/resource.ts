import { Option, type Command } from 'commander';

import { RESOURCE_KINDS, formatResource, type ResourceKind } from '../../core/cwm';
import { listCompanyIds, FileResourceRegistry, type RegistryEntry } from '../../infra/cwm';
import { contextOf, formatProblem, print, printJson, table, warn, type Context } from '../context';
import { requireInitialized } from './shared';

interface ListOptions {
  readonly kind?: ResourceKind;
  readonly company?: string;
}

const originLabel = (entry: RegistryEntry): string =>
  entry.origin.scope === 'global' ? 'rejestr' : `firma ${entry.origin.company}`;

async function listResources(ctx: Context, options: ListOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  const { ids } = await listCompanyIds(ctx.layout);
  const registry = await FileResourceRegistry.load(ctx.layout, ids);
  const conflicts = new Set(registry.conflicts());

  const entries = registry.entries
    .filter((e) => options.kind === undefined || e.resource.kind === options.kind)
    .filter(
      (e) =>
        options.company === undefined ||
        (e.origin.scope === 'company' && e.origin.company === options.company),
    )
    .sort((a, b) => {
      const left = `${a.resource.kind}:${a.resource.id}`;
      const right = `${b.resource.kind}:${b.resource.id}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });

  if (ctx.json) {
    return printJson({
      ok: true,
      resources: entries.map((e) => ({
        kind: e.resource.kind,
        id: e.resource.id,
        version: e.resource.version ?? null,
        origin: e.origin,
        file: e.file,
        conflict: conflicts.has(`${e.resource.kind}:${e.resource.id}`),
      })),
      skippedFiles: registry.problems.length,
    });
  }
  if (entries.length === 0) print('Brak zasobow.');
  else {
    print(
      table([
        ['RODZAJ', 'ZASOB', 'ZRODLO', 'PLIK'],
        ...entries.map((e) => [
          e.resource.kind,
          formatResource(e.resource) +
            (conflicts.has(`${e.resource.kind}:${e.resource.id}`) ? ' (KONFLIKT)' : ''),
          originLabel(e),
          e.file,
        ]),
      ]),
    );
  }
  if (registry.problems.length > 0) {
    warn(
      `Pominieto ${registry.problems.length} problemow w plikach zasobow (szczegoly: cwm doctor):`,
    );
    for (const p of registry.problems.slice(0, 5)) warn(`  ${formatProblem(p)}`);
  }
}

export function registerResource(program: Command): void {
  const resource = program
    .command('resource')
    .description('Zasoby z rejestru globalnego i katalogow firm');
  resource
    .command('list')
    .description('Wypisuje zasoby')
    .addOption(new Option('--kind <rodzaj>', 'tylko ten rodzaj').choices([...RESOURCE_KINDS]))
    .option('--company <id>', 'tylko zasoby z katalogu tej firmy')
    .action(async (options: ListOptions, command: Command) =>
      listResources(contextOf(command), options),
    );
}
