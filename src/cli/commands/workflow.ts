import { Option, type Command } from 'commander';

import { orderSteps, workflowCommandName, type Workflow, type WorkflowStep } from '../../core/cwm';
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
  readonly type?: 'instructional' | 'orchestrated';
  readonly step?: readonly string[];
  readonly after?: readonly string[];
  readonly stepTask?: readonly string[];
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

/** `<id>=<wartosc>`: dzieli po pierwszym `=`, wartosc moze zawierac kolejne. */
function splitPair(raw: string, option: string): [string, string] {
  const at = raw.indexOf('=');
  if (at <= 0) throw usageError(`${option}: oczekiwano <id-kroku>=<wartosc>, dostano "${raw}".`);
  return [raw.slice(0, at).trim(), raw.slice(at + 1)];
}

/** Kroki z `--step`, `--after` i `--step-task`; walidacja ksztaltu (id, agent, task) zostaje po stronie walidatora zasobu. */
function parseSteps(options: AddOptions): WorkflowStep[] {
  const order: string[] = [];
  const agents = new Map<string, string>();
  for (const raw of options.step ?? []) {
    const [id, agent] = splitPair(raw, '--step');
    if (agents.has(id)) throw usageError(`--step: krok "${id}" podany dwa razy.`);
    agents.set(id, agent.trim());
    order.push(id);
  }
  const deps = new Map<string, string[]>();
  for (const raw of options.after ?? []) {
    const [id, list] = splitPair(raw, '--after');
    if (!agents.has(id)) throw usageError(`--after: nieznany krok "${id}" (najpierw --step).`);
    if (deps.has(id)) throw usageError(`--after: krok "${id}" podany dwa razy.`);
    deps.set(
      id,
      list
        .split(',')
        .map((dep) => dep.trim())
        .filter((dep) => dep !== ''),
    );
  }
  const tasks = new Map<string, string>();
  for (const raw of options.stepTask ?? []) {
    const [id, task] = splitPair(raw, '--step-task');
    if (!agents.has(id)) throw usageError(`--step-task: nieznany krok "${id}" (najpierw --step).`);
    if (tasks.has(id)) throw usageError(`--step-task: krok "${id}" podany dwa razy.`);
    tasks.set(id, task);
  }
  return order.map((id) => {
    const task = tasks.get(id);
    return {
      id,
      agent: agents.get(id) ?? '',
      dependsOn: deps.get(id) ?? [],
      ...(task === undefined ? {} : { task }),
    };
  });
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
  const type = options.type ?? 'instructional';
  const steps = parseSteps(options);
  if (type === 'orchestrated' && steps.length === 0) {
    throw usageError('--type orchestrated wymaga co najmniej jednego --step <id>=<agent>.');
  }
  if (
    type === 'instructional' &&
    (steps.length > 0 || (options.after?.length ?? 0) > 0 || (options.stepTask?.length ?? 0) > 0)
  ) {
    throw usageError('--step, --after i --step-task dzialaja tylko z --type orchestrated.');
  }

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
      steps,
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
      ? `Dodano workflow ${result.id}${type === 'orchestrated' ? ` (${steps.length} krokow)` : ''} (polecenie /${workflowCommandName(result.id)}).`
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
  const ordered = workflow.type === 'orchestrated' ? orderSteps(workflow.steps) : null;
  if (source === null)
    problem = `brak pliku zrodlowego ${WORKFLOW_SOURCE_FILE} albo jest niebezpieczny`;
  else {
    try {
      approval = [...checkWorkflowSource(source, workflow.id, workflow.steps).needsApproval];
    } catch (error: unknown) {
      problem = error instanceof WorkflowCommandError ? error.message : 'nieczytelne zrodlo';
    }
  }
  if (ordered !== null && !ordered.ok) problem = ordered.reason;
  const where = enabledIn(workspace, workflow.id);
  const stages = ordered !== null && ordered.ok ? ordered.stages : null;
  if (ctx.json) {
    return printJson({
      ok: true,
      id: workflow.id,
      type: workflow.type,
      file: entry.file,
      command,
      stages:
        stages?.map((stage) => ({
          index: stage.index,
          steps: stage.steps.map((step) => ({
            id: step.id,
            agent: step.agent,
            dependsOn: step.dependsOn,
            task: step.task ?? null,
          })),
        })) ?? null,
      routing: workflow.routing ?? null,
      needsApproval: approval,
      problem,
      enabledIn: where,
    });
  }
  print(`Workflow: ${workflow.id}`);
  print(`Typ: ${workflow.type}`);
  print(`Plik: ${entry.file}`);
  print(`Zamienia sie w polecenie: /${command} (zasob obowiazkowy: /cwm-<firma>:${command})`);
  for (const stage of stages ?? []) {
    print(`Etap ${stage.index}${stage.steps.length > 1 ? ' (kroki moga isc rownolegle)' : ''}:`);
    for (const step of stage.steps) {
      print(
        `  ${step.id}: agent ${step.agent}, zalezy od: [${step.dependsOn.join(', ')}]${
          step.task === undefined ? '' : `, polecenie: ${step.task}`
        }`,
      );
    }
  }
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
    .description('Workflow instructional i orchestrated: dodawanie, lista i podglad (cwm run)');

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
      new Option('--type <typ>', 'typ workflow (domyslnie instructional)').choices([
        'instructional',
        'orchestrated',
      ]),
    )
    .option(
      '--step <id=agent>',
      'krok orchestrated: id kroku i id agenta (mozna powtarzac)',
      collect,
      [],
    )
    .option('--after <id=a,b>', 'zaleznosci kroku: krok i id krokow, po ktorych idzie', collect, [])
    .option('--step-task <id=tekst>', 'polecenie kroku (jedna linia, do 1000 znakow)', collect, [])
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
