import { describe, expect, it } from 'vitest';

import {
  agentNameProblem,
  buildEngineArgv,
  checkPassThroughArgs,
  composeOrchestration,
  decideWorkflow,
  ENGINE_SUBCOMMANDS,
  MAX_TASK_LENGTH,
  orderSteps,
  renderOrchestration,
  scoreWorkflows,
  validateTask,
  withTaskPlaceholder,
  workflowCommandName,
  workflowPrompt,
  taskReachesShell,
  extractInlineCommands,
  hasInlineCommands,
  hasUnterminatedSnippet,
  type ArgvInput,
  type RoutingCandidate,
  type WorkflowStep,
} from '../../src/core/cwm';

const base: ArgvInput = {
  settingsFile: '/cwm/runtime/acme-a/sessions/0123456789abcdef/settings.json',
  mcpConfigFile: '/cwm/runtime/acme-a/sessions/0123456789abcdef/mcp.json',
  pluginDirs: [
    '/cwm/runtime/acme-a/sessions/0123456789abcdef/plugin',
    '/cwm/runtime/acme-a/plugins/acme-a-tools@0123456789abcdef',
  ],
  strictMcp: false,
  userArgs: [],
};

function argvOf(overrides: Partial<ArgvInput> = {}): readonly string[] {
  const result = buildEngineArgv({ ...base, ...overrides });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.argv;
}

describe('buildEngineArgv (SPN-03, V-05, V-06)', () => {
  it('flagi wielowartosciowe maja forme --flaga=wartosc, a --settings jest ostatnia flaga CWM', () => {
    const argv = argvOf();
    expect(argv).toEqual([
      `--plugin-dir=${base.pluginDirs[0]}`,
      `--plugin-dir=${base.pluginDirs[1]}`,
      `--mcp-config=${base.mcpConfigFile}`,
      '--settings',
      base.settingsFile,
    ]);
  });

  it('prompt idzie po "--", a tuz przed nim stoi wartosc jednowartosciowej flagi --settings', () => {
    const argv = argvOf({ userArgs: ['napraw test'] });
    expect(argv.slice(-4)).toEqual(['--settings', base.settingsFile, '--', 'napraw test']);
    expect(argv.filter((arg) => arg === '--mcp-config' || arg === '--plugin-dir')).toEqual([]);
  });

  it('argumenty z opcjami nie dostaja "--" (inaczej -p stalby sie tekstem promptu)', () => {
    const argv = argvOf({ userArgs: ['-p', 'napraw test', '--model', 'haiku'] });
    expect(argv).not.toContain('--');
    expect(argv.slice(-4)).toEqual(['-p', 'napraw test', '--model', 'haiku']);
  });

  it('bez konfiguracji MCP i pluginow zostaje tylko --settings', () => {
    expect(argvOf({ mcpConfigFile: null, pluginDirs: [] })).toEqual([
      '--settings',
      base.settingsFile,
    ]);
  });

  it('--strict-mcp dodaje --strict-mcp-config przed --settings', () => {
    const argv = argvOf({ strictMcp: true });
    expect(argv.indexOf('--strict-mcp-config')).toBeGreaterThan(-1);
    expect(argv.indexOf('--strict-mcp-config')).toBeLessThan(argv.indexOf('--settings'));
  });

  it('prompt wygladajacy jak plik nie ma pierwszenstwa przed --: stoi po separatorze', () => {
    const argv = argvOf({ userArgs: ['/etc/passwd'] });
    expect(argv.slice(-2)).toEqual(['--', '/etc/passwd']);
  });
});

