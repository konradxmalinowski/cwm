import type { Command } from 'commander';

import {
  decideWorkflow,
  MIN_ROUTING_SCORE,
  scoreWorkflows,
  validateTask,
  workflowPrompt,
  type RoutingCandidate,
  type WorkflowScore,
} from '../../core/cwm';
import { denyNetwork, type PlannedStage } from '../../infra/cwm';
import { contextOf, failure, print, safeText, table, usageError, type Context } from '../context';
import { promptSelect } from '../prompts';
import { launchPrepared, prepareRun, refuse, type PreparedRun } from './start';

interface RunOptions {
  readonly project?: string;
  readonly workflow?: string;
  readonly strictMcp?: boolean;
  readonly dryRun?: boolean;
  readonly explain?: boolean;
  readonly frozen?: boolean;
  readonly verbose?: boolean;
}

type Basis = 'forced' | 'score' | 'default' | 'default-tiebreak' | 'chosen';

interface Choice {
  readonly id: string;
  readonly basis: Basis;
  /** Skad pochodzi workflow domyslny (przy `default*`). */
  readonly defaultFrom: 'project' | 'company' | null;
}

const BASIS_TEXT: Record<Basis, string> = {
  forced: 'wskazany przez --workflow',
  score: 'wyrazny lider wedlug wyniku',
  default: 'brak trafienia, uzyto workflow domyslnego',
  'default-tiebreak': 'remis rozstrzygniety workflow domyslnym',
  chosen: 'wybrany z listy',
};

const scoreText = (score: number): string => score.toFixed(2);

/** Powod wyniku: ktore slowa kluczowe i jaki przyklad trafily oraz ile dodal priorytet. */
function reasonOf(score: WorkflowScore): string {
  const parts: string[] = [];
  if (score.keywords.length > 0) {
    parts.push(`slowa kluczowe: ${score.keywords.map((k) => `"${k.text}"`).join(', ')}`);
  }
  if (score.example !== null) {
    parts.push(`przyklad "${score.example.text}" (wspolne: ${score.example.shared.join(', ')})`);
  }
  if (score.priorityPoints > 0) {
    parts.push(`priorytet ${score.priority} (+${scoreText(score.priorityPoints)})`);
  }
  if (parts.length > 0) return parts.join('; ');
  return score.auto ? 'brak trafien' : 'wylaczony z automatu (routing manual albo brak routingu)';
}

function candidatesOf(prepared: PreparedRun): RoutingCandidate[] {
  return prepared.effective.resources.flatMap((entry) =>
    entry.resource.kind === 'workflow'
      ? [
          {
            id: entry.resource.id,
            type: entry.resource.type,
            routing: entry.resource.routing ?? null,
          },
        ]
      : [],
  );
}

/** Workflow domyslny: projekt przed firma. Id spoza aktywnych jest ostrzezeniem, nie wyborem. */
function defaultOf(
  prepared: PreparedRun,
  active: ReadonlySet<string>,
  warnings: string[],
): { id: string; from: 'project' | 'company' } | null {
  const record = prepared.record.loaded;
  const fromProject = record.ok ? record.value.spec.workflows.default : undefined;
  const fromCompany = prepared.company.workflows?.default;
  const pick =
    fromProject !== undefined
      ? ({ id: fromProject, from: 'project' } as const)
      : fromCompany !== undefined
        ? ({ id: fromCompany, from: 'company' } as const)
        : null;
  if (pick === null) return null;
  if (!active.has(pick.id)) {
    warnings.push(
      `Workflow domyslny ${pick.id} (${pick.from === 'project' ? 'projekt' : 'firma'}) nie jest aktywny w projekcie i jest pominiety.`,
    );
    return null;
  }
  return pick;
}

/** `--workflow`: pelne id, a bez przestrzeni nazw sama nazwa, jesli jest jednoznaczna. */
function resolveForced(wanted: string, ids: readonly string[]): string | null {
  if (ids.includes(wanted)) return wanted;
  if (wanted.includes('/')) return null;
  const byName = ids.filter((id) => id.slice(id.indexOf('/') + 1) === wanted);
  return byName.length === 1 ? (byName[0] ?? null) : null;
}

function listing(scores: readonly WorkflowScore[], limit: number): string[] {
  return scores
    .slice(0, limit)
    .map((s) => `  ${s.id} (wynik ${scoreText(s.score)}${s.auto ? '' : ', reczny'})`);
}

