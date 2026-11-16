import { hasUnterminatedSnippet } from './content';
import { foldName } from './names';
import { usesTaskPlaceholder, type TaskCheck } from './routing';
import type { WorkflowStep } from './resource';

/**
 * Workflow `orchestrated` jako skompilowana komenda (ADR 0050): czyste funkcje bez I/O. Kolejnosc
 * krokow, walidacja tekstu `task` i skladanie tresci komendy zyja tutaj, a plan (`runtime-plan.ts`)
 * tylko podaje im nazwy agentow tak, jak widzi je silnik.
 */

/** Najwiecej znakow w `task` kroku. */
export const MAX_STEP_TASK_LENGTH = 1000;

/**
 * Nazwa agenta wpisywana do tresci komendy: litery, cyfry i `_ . : -`, bez bialych znakow i odwrotnych
 * apostrofow. Nazwa z frontmattera agenta jest dowolnym tekstem, wiec to, co nie pasuje, jest bledem planu.
 */
export const RENDERABLE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Typy subagentow wbudowanych w silnik: nazwa agenta z workflow nie moze ich przeslaniac. */
export const BUILTIN_SUBAGENT_TYPES: readonly string[] = [
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide',
];

/**
 * Nazwa agenta, pod ktora komenda go wywola (SEC-ORCH-01). `raw` to nazwa z profilu albo pluginu bez przedrostka.
 * Dwukropek w nazwie zlewalby sie z przedrostkiem pluginu, a nazwa wbudowanego typu wskazalaby agenta silnika.
 * Zwraca powod odrzucenia albo `null`.
 */
export function agentNameProblem(raw: string, rendered: string): string | null {
  if (!RENDERABLE_AGENT_NAME.test(rendered)) {
    return 'nazwa agenta ma niedozwolone znaki (dozwolone: litery, cyfry, _ . : -)';
  }
  if (raw.includes(':')) {
    return 'nazwa agenta zawiera dwukropek (kolizja z przedrostkiem pluginu)';
  }
  const folded = foldName(rendered);
  if (BUILTIN_SUBAGENT_TYPES.some((type) => foldName(type) === folded)) {
    return `nazwa agenta to wbudowany typ subagenta silnika (${rendered})`;
  }
  return null;
}

/**
 * `task` kroku to jedna linia: bez nowych linii, tabulatorow, znakow sterujacych i formatujacych. Dzieki temu
 * nie moze udawac naglowka, kolejnego kroku ani zaczac frontmattera. Wstawki `!` i placeholdery nadal przechodza,
 * bo podlegaja zatwierdzeniu i kontroli powloki jak tresc komendy.
 */
export function validateStepTask(raw: string): TaskCheck {
  const task = raw.trim();
  if (task === '') return { ok: false, reason: 'Tekst zadania kroku jest pusty.' };
  if (task.length > MAX_STEP_TASK_LENGTH) {
    return { ok: false, reason: `Tekst zadania kroku ma ponad ${MAX_STEP_TASK_LENGTH} znakow.` };
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(task)) {
    return {
      ok: false,
      reason: 'Tekst zadania kroku ma byc jedna linia bez znakow sterujacych i formatujacych.',
    };
  }
  return { ok: true, task };
}

export interface OrchestrationStage {
  /** Numer etapu od 1. */
  readonly index: number;
  /** Kroki tego etapu w kolejnosci deklaracji; nie zalezą od siebie, wiec moga isc rownolegle. */
  readonly steps: readonly WorkflowStep[];
}

export type StageOrder =
  | { readonly ok: true; readonly stages: readonly OrchestrationStage[] }
  | { readonly ok: false; readonly reason: string };

/** Pierwszy cykl zaleznosci jako lista id, z powtorzonym pierwszym krokiem na koncu (`a`, `b`, `a`); pusta, gdy brak. */
export function findCycle(steps: readonly WorkflowStep[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const at = stack.indexOf(id);
    if (at >= 0) return [...stack.slice(at), id];
    if (done.has(id)) return null;
    const step = byId.get(id);
    if (step === undefined) return null;
    stack.push(id);
    for (const dep of step.dependsOn) {
      const found = visit(dep);
      if (found !== null) return found;
    }
    stack.pop();
    done.add(id);
    return null;
  };
  for (const step of steps) {
    const found = visit(step.id);
    if (found !== null) return found;
  }
  return [];
}

export const cycleMessage = (cycle: readonly string[]): string =>
  cycle.length === 0
    ? 'Kroki tworza cykl zaleznosci.'
    : `Kroki tworza cykl zaleznosci: ${cycle.join(' -> ')}.`;