describe('checkPassThroughArgs', () => {
  it.each([
    '--settings',
    '--mcp-config',
    '--strict-mcp-config',
    '--plugin-dir',
    '--plugin-url',
    '--setting-sources',
    '--bare',
    '--safe-mode',
  ])('odrzuca zarzadzana flage %s w obu formach', (flag) => {
    expect(checkPassThroughArgs([flag, 'x']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs([`${flag}=x`]).length).toBeGreaterThan(0);
    expect(buildEngineArgv({ ...base, userArgs: [`${flag}=x`] }).ok).toBe(false);
  });

  it.each([
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--agents',
    '--debug-file',
    '--file',
    '--desktop',
    '--cloud',
    '--teleport',
    '--remote-control',
    '--environment',
  ])('odrzuca flage %s', (flag) => {
    expect(checkPassThroughArgs([flag]).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs([`${flag}=x`]).length).toBeGreaterThan(0);
  });

  it('odrzuca tryb bypassPermissions w obu formach, ale nie inne tryby', () => {
    expect(checkPassThroughArgs(['--permission-mode', 'bypassPermissions']).length).toBeGreaterThan(
      0,
    );
    expect(checkPassThroughArgs(['--permission-mode=bypassPermissions']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--permission-mode=BYPASSPERMISSIONS']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--permission-mode', 'plan'])).toEqual([]);
  });

  it.each(ENGINE_SUBCOMMANDS)(
    'odrzuca podpolecenie silnika "%s" jako pierwszy argument',
    (name) => {
      expect(checkPassThroughArgs([name, 'add']).length).toBeGreaterThan(0);
      expect(checkPassThroughArgs(['--verbose', name]).length).toBeGreaterThan(0);
    },
  );

  it('podpolecenie jako dalsze slowo promptu jest dozwolone', () => {
    expect(checkPassThroughArgs(['napraw mcp i plugin'])).toEqual([]);
    expect(checkPassThroughArgs(['-p', 'update the docs'])).toEqual([]);
  });

  it('odrzuca podpolecenie jako dowolny argument pozycyjny, nie tylko pierwszy (SEC-02)', () => {
    expect(checkPassThroughArgs(['--model', 'haiku', 'mcp', 'add', 'evil']).length).toBeGreaterThan(
      0,
    );
    expect(
      checkPassThroughArgs(['--resume', 'abc123', 'plugin', 'install', 'x']).length,
    ).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['-p', 'tekst', 'config', 'set']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--add-dir', '/tmp/x', 'install']).length).toBeGreaterThan(0);
    expect(buildEngineArgv({ ...base, userArgs: ['--model', 'x', 'mcp', 'add', 'y'] }).ok).toBe(
      false,
    );
  });

  it.each([
    'plugins',
    'upgrade',
    'kill',
    'gateway',
    'import',
    'auto-mode',
    'purge',
    'respawn',
    'ultrareview',
  ])('odrzuca alias/podpolecenie %s z claude --help 2.1.322', (name) => {
    expect(checkPassThroughArgs([name]).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['--model', 'x', name, 'arg']).length).toBeGreaterThan(0);
  });

  it('wartosc opcji po znaku = nie jest argumentem pozycyjnym', () => {
    expect(checkPassThroughArgs(['--model=mcp', '-p', 'hej'])).toEqual([]);
  });

  it('odrzuca drugie "--" i znak NUL', () => {
    expect(checkPassThroughArgs(['--', 'x']).length).toBeGreaterThan(0);
    expect(checkPassThroughArgs(['a\0b']).length).toBeGreaterThan(0);
  });

  it('przepuszcza zwykle flagi i prompt', () => {
    expect(checkPassThroughArgs(['-p', 'hej', '--model', 'haiku', '--max-turns', '3'])).toEqual([]);
    expect(checkPassThroughArgs([])).toEqual([]);
  });
});