function ambiguityMessage(
  kind: 'tie' | 'none',
  ids: readonly string[],
  scores: readonly WorkflowScore[],
): string {
  const head =
    kind === 'tie'
      ? 'Opis pasuje do kilku workflow rownie dobrze.'
      : `Opis nie pasuje wyraznie do zadnego workflow (prog ${MIN_ROUTING_SCORE}).`;
  const shown = kind === 'tie' ? scores.filter((s) => ids.includes(s.id)) : scores;
  return [head, ...listing(shown, 10), 'Wskaz workflow: cwm run --workflow <id> "<zadanie>".'].join(
    '\n',
  );
}

async function choose(
  ctx: Context,
  options: RunOptions,
  scores: readonly WorkflowScore[],
  active: readonly string[],
  def: { id: string; from: 'project' | 'company' } | null,
  warnings: readonly string[],
): Promise<Choice> {
  if (options.workflow !== undefined) {
    const id = resolveForced(options.workflow, active);
    if (id === null) {
      refuse(
        ctx,
        `Workflow "${options.workflow}" nie jest aktywny w projekcie. Aktywne: ${active.join(', ') || '(brak)'}.`,
      );
    }
    return { id, basis: 'forced', defaultFrom: null };
  }
  const decision = decideWorkflow(scores, def?.id ?? null);
  if (decision.state === 'selected') {
    const fromDefault = decision.basis !== 'score';
    return {
      id: decision.id,
      basis: decision.basis,
      defaultFrom: fromDefault ? (def?.from ?? null) : null,
    };
  }
  const message = [
    ambiguityMessage(decision.state, decision.state === 'tie' ? decision.ids : [], scores),
    ...warnings.map((text) => `Ostrzezenie: ${text}`),
  ].join('\n');
  // --dry-run niczego nie pyta: pokazuje, ze prawdziwe uruchomienie wymaga wyboru.
  if (!ctx.interactive || options.dryRun === true) refuse(ctx, message);
  const pool =
    decision.state === 'tie' ? scores.filter((s) => decision.ids.includes(s.id)) : scores;
  const labels = pool
    .slice(0, 10)
    .map((s) => safeText(`${s.id} (wynik ${scoreText(s.score)}${s.auto ? '' : ', reczny'})`));
  const abort = 'Przerwij';
  const answer = await promptSelect(
    safeText(
      decision.state === 'tie'
        ? 'Opis pasuje do kilku workflow rownie dobrze. Ktory uruchomic?'
        : 'Opis nie pasuje wyraznie do zadnego workflow. Ktory uruchomic?',
    ),
    [...labels, abort],
  );
  if (answer === abort) throw failure('Przerwano, nic nie zapisano.');
  const picked = pool[labels.indexOf(answer)];
  if (picked === undefined) throw failure('Nie wybrano workflow.');
  return { id: picked.id, basis: 'chosen', defaultFrom: null };
}

/** Etapy workflow orchestrated: numer, kroki, agenci i zaleznosci (te same nazwy, ktore widzi silnik). */
function stageLines(stages: readonly PlannedStage[] | undefined): string[] {
  if (stages === undefined) return [];
  return stages.flatMap((stage) => [
    `Etap ${stage.index}${stage.steps.length > 1 ? ' (kroki moga isc rownolegle)' : ''}:`,
    ...stage.steps.map(
      (step) =>
        `  ${step.id}: agent ${safeText(step.agent)}, zalezy od: [${step.dependsOn.join(', ')}]`,
    ),
  ]);
}

function summary(
  scores: readonly WorkflowScore[],
  choice: Choice,
  slash: string,
  stages: readonly PlannedStage[] | undefined,
  options: RunOptions,
): string[] {
  const picked = scores.find((s) => s.id === choice.id);
  const lines = [
    `Workflow: ${choice.id}${picked === undefined ? '' : ` (wynik ${scoreText(picked.score)})`}`,
    `Wybor: ${BASIS_TEXT[choice.basis]}${
      choice.defaultFrom === null
        ? ''
        : ` (${choice.defaultFrom === 'project' ? 'projekt' : 'firma'})`
    }`,
  ];
  if (picked !== undefined) lines.push(`Powod: ${reasonOf(picked)}`);
  lines.push(`Polecenie: /${slash}`, ...stageLines(stages));
  const others = scores.filter((s) => s.id !== choice.id);
  if (options.explain !== true && others.length > 0) {
    lines.push('Kolejni kandydaci:', ...listing(others, 2));
  }
  return lines;
}

function explainTable(scores: readonly WorkflowScore[], chosen: string): string {
  return table([
    ['WORKFLOW', 'TYP', 'WYNIK', 'TRYB', 'POWOD'],
    ...scores.map((s) => [
      `${s.id}${s.id === chosen ? ' *' : ''}`,
      s.type,
      scoreText(s.score),
      s.auto ? 'auto' : 'reczny',
      reasonOf(s),
    ]),
  ]);
}

