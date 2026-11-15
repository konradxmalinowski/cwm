import { Option, type Command } from 'commander';

import { workflowCommandName, type Workflow } from '../../core/cwm';
import {
  addWorkflowToRegistry,
  checkWorkflowSource,
  loadWorkspace,
  readCommandSource,
  readSourceFile,
  readWorkflowSourceFile,
  WORKFLOW_SOURCE_FILE,
  WorkflowCommandError,
  workflowEntries,
  WriteDeniedError,
  type GlobalList,
  type Workspace,
} from '../../infra/cwm';
import {
  contextOf,
  failure,
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
  readonly from?: string;
  readonly fromCommand?: string;
  readonly keywords?: string;
  readonly example?: readonly string[];
  readonly priority?: string;
  readonly manual?: boolean;
  readonly enable?: readonly string[];
  readonly global?: GlobalList;
}

/** Bledy domenowe i zapisu jako komunikat z kodem 1; reszta (bledy programu) leci dalej. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof WorkflowCommandError) throw failure(error.message);
    if (error instanceof WriteDeniedError) throw failure(describeWriteError(error));
    throw error;
  }
}

const collect = (value: string, previous: readonly string[]): string[] => [...previous, value];

function parseKeywords(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

async function addWorkflow(ctx: Context, id: string, options: AddOptions): Promise<void> {
  await requireInitialized(ctx.layout);
  if ((options.from === undefined) === (options.fromCommand === undefined)) {
    throw usageError('Podaj dokladnie jedno zrodlo: --from <plik.md> albo --from-command <id>.');
  }
  const priority = options.priority === undefined ? 0 : Number(options.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    throw usageError('--priority: liczba calkowita od 0 do 1000.');
  }
  const keywords = parseKeywords(options.keywords);
  const examples = options.example ?? [];

  const result = await guarded(async () => {
    const source =
      options.from !== undefined
        ? await readWorkflowSourceFile(options.from)
        : await readCommandSource(ctx.layout, options.fromCommand ?? '');
    return addWorkflowToRegistry(ctx.layout, {
      id,
      source,
      keywords,
      examples,
      priority,
      manual: options.manual === true,
      companies: options.enable ?? [],
      global: options.global ?? null,
    });
  });

  const hint =
    keywords.length === 0 && examples.length === 0 && options.manual !== true
      ? 'bez --keywords i --example workflow nie bedzie wybierany automatycznie (tylko --workflow albo domyslny)'
      : null;
  if (ctx.json) return printJson({ ok: true, ...result, hint });
  print(
    result.status === 'created'
      ? `Dodano workflow ${result.id} (polecenie /${workflowCommandName(result.id)}).`
      : `Workflow ${result.id} jest juz w rejestrze, bez zmian.`,
  );
  for (const company of result.enabled) {
    print(`Wlaczono w firmie ${company} (resources.enable.workflows).`);
  }
  for (const company of result.alreadyEnabled) print(`Firma ${company} juz go wlacza.`);
  if (result.globalChanged) print(`Dopisano do config.yaml (resources.${options.global ?? ''}).`);
  if (hint !== null) warn(`uwaga: ${hint}`);
  if (result.needsApproval.length > 0) {
    print(`Tresc wymaga zatwierdzenia przy cwm start: ${result.needsApproval.join(', ')}.`);
  } else {
    print('Zatwierdzenie nastapi przy cwm start tylko wtedy, gdy tresc dostanie cechy wykonawcze.');
  }
}

/** Gdzie workflow jest wlaczony: firmy (`resources.enable`) i listy globalne w `config.yaml`. */
function enabledIn(workspace: Workspace, id: string): string[] {
  const out: string[] = [];
  for (const [company, loaded] of workspace.companies) {
    if (loaded.ok && loaded.value.resources.enable.workflows.includes(id))
      out.push(`firma ${company}`);
  }
  if (workspace.global.ok) {
    const { mandatory, optional } = workspace.global.value.resources;
    if (mandatory.workflows.includes(id)) out.push('globalnie (mandatory)');
    if (optional.workflows.includes(id)) out.push('globalnie (optional)');
  }
  return out;
}

const routingLabel = (workflow: Workflow): string =>
  workflow.routing === undefined ? 'brak' : workflow.routing.mode;

async function listWorkflows(ctx: Context): Promise<void> {
  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  const entries = workflowEntries(workspace.registry);
  if (ctx.json) {
    return printJson({
      ok: true,
      workflows: entries.map(({ workflow, entry }) => ({
        id: workflow.id,
        type: workflow.type,
        routing: workflow.routing ?? null,
        enabledIn: enabledIn(workspace, workflow.id),
        origin: entry.origin,
        file: entry.file,
      })),
    });
  }
  if (entries.length === 0)
    return print('Brak workflow. Dodaj: cwm workflow add <id> --from <plik.md>');
  print(
    table([
      ['WORKFLOW', 'TYP', 'ROUTING', 'PRIORYTET', 'WLACZONY'],
      ...entries.map(({ workflow }) => [
        workflow.id,
        workflow.type,
        routingLabel(workflow),
        String(workflow.routing?.priority ?? 0),
        enabledIn(workspace, workflow.id).join(', ') || '-',
      ]),
    ]),
  );
}