describe('cwm run: zadanie jako argument silnika (ADR 0049)', () => {
  const prompt = (task: string): string =>
    workflowPrompt(workflowCommandName('acme-a/review'), task);

  it('zadanie zaczynajace sie od - nie moze stac sie flaga: caly prompt zaczyna sie od / i stoi po "--"', () => {
    const task = '--settings=/tmp/x -p --dangerously-skip-permissions';
    const argv = argvOf({ userArgs: [prompt(task)] });
    expect(argv.slice(-2)).toEqual(['--', `/cwm-review ${task}`]);
    expect(argv.filter((arg) => arg === '--settings')).toEqual(['--settings']);
    expect(checkPassThroughArgs([prompt(task)])).toEqual([]);
  });

  it('tekst zadania jest jednym argumentem (spacje, cudzyslowy, znaki powloki)', () => {
    const task = 'napraw "test" $(id) `whoami`; echo $HOME | cat';
    const argv = argvOf({ userArgs: [prompt(task)] });
    expect(argv.at(-1)).toBe(`/cwm-review ${task}`);
    expect(argv.filter((arg) => arg.includes('whoami'))).toHaveLength(1);
  });

  it('zadanie, ktore wygladalo na podpolecenie silnika, nie jest nim w prompcie', () => {
    expect(checkPassThroughArgs([prompt('mcp add evil')])).toEqual([]);
    expect(checkPassThroughArgs(['mcp add evil'])).toEqual([]);
    expect(checkPassThroughArgs(['mcp', 'add', 'evil']).length).toBeGreaterThan(0);
  });

  it('validateTask odrzuca puste, zbyt dlugie i ze znakami sterujacymi, przepuszcza nowa linie', () => {
    expect(validateTask('   ').ok).toBe(false);
    expect(validateTask('x'.repeat(MAX_TASK_LENGTH + 1)).ok).toBe(false);
    expect(validateTask('a\u001b[31mb').ok).toBe(false);
    expect(validateTask('a\0b').ok).toBe(false);
    expect(validateTask('a\u202eb').ok).toBe(false);
    expect(validateTask('  linia 1\n\tlinia 2  ')).toEqual({
      ok: true,
      task: 'linia 1\n\tlinia 2',
    });
  });

  it('wstawka z $ARGUMENTS wpuszczalaby zadanie do powloki; tekst dostaje brakujacy placeholder', () => {
    expect(taskReachesShell('Run !`echo $ARGUMENTS`')).toBe(true);
    expect(taskReachesShell('Run !`git log $ARGUMENTSx`')).toBe(true);
    expect(taskReachesShell('Run !`echo $10`')).toBe(true);
    expect(taskReachesShell('Run !`echo\n$ARGUMENTS`')).toBe(true);
    expect(taskReachesShell('text ```!echo $ARGUMENTS``` more')).toBe(true);
    expect(taskReachesShell('x ```!\necho $1\n```')).toBe(true);
    expect(taskReachesShell('x ~~~!\necho $1\n~~~')).toBe(true);
    expect(taskReachesShell('Run !`git status`, task: $ARGUMENTS')).toBe(true);
    expect(taskReachesShell('Run !`git status`')).toBe(false);
    expect(taskReachesShell('Task: $ARGUMENTS')).toBe(false);
    expect(withTaskPlaceholder('Instrukcja.\n')).toBe('Instrukcja.\n\nTask: $ARGUMENTS\n');
    expect(withTaskPlaceholder('Zrob $ARGUMENTS teraz')).toBe('Zrob $ARGUMENTS teraz');
  });
});