async function runCommand(
  ctx: Context,
  words: readonly string[],
  options: RunOptions,
): Promise<void> {
  if (process.platform === 'win32') {
    throw failure('cwm run nie dziala na Windowsie w tym etapie (silnik wymaga powloki .cmd).');
  }
  const checked = validateTask(words.join(' '));
  if (!checked.ok) throw usageError(checked.reason);
  if (ctx.json && options.dryRun !== true) {
    throw usageError('--json w cwm run wymaga --dry-run (sesja silnika jest interaktywna).');
  }

  const prepared = await prepareRun(ctx, options.project, []);
  const candidates = candidatesOf(prepared);
  if (candidates.length === 0) {
    refuse(
      ctx,
      'Projekt nie ma aktywnych workflow. Dodaj: cwm workflow add <id> --from <plik.md> --enable <firma>.',
    );
  }
  const warnings: string[] = [];
  const active = candidates.map((c) => c.id).sort();
  const def = defaultOf(prepared, new Set(active), warnings);
  const scores = scoreWorkflows(checked.task, candidates);
  const choice = await choose(ctx, options, scores, active, def, warnings);

  const planned = prepared.plan.workflows.find((w) => w.id === choice.id);
  if (planned === undefined || planned.slash === null) {
    refuse(ctx, `Workflow ${choice.id} nie ma polecenia w profilu.`);
  }
  const command = planned.slash.slice(planned.slash.indexOf(':') + 1);
  if (prepared.plan.shadowedWorkflowCommands.includes(command)) {
    refuse(
      ctx,
      `Natywny zasob projektu (.claude/commands/${command}.md albo .claude/skills/${command}/) zaslania polecenie workflow ${choice.id}: ` +
        'silnik uruchomilby plik z projektu zamiast zatwierdzonej tresci. Usun go albo zmien nazwe workflow.',
    );
  }
  const prompt = workflowPrompt(planned.slash, checked.task);

  const extra = {
    workflow: {
      id: choice.id,
      basis: choice.basis,
      default: def === null ? null : { id: def.id, from: def.from },
      command: `/${planned.slash}`,
      type: planned.type,
      stages: planned.stages ?? null,
      minScore: MIN_ROUTING_SCORE,
      scores,
      warnings,
    },
  };
  if (!ctx.json) {
    for (const line of summary(scores, choice, planned.slash, planned.stages, options)) print(line);
    if (options.explain === true) {
      print('');
      print(explainTable(scores, choice.id));
    }
    for (const text of warnings) print(`Ostrzezenie: ${text}`);
    print('');
  }
  await launchPrepared(
    ctx,
    { ...(options.project === undefined ? {} : { project: options.project }), ...flags(options) },
    prepared,
    [prompt],
    extra,
  );
}

const flags = (
  options: RunOptions,
): { strictMcp?: boolean; dryRun?: boolean; frozen?: boolean; verbose?: boolean } => ({
  ...(options.strictMcp === true ? { strictMcp: true } : {}),
  ...(options.verbose === true ? { verbose: true } : {}),
  ...(options.frozen === true ? { frozen: true } : {}),
  ...(options.dryRun === true ? { dryRun: true } : {}),
});

export function registerRun(program: Command): void {
  program
    .command('run')
    .description(
      'Dobiera workflow do opisu zadania (slowa kluczowe, przyklady, priorytet) i uruchamia cwm start z poleceniem tego workflow',
    )
    .argument(
      '<zadanie...>',
      'opis zadania (jeden argument silnika; zaczynajace sie od "-" po "--")',
    )
    .option('--project <katalog>', 'katalog projektu (domyslnie biezacy, z szukaniem w gore)')
    .option('--workflow <id>', 'pomija routing i uruchamia wskazany workflow')
    .option('--strict-mcp', 'dodaje --strict-mcp-config: tylko serwery MCP wygenerowane przez CWM')
    .option(
      '--dry-run',
      'pokazuje wybor workflow i plan startu bez zapisu i bez uruchamiania silnika',
    )
    .option('--explain', 'pelna tabela wynikow wszystkich workflow')
    .option('--frozen', 'odmawia startu, gdy zasoby rozni sie od lockfile (jak spec.lock: frozen)')
    .option(
      '--verbose',
      'z --dry-run: pelne listy zatwierdzonych zasobow, plikow i przepisanych odwolan',
    )
    .action(async (words: string[], options: RunOptions, command: Command) => {
      denyNetwork();
      return runCommand(contextOf(command), words, options);
    });
}