async function showWorkflow(ctx: Context, id: string): Promise<void> {
  await requireInitialized(ctx.layout);
  const workspace = await loadWorkspace(ctx.layout);
  const matches = workflowEntries(workspace.registry).filter(({ workflow }) => workflow.id === id);
  if (matches.length === 0) throw failure(`Workflow ${id} nie istnieje w rejestrze.`);
  if (matches.length > 1) throw failure(`Id ${id} ma w rejestrze kilka definicji (cwm doctor).`);
  const [match] = matches;
  if (match === undefined) throw failure(`Workflow ${id} nie istnieje w rejestrze.`);
  const { workflow, entry } = match;
  const command = workflowCommandName(workflow.id);
  const source = await readSourceFile(
    entry.dir,
    workflow.source.startsWith('./') ? workflow.source.slice(2) : workflow.source,
  );
  let approval: string[] | null = null;
  let problem: string | null = null;
  if (workflow.type === 'orchestrated')
    problem = 'typ orchestrated nie jest obslugiwany przez cwm run';
  else if (source === null)
    problem = `brak pliku zrodlowego ${WORKFLOW_SOURCE_FILE} albo jest niebezpieczny`;
  else {
    try {
      approval = [...checkWorkflowSource(source, workflow.id).needsApproval];
    } catch (error: unknown) {
      problem = error instanceof WorkflowCommandError ? error.message : 'nieczytelne zrodlo';
    }
  }
  const where = enabledIn(workspace, workflow.id);
  if (ctx.json) {
    return printJson({
      ok: true,
      id: workflow.id,
      type: workflow.type,
      file: entry.file,
      command: workflow.type === 'instructional' ? command : null,
      routing: workflow.routing ?? null,
      needsApproval: approval,
      problem,
      enabledIn: where,
    });
  }
  print(`Workflow: ${workflow.id}`);
  print(`Typ: ${workflow.type}`);
  print(`Plik: ${entry.file}`);
  print(
    workflow.type === 'instructional'
      ? `Zamienia sie w polecenie: /${command} (zasob obowiazkowy: /cwm-<firma>:${command})`
      : 'Zamienia sie w: nic (typ orchestrated, cwm run odmawia)',
  );
  const routing = workflow.routing;
  if (routing === undefined) print('Routing: brak (tylko --workflow albo domyslny)');
  else {
    print(`Routing: ${routing.mode}, priorytet ${routing.priority}`);
    print(`  slowa kluczowe: ${routing.keywords.join(', ') || '-'}`);
    for (const example of routing.examples) print(`  przyklad: ${example}`);
  }
  if (approval !== null) {
    print(
      approval.length > 0
        ? `Zatwierdzenie przy cwm start: ${approval.join(', ')}`
        : 'Zatwierdzenie przy cwm start: niewymagane (brak allowed-tools i wstawek !)',
    );
  }
  if (problem !== null) warn(`Problem: ${problem}`);
  print(`Wlaczony: ${where.join(', ') || '-'}`);
}

export function registerWorkflow(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Workflow instructional: dodawanie, lista i podglad regul routingu (cwm run)');

  workflow
    .command('add <id>')
    .description(
      'Dodaje workflow z pliku .md albo z komendy w rejestrze; id: global/<nazwa> albo <firma>/<nazwa>',
    )
    .option('--from <plik.md>', 'tresc workflow z pliku')
    .option('--from-command <id>', 'tresc workflow skopiowana z komendy z rejestru')
    .option(
      '--keywords <a,b>',
      'slowa kluczowe (po przecinku; fraza wielowyrazowa to jedna pozycja)',
    )
    .option('--example <tekst>', 'przykladowy opis zadania (mozna powtarzac)', collect, [])
    .option('--priority <n>', 'priorytet 0-1000 (rozstrzyga bliskie wyniki)')
    .option('--manual', 'routing.mode manual: tylko cwm run --workflow albo domyslny')
    .option('--enable <firma...>', 'dopisuje id do resources.enable.workflows wskazanych firm')
    .addOption(
      new Option('--global <lista>', 'dopisuje id do listy w config.yaml').choices([
        'optional',
        'mandatory',
      ]),
    )
    .action(async (id: string, options: AddOptions, command: Command) =>
      addWorkflow(contextOf(command), id, options),
    );

  workflow
    .command('list')
    .description('Wypisuje workflow z rejestru i katalogow firm, ich routing i gdzie sa wlaczone')
    .action(async (_options: unknown, command: Command) => listWorkflows(contextOf(command)));

  workflow
    .command('show <id>')
    .description(
      'Pokazuje routing workflow, polecenie, w ktore sie zamienia, i cechy do zatwierdzenia',
    )
    .action(async (id: string, _options: unknown, command: Command) =>
      showWorkflow(contextOf(command), id),
    );
}