describe('cwm run: wynik routingu (ADR 0049)', () => {
  const routing = (
    keywords: string[],
    examples: string[] = [],
    priority = 0,
    mode = 'automatic',
  ): RoutingCandidate['routing'] => ({ mode, priority, keywords, examples });
  const candidates: RoutingCandidate[] = [
    {
      id: 'acme-a/schema',
      type: 'instructional',
      routing: routing(['migracja', 'schema change'], ['zmien schemat bazy danych']),
    },
    {
      id: 'acme-a/bugfix',
      type: 'instructional',
      routing: routing(['bug'], ['napraw blad w parserze plikow']),
    },
    { id: 'acme-a/manual', type: 'instructional', routing: routing(['bug'], [], 500, 'manual') },
    { id: 'acme-a/bare', type: 'instructional', routing: null },
  ];
  const pick = (task: string, def: string | null = null): ReturnType<typeof decideWorkflow> =>
    decideWorkflow(scoreWorkflows(task, candidates), def);

  it('slowo kluczowe wybiera po granicach slow i bez rozrozniania wielkosci liter i diakrytykow', () => {
    expect(pick('Potrzebna MIGRACJA tabeli uzytkownikow')).toMatchObject({
      state: 'selected',
      id: 'acme-a/schema',
    });
    expect(pick('debugger i bugi w kolejce')).toEqual({ state: 'none' });
    expect(pick('Zmiana SCHEMA change w tabeli')).toMatchObject({ id: 'acme-a/schema' });
  });

  it('przyklad liczy sie po wspolnych znaczacych slowach, jedno wspolne slowo nie wystarcza', () => {
    expect(pick('prosze napraw blad w parserze')).toMatchObject({ id: 'acme-a/bugfix' });
    expect(pick('parser')).toEqual({ state: 'none' });
  });

  it('routing manual i brak routingu wylaczaja workflow z automatu, mimo priorytetu', () => {
    const scores = scoreWorkflows('bug w module', candidates);
    expect(scores.find((s) => s.id === 'acme-a/manual')).toMatchObject({ auto: false, score: 0 });
    expect(scores.find((s) => s.id === 'acme-a/bare')).toMatchObject({ auto: false, score: 0 });
    expect(decideWorkflow(scores, null)).toMatchObject({ id: 'acme-a/bugfix' });
  });

  it('remis daje liste, a domyslny rozstrzyga tylko remis z jego udzialem', () => {
    expect(pick('migracja po bug')).toEqual({
      state: 'tie',
      ids: ['acme-a/bugfix', 'acme-a/schema'],
    });
    expect(pick('migracja po bug', 'acme-a/schema')).toEqual({
      state: 'selected',
      id: 'acme-a/schema',
      basis: 'default-tiebreak',
    });
    expect(pick('migracja po bug', 'acme-a/bare')).toMatchObject({ state: 'tie' });
  });

  it('domyslny wygrywa przy braku trafienia, ale nie przebija wyraznego lidera', () => {
    expect(pick('cos zupelnie innego', 'acme-a/bare')).toEqual({
      state: 'selected',
      id: 'acme-a/bare',
      basis: 'default',
    });
    expect(pick('migracja tabeli', 'acme-a/bare')).toMatchObject({
      id: 'acme-a/schema',
      basis: 'score',
    });
  });

  it('priorytet tylko rozstrzyga bliskie wyniki i nie daje punktow bez trafienia', () => {
    const near: RoutingCandidate[] = [
      { id: 'acme-a/a', type: 'instructional', routing: routing(['deploy'], [], 0) },
      { id: 'acme-a/b', type: 'instructional', routing: routing(['deploy'], [], 100) },
      { id: 'acme-a/c', type: 'instructional', routing: routing(['inne'], [], 1000) },
    ];
    const scores = scoreWorkflows('deploy na srodowisko', near);
    expect(decideWorkflow(scores, null)).toMatchObject({ id: 'acme-a/b', basis: 'score' });
    expect(scores.find((s) => s.id === 'acme-a/c')?.score).toBe(0);
  });

  it('wynik jest deterministyczny i zachowuje kolejnosc: wynik, priorytet, id', () => {
    const task = 'migracja schema change i bug';
    expect(scoreWorkflows(task, candidates)).toEqual(
      scoreWorkflows(task, [...candidates].reverse()),
    );
  });
});

describe('wstawki ! jak w silniku (SEC-02)', () => {
  it('wykrywa wstawke wielowierszowa, blok jednowierszowy i blok w srodku wiersza', () => {
    expect(extractInlineCommands('a !`echo\nhi` b')).toEqual(['echo\nhi']);
    expect(extractInlineCommands('a ```!echo hi``` b')).toEqual(['echo hi']);
    expect(extractInlineCommands('tekst ```!\nls\n``` koniec')).toEqual(['ls']);
    expect(extractInlineCommands('a!`nie`')).toEqual([]);
    expect(hasInlineCommands('x ```!ls```')).toBe(true);
    expect(hasInlineCommands('zwykly `kod`')).toBe(false);
  });
});