/**
 * Porzadek topologiczny warstwami: etap n to kroki, ktorych zaleznosci sa w calosci w etapach wczesniejszych.
 * W obrebie etapu zostaje kolejnosc z deklaracji, wiec wynik jest powtarzalny. Nieznany krok albo cykl to blad.
 */
export function orderSteps(steps: readonly WorkflowStep[]): StageOrder {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) return { ok: false, reason: 'Id krokow nie sa unikalne.' };
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) return { ok: false, reason: `Krok "${step.id}": nieznany krok "${dep}".` };
    }
  }
  const placed = new Set<string>();
  let remaining = [...steps];
  const stages: OrchestrationStage[] = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((step) => step.dependsOn.every((dep) => placed.has(dep)));
    if (ready.length === 0) {
      const cycle = findCycle(remaining);
      return { ok: false, reason: cycleMessage(cycle) };
    }
    stages.push({ index: stages.length + 1, steps: ready });
    for (const step of ready) placed.add(step.id);
    remaining = remaining.filter((step) => !placed.has(step.id));
  }
  return { ok: true, stages };
}

/**
 * Stala czesc tresci jest po angielsku i nie zawiera odwrotnych apostrofow, `!` ani `$`: nic z niej nie moze
 * stworzyc wstawki ani placeholdera. Zmienne czesci to id krokow (`[a-z0-9-]`), nazwy agentow
 * (`RENDERABLE_AGENT_NAME`) i `task` (jedna linia).
 */
const INTRO = [
  '## Orchestrated steps',
  '',
  'This workflow runs in one session. Work through the stages below in order. Steps in the same stage do not',
  'depend on each other and may run in parallel. Do not start a stage before every step of the earlier stages',
  'has finished.',
  '',
  'For each step, delegate the work to the named subagent with the agent tool (use the agent name as the subagent',
  'type). Give the subagent the overall task of this command, the instruction of the step and the results of the',
  'steps it depends on. Do not do the work of a step yourself. If a step fails, stop and report it instead of',
  'continuing with the dependent steps.',
  '',
  'When every stage is done, finish with a short summary of what each step produced.',
];

export const TASK_LINE = 'Task: $ARGUMENTS';

/** Sekcja krokow: etapy, id kroku, agent, zaleznosci i instrukcja. */
export function renderOrchestration(
  stages: readonly OrchestrationStage[],
  agentNames: ReadonlyMap<string, string>,
): string {
  const lines = [...INTRO];
  for (const stage of stages) {
    lines.push('', `### Stage ${stage.index}`);
    for (const step of stage.steps) {
      lines.push(
        '',
        `- Step ${step.id}`,
        `  - Agent: ${agentNames.get(step.id) ?? step.agent}`,
        `  - Depends on: ${step.dependsOn.length === 0 ? 'none' : step.dependsOn.join(', ')}`,
        `  - Instruction: ${step.task ?? 'none, use the overall task'}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface ComposedOrchestration {
  /** Tresc komendy: zrodlo, sekcja krokow i (gdy zrodlo nie ma placeholdera) wiersz zadania na samym koncu. */
  readonly text: string;
  /** Tekst do `taskReachesShell`: zrodlo i sekcja bez doklejonego wiersza zadania. */
  readonly shellCheckText: string;
  /** Zrodlo albo `task` ma niedomknieta wstawke przed doklejonym wierszem zadania (SEC-ORCH-03). */
  readonly unterminatedSnippet: boolean;
}

/**
 * Sklada tresc komendy. Wiersz `Task: $ARGUMENTS` jest doklejany wylacznie, gdy samo zrodlo nie ma placeholdera
 * (`task` kroku nic tu nie zmienia, SEC-01 z ADR 0049), i zawsze na samym koncu: zadna wstawka zaczeta w zrodle
 * albo w `task` nie ma po nim zamykajacego odwrotnego apostrofu, wiec nie moze objac placeholdera. Sprawdzenie
 * powloki dziala na zrodle i sekcji razem: placeholder w `task` plus dowolny znacznik wstawki w calosci to blad.
 */
export function composeOrchestration(source: string, section: string): ComposedOrchestration {
  const body = source === '' || source.endsWith('\n') ? source : `${source}\n`;
  const shellCheckText = body === '' ? section : `${body}\n${section}`;
  const text = usesTaskPlaceholder(source) ? shellCheckText : `${shellCheckText}\n${TASK_LINE}\n`;
  return { text, shellCheckText, unterminatedSnippet: hasUnterminatedSnippet(shellCheckText) };
}