describe('workflow orchestrated: kolejnosc etapow i skladanie tresci (ADR 0050)', () => {
  const step = (id: string, dependsOn: string[] = [], task?: string): WorkflowStep => ({
    id,
    agent: `acme-a/${id}`,
    dependsOn,
    ...(task === undefined ? {} : { task }),
  });
  const stageIds = (steps: WorkflowStep[]): string[][] => {
    const ordered = orderSteps(steps);
    if (!ordered.ok) throw new Error(ordered.reason);
    return ordered.stages.map((stage) => stage.steps.map((s) => s.id));
  };

  it('kroki bez wzajemnej zaleznosci ida w jednym etapie, w kolejnosci deklaracji', () => {
    expect(stageIds([step('ship', ['lint', 'test']), step('test'), step('lint')])).toEqual([
      ['test', 'lint'],
      ['ship'],
    ]);
    expect(
      stageIds([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])]),
    ).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('cykl, samozaleznosc i nieznany krok to blad', () => {
    expect(orderSteps([step('a', ['b']), step('b', ['a'])]).ok).toBe(false);
    expect(orderSteps([step('a', ['a'])]).ok).toBe(false);
    expect(orderSteps([step('a', ['zz'])])).toMatchObject({ ok: false });
    expect(orderSteps([step('a'), step('a')]).ok).toBe(false);
  });

  const section = (steps: WorkflowStep[]): string => {
    const ordered = orderSteps(steps);
    if (!ordered.ok) throw new Error(ordered.reason);
    return renderOrchestration(
      ordered.stages,
      new Map(steps.map((s) => [s.id, `cwm-acme-a:${s.id}-agent`])),
    );
  };

  it('sekcja podaje etap, krok, agenta z przedrostkiem, zaleznosci i polecenie, bez ` ani $ ani !', () => {
    const text = section([step('lint', [], 'Check style.'), step('ship', ['lint'])]);
    expect(text).toContain('### Stage 1');
    expect(text).toContain('### Stage 2');
    expect(text).toContain('- Step lint\n  - Agent: cwm-acme-a:lint-agent\n  - Depends on: none');
    expect(text).toContain('  - Instruction: Check style.');
    expect(text).toContain('  - Depends on: lint\n  - Instruction: none, use the overall task');
    const constant = section([step('lint')]);
    expect(constant).not.toMatch(/[`$!]/);
  });

  it('wiersz zadania jest doklejany tylko gdy zrodlo nie ma placeholdera i zawsze na koncu', () => {
    const body = section([step('lint')]);
    const without = composeOrchestration('Intro.\n', body);
    expect(without.text.endsWith('\nTask: $ARGUMENTS\n')).toBe(true);
    expect(without.shellCheckText).not.toContain('Task: $ARGUMENTS');
    const withOwn = composeOrchestration('Intro $ARGUMENTS.\n', body);
    expect(withOwn.text).toBe(withOwn.shellCheckText);
    expect(withOwn.text).not.toContain('Task: $ARGUMENTS');
  });

  it('placeholder w task kroku nie zmienia doklejenia zadania (SEC-01)', () => {
    const body = section([step('lint', [], 'Look at $ARGUMENTS and $1')]);
    const composed = composeOrchestration('Intro bez placeholdera.\n', body);
    expect(composed.text.endsWith('\nTask: $ARGUMENTS\n')).toBe(true);
    expect(composed.text.match(/Task: \$ARGUMENTS/g)).toHaveLength(1);
  });

  it('wstawka w task trafia do wykrytych wstawek, a z placeholderem to przypadek powloki', () => {
    const hostile = section([step('lint', [], 'Run !`git status` now')]);
    const composed = composeOrchestration('Intro.\n', hostile);
    expect(extractInlineCommands(composed.text)).toEqual(['git status']);
    expect(taskReachesShell(composed.shellCheckText)).toBe(false);
    const both = composeOrchestration(
      'Intro.\n',
      section([step('lint', [], 'Run !`echo $ARGUMENTS`')]),
    );
    expect(taskReachesShell(both.shellCheckText)).toBe(true);
    // Wstawka zaczeta w zrodle i zamknieta w task nie obejmuje doklejonego wiersza zadania.
    const spanning = composeOrchestration('Intro !`echo\n', section([step('a', [], 'x`y')]));
    const snippets = extractInlineCommands(spanning.text);
    expect(snippets.join('\n')).not.toContain('$ARGUMENTS');
  });

  it('zrodlo z placeholderem i wstawka razem to przypadek powloki; sama wstawka nie', () => {
    const body = section([step('lint')]);
    expect(
      taskReachesShell(composeOrchestration('Run !`ls` $ARGUMENTS', body).shellCheckText),
    ).toBe(true);
    expect(taskReachesShell(composeOrchestration('Run !`ls`', body).shellCheckText)).toBe(false);
  });

  it('polecenie orchestrated idzie do silnika jako jeden argument jak instructional', () => {
    const prompt = workflowPrompt('cwm-acme-a:cwm-flow', '--model x; rm -rf');
    expect(prompt).toBe('/cwm-acme-a:cwm-flow --model x; rm -rf');
    const argv = argvOf({ userArgs: [prompt] });
    expect(argv.slice(-2)).toEqual(['--', prompt]);
  });

  it('cykl w komunikacie wymienia kroki', () => {
    const ordered = orderSteps([step('a', ['b']), step('b', ['c']), step('c', ['a']), step('d')]);
    expect(ordered).toEqual({
      ok: false,
      reason: 'Kroki tworza cykl zaleznosci: a -> b -> c -> a.',
    });
    expect(orderSteps([step('x', ['x'])])).toEqual({
      ok: false,
      reason: 'Kroki tworza cykl zaleznosci: x -> x.',
    });
  });

  it('nazwa agenta: dwukropek, wbudowane typy i niedozwolone znaki sa odrzucane (SEC-ORCH-01)', () => {
    expect(agentNameProblem('reviewer', 'reviewer')).toBeNull();
    expect(agentNameProblem('reviewer', 'cwm-acme:reviewer')).toBeNull();
    expect(agentNameProblem('cwm-acme:reviewer', 'cwm-acme:reviewer')).toMatch(/dwukropek/);
    for (const builtin of [
      'general-purpose',
      'Explore',
      'Plan',
      'statusline-setup',
      'claude-code-guide',
    ]) {
      expect(agentNameProblem(builtin, builtin)).toMatch(/wbudowany/);
    }
    expect(agentNameProblem('explore', 'explore')).toMatch(/wbudowany/);
    expect(agentNameProblem('bad name', 'bad name')).toMatch(/niedozwolone/);
  });

  it('niedomknieta wstawka przed wierszem zadania jest wykrywana (SEC-ORCH-03)', () => {
    expect(hasUnterminatedSnippet('a ```!\nls\n')).toBe(true);
    expect(hasUnterminatedSnippet('a ~~~!ls')).toBe(true);
    expect(hasUnterminatedSnippet('Run !`echo hi')).toBe(true);
    expect(hasUnterminatedSnippet('Run !`echo hi` and ```!\nls\n```')).toBe(false);
    expect(hasUnterminatedSnippet('zwykly `kod` i tekst')).toBe(false);
    const body = section([step('a', [], 'x !`open')]);
    expect(composeOrchestration('Intro.\n', body).unterminatedSnippet).toBe(true);
    expect(composeOrchestration('Intro !`echo\n', section([step('a')])).unterminatedSnippet).toBe(
      true,
    );
    expect(
      composeOrchestration('Intro.\n', section([step('a', [], 'Run !`ls`')])).unterminatedSnippet,
    ).toBe(false);
  });
});
