import { TOOL_IDS } from '../model/item';
import { Checker, childPath, field, isPlainObject, type PlainObject } from './check';
import { ENV_NAME_PATTERN, MCP_ENV_DENYLIST } from './env-policy';
import { fail, ok, type Result } from './errors';
import {
  ALL_SET_KEYS,
  API_VERSION,
  ID_NAME_PATTERN,
  ID_SPACE_PATTERN,
  RESOURCE_ID_PATTERN,
} from './kinds';
import { readFields, readIdList } from './read-set';
import { FORBIDDEN_KEYS } from './safe-keys';
import { readSettings, rejectSettingsKeys, SETTINGS_SPEC_FIELDS } from './settings-spec';
import {
  MANIFEST_KINDS,
  type Agent,
  type Command,
  type ContentFlags,
  type McpEnvRef,
  type McpServer,
  type Plugin,
  type PluginSource,
  type Resource,
  type Skill,
  type Workflow,
  type WorkflowRouting,
  type WorkflowStep,
} from './resource';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const WORD_PATTERN = /^[a-z][a-z-]{0,31}$/;
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMAND_FORBIDDEN = /[\s;|&$`<>()'"\\]/;
/** Waliduje manifest zasobu (sekcja 5 specyfikacji): Skill, Agent, Workflow, Plugin albo MCP. */
export function validateResource(input: unknown): Result<Resource> {
  const c = new Checker();
  const root = c.object(
    input,
    '$',
    ['apiVersion', 'kind', 'metadata', 'spec'],
    ['apiVersion', 'kind', 'metadata', 'spec'],
  );
  if (!root) return fail(c.errors);
  c.literal(field(root, 'apiVersion'), 'apiVersion', API_VERSION);

  const kindName = field(root, 'kind');
  const kind =
    typeof kindName === 'string' && Object.hasOwn(MANIFEST_KINDS, kindName)
      ? MANIFEST_KINDS[kindName as keyof typeof MANIFEST_KINDS]
      : null;
  if (kind === null) {
    c.add('kind', `Oczekiwano jednego z: ${Object.keys(MANIFEST_KINDS).join(', ')}.`);
    return fail(c.errors);
  }

  const metadata = c.object(
    field(root, 'metadata'),
    'metadata',
    ['id', 'version'],
    kind === 'mcp' ? ['id'] : ['id', 'version'],
  );
  const id = metadata
    ? c.string(field(metadata, 'id'), 'metadata.id', RESOURCE_ID_PATTERN, '<przestrzen>/<nazwa>')
    : null;
  // Wersja obecna, ale pusta lub null, jest bledem takze tam, gdzie jest opcjonalna (MCP).
  const versionValue = metadata ? field(metadata, 'version') : undefined;
  const version =
    versionValue === undefined
      ? null
      : c.string(versionValue, 'metadata.version', VERSION_PATTERN, 'MAJOR.MINOR.PATCH');

  const specValue = field(root, 'spec');
  if (kind === 'settings' && isPlainObject(specValue)) rejectSettingsKeys(c, specValue, 'spec');
  const spec = c.object(specValue, 'spec', SPEC_FIELDS[kind]);
  if (!spec) return fail(c.errors);

  const resource = readSpec(c, kind, spec, id ?? '', version ?? '');
  return c.errors.length > 0 ? fail(c.errors) : ok(resource);
}

const SPEC_FIELDS = {
  skill: ['source', 'visibility', 'compatibility', 'dependencies', 'contentFlags'],
  agent: ['source', 'skills', 'tools', 'model', 'contentFlags'],
  workflow: ['type', 'source', 'routing', 'agents', 'steps'],
  plugin: ['source', 'activation'],
  mcp: ['transport', 'command', 'args', 'url', 'env'],
  settings: SETTINGS_SPEC_FIELDS,
  command: ['source', 'contentFlags'],
} as const;

function readSpec(
  c: Checker,
  kind: keyof typeof SPEC_FIELDS,
  spec: PlainObject,
  id: string,
  version: string,
): Resource {
  switch (kind) {
    case 'skill':
      return readSkill(c, spec, id, version);
    case 'agent':
      return readAgent(c, spec, id, version);
    case 'workflow':
      return readWorkflow(c, spec, id, version);
    case 'plugin':
      return readPlugin(c, spec, id, version);
    case 'mcp':
      return readMcp(c, spec, id, version);
    case 'settings':
      return readSettings(c, spec, id, version);
    case 'command':
      return readCommandResource(c, spec, id, version);
  }
}

function readContentFlags(c: Checker, value: unknown): ContentFlags | null {
  if (value === undefined) return null;
  const obj = c.object(value, 'spec.contentFlags', ['allowedTools', 'inlineCommands']);
  if (!obj) return null;
  const flag = (key: string): boolean => {
    const raw = field(obj, key);
    return raw === undefined
      ? false
      : (c.boolean(raw, childPath('spec.contentFlags', key)) ?? false);
  };
  return { allowedTools: flag('allowedTools'), inlineCommands: flag('inlineCommands') };
}

function readCommandResource(c: Checker, spec: PlainObject, id: string, version: string): Command {
  const flags = readContentFlags(c, field(spec, 'contentFlags'));
  return {
    kind: 'command',
    id,
    version,
    source: requiredPath(c, spec),
    ...(flags ? { contentFlags: flags } : {}),
  };
}

function requiredPath(c: Checker, spec: PlainObject): string {
  if (!Object.hasOwn(spec, 'source')) c.add('spec.source', 'Pole jest wymagane.');
  return c.relativePath(field(spec, 'source'), 'spec.source') ?? '';
}

function readSkill(c: Checker, spec: PlainObject, id: string, version: string): Skill {
  const compat = optionalObject(c, field(spec, 'compatibility'), 'spec.compatibility', ['engines']);
  const deps = optionalObject(c, field(spec, 'dependencies'), 'spec.dependencies', ALL_SET_KEYS);
  const visibility = field(spec, 'visibility');
  const flags = readContentFlags(c, field(spec, 'contentFlags'));
  return {
    kind: 'skill',
    id,
    version,
    source: requiredPath(c, spec),
    visibility:
      visibility === undefined
        ? 'shared'
        : (c.oneOf(visibility, 'spec.visibility', ['shared', 'private']) ?? 'shared'),
    engines: c.list(field(compat, 'engines'), 'spec.compatibility.engines', (el, p) =>
      c.oneOf(el, p, TOOL_IDS),
    ),
    dependencies: readFields(c, deps, 'spec.dependencies', ALL_SET_KEYS),
    ...(flags ? { contentFlags: flags } : {}),
  };
}

function readAgent(c: Checker, spec: PlainObject, id: string, version: string): Agent {
  const skills = optionalObject(c, field(spec, 'skills'), 'spec.skills', ['shared', 'private']);
  const model = field(spec, 'model');
  const flags = readContentFlags(c, field(spec, 'contentFlags'));
  return {
    kind: 'agent',
    id,
    version,
    source: requiredPath(c, spec),
    skills: {
      shared: readIdList(c, field(skills, 'shared'), 'spec.skills.shared'),
      private: c.list(field(skills, 'private'), 'spec.skills.private', (el, p) =>
        c.relativePath(el, p),
      ),
    },
    tools: c.list(field(spec, 'tools'), 'spec.tools', (el, p) => c.string(el, p)),
    model: model === undefined ? 'inherit' : (c.string(model, 'spec.model') ?? 'inherit'),
    ...(flags ? { contentFlags: flags } : {}),
  };
}

function readWorkflow(c: Checker, spec: PlainObject, id: string, version: string): Workflow {
  if (!Object.hasOwn(spec, 'type')) c.add('spec.type', 'Pole jest wymagane.');
  const type = c.oneOf(field(spec, 'type'), 'spec.type', ['instructional', 'orchestrated']);
  const routing = readRouting(c, field(spec, 'routing'));
  const agents = readIdList(c, field(spec, 'agents'), 'spec.agents');
  const steps = readSteps(c, field(spec, 'steps'));
  if (type === 'instructional' && steps.length > 0) {
    c.add('spec.steps', 'Kroki sa dozwolone tylko w workflow typu orchestrated.');
  }
  if (type === 'orchestrated' && steps.length === 0) {
    c.add('spec.steps', 'Workflow typu orchestrated wymaga krokow.');
  }
  return {
    kind: 'workflow',
    id,
    version,
    type: type ?? 'instructional',
    source: requiredPath(c, spec),
    ...(routing ? { routing } : {}),
    agents,
    steps,
  };
}

function readRouting(c: Checker, value: unknown): WorkflowRouting | null {
  if (value === undefined) return null;
  const obj = c.object(
    value,
    'spec.routing',
    ['mode', 'priority', 'examples', 'keywords'],
    ['mode'],
  );
  if (!obj) return null;
  const priority = field(obj, 'priority');
  return {
    mode: c.string(field(obj, 'mode'), 'spec.routing.mode', WORD_PATTERN) ?? '',
    priority:
      priority === undefined ? 0 : (c.integer(priority, 'spec.routing.priority', 0, 1000) ?? 0),
    examples: c.list(field(obj, 'examples'), 'spec.routing.examples', (el, p) => c.string(el, p)),
    keywords: c.list(field(obj, 'keywords'), 'spec.routing.keywords', (el, p) => c.string(el, p)),
  };
}

/**
 * Kroki: `{ id, agent, dependsOn }`. Zaleznosci musza wskazywac istniejace kroki i nie tworzyc
 * cyklu. Sciezki bledow wskazuja indeks z oryginalnego dokumentu, nie z przefiltrowanej listy.
 */
function readSteps(c: Checker, value: unknown): WorkflowStep[] {
  const stepPath = new Map<string, string>();
  const rawDependsOn = new Map<string, unknown>();
  const steps = c.list(
    value,
    'spec.steps',
    (element, path): WorkflowStep | null => {
      const obj = c.object(element, path, ['id', 'agent', 'dependsOn'], ['id', 'agent']);
      if (!obj) return null;
      const stepId = c.string(field(obj, 'id'), childPath(path, 'id'), STEP_ID_PATTERN);
      const agent = c.string(field(obj, 'agent'), childPath(path, 'agent'), RESOURCE_ID_PATTERN);
      const dependsOn = c.list(field(obj, 'dependsOn'), childPath(path, 'dependsOn'), (el, p) =>
        c.string(el, p, STEP_ID_PATTERN),
      );
      if (!stepId || !agent) return null;
      if (!stepPath.has(stepId)) {
        stepPath.set(stepId, path);
        rawDependsOn.set(stepId, field(obj, 'dependsOn'));
      }
      return { id: stepId, agent, dependsOn };
    },
    (step) => step.id,
  );
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    const base = `${stepPath.get(step.id) ?? 'spec.steps'}.dependsOn`;
    const raw = rawDependsOn.get(step.id);
    for (const dep of step.dependsOn) {
      if (byId.has(dep)) continue;
      const index = Array.isArray(raw) ? raw.indexOf(dep) : -1;
      c.add(index >= 0 ? `${base}[${index}]` : base, `Nieznany krok "${dep}".`);
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const hasCycle = (step: WorkflowStep): boolean => {
    if (done.has(step.id)) return false;
    if (visiting.has(step.id)) return true;
    visiting.add(step.id);
    const cyclic = step.dependsOn.some((dep) => {
      const next = byId.get(dep);
      return next !== undefined && hasCycle(next);
    });
    visiting.delete(step.id);
    done.add(step.id);
    return cyclic;
  };
  if (steps.some(hasCycle)) c.add('spec.steps', 'Kroki tworza cykl zaleznosci.');
  return steps;
}

function readPlugin(c: Checker, spec: PlainObject, id: string, version: string): Plugin {
  const activation = optionalObject(c, field(spec, 'activation'), 'spec.activation', ['default']);
  const mode = field(activation, 'default');
  return {
    kind: 'plugin',
    id,
    version,
    source: readPluginSource(c, field(spec, 'source')) ?? { type: 'local', path: '' },
    activationDefault:
      mode === undefined
        ? 'disabled'
        : (c.oneOf(mode, 'spec.activation.default', ['enabled', 'disabled']) ?? 'disabled'),
  };
}

function readPluginSource(c: Checker, value: unknown): PluginSource | null {
  const path = 'spec.source';
  if (!isPlainObject(value)) {
    c.add(path, 'Oczekiwano obiektu.');
    return null;
  }
  const type = c.oneOf(field(value, 'type'), childPath(path, 'type'), [
    'local',
    'marketplace',
    'git',
  ]);
  const at = (key: string): string => childPath(path, key);
  switch (type) {
    case 'local': {
      c.object(value, path, ['type', 'path'], ['type', 'path']);
      const p = c.relativePath(field(value, 'path'), at('path'));
      return p === null ? null : { type, path: p };
    }
    case 'marketplace': {
      c.object(value, path, ['type', 'marketplace', 'plugin'], ['type', 'marketplace', 'plugin']);
      const marketplace = c.string(
        field(value, 'marketplace'),
        at('marketplace'),
        ID_SPACE_PATTERN,
      );
      const plugin = c.string(field(value, 'plugin'), at('plugin'), ID_NAME_PATTERN);
      return marketplace && plugin ? { type, marketplace, plugin } : null;
    }
    case 'git': {
      c.object(value, path, ['type', 'url', 'ref'], ['type', 'url']);
      const url = c.url(field(value, 'url'), at('url'));
      const refValue = field(value, 'ref');
      const ref = refValue === undefined ? null : readGitRef(c, refValue, at('ref'));
      return url ? { type, url, ...(ref ? { ref } : {}) } : null;
    }
    default:
      return null;
  }
}

/** Ref trafia do polecenia `git`, wiec nie moze zaczynac sie od `-` ani zawierac `..`. */
function readGitRef(c: Checker, value: unknown, path: string): string | null {
  const ref = c.string(value, path, GIT_REF_PATTERN, 'nazwa galezi, taga lub commita');
  if (ref !== null && ref.includes('..')) {
    c.add(path, 'Ref nie moze zawierac "..".');
    return null;
  }
  return ref;
}

function readMcp(c: Checker, spec: PlainObject, id: string, version: string): McpServer {
  if (!Object.hasOwn(spec, 'transport')) c.add('spec.transport', 'Pole jest wymagane.');
  const transport = c.oneOf(field(spec, 'transport'), 'spec.transport', ['stdio', 'http', 'sse']);
  const commandValue = field(spec, 'command');
  const urlValue = field(spec, 'url');
  if (transport === 'stdio') {
    if (commandValue === undefined) c.add('spec.command', 'Transport stdio wymaga pola command.');
    if (urlValue !== undefined) c.add('spec.url', 'Transport stdio nie uzywa pola url.');
  } else if (transport !== null) {
    if (urlValue === undefined) c.add('spec.url', `Transport ${transport} wymaga pola url.`);
    if (commandValue !== undefined) {
      c.add('spec.command', `Transport ${transport} nie uzywa pola command.`);
    }
  }
  const command = commandValue === undefined ? null : readCommand(c, commandValue);
  const url = urlValue === undefined ? null : noDollar(c, c.url(urlValue, 'spec.url'), 'spec.url');
  return {
    kind: 'mcp',
    id,
    ...(version ? { version } : {}),
    transport: transport ?? 'stdio',
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    args: c.list(field(spec, 'args'), 'spec.args', (el, p) => noDollar(c, c.string(el, p), p)),
    env: readMcpEnv(c, field(spec, 'env')),
  };
}

/**
 * MCP-01: silnik rozwija `${...}` w `command`, `args` i `url`, wiec `$` pozwolilby wyniesc sekret,
 * ktorego nie zadeklarowano jako `envRef`. Jedyne `${...}` w `mcp.json` wpisuje generator.
 */
function noDollar(c: Checker, value: string | null, path: string): string | null {
  if (value !== null && value.includes('$')) {
    c.add(path, 'Znak $ jest zabroniony (silnik rozwija ${...}). Sekrety przekazuj przez envRef.');
    return null;
  }
  return value;
}

/** Jeden token wykonywalny: nazwa z PATH albo sciezka wzgledna. Zadnej powloki, zadnych argumentow. */
function readCommand(c: Checker, value: unknown): string | null {
  const command = c.string(value, 'spec.command');
  if (command === null) return null;
  if (COMMAND_FORBIDDEN.test(command) || command.startsWith('-')) {
    c.add(
      'spec.command',
      'Polecenie ma byc jednym plikiem wykonywalnym, bez spacji i znakow powloki.',
    );
    return null;
  }
  return command.includes('/') ? c.relativePath(command, 'spec.command') : command;
}

function readMcpEnv(c: Checker, value: unknown): Record<string, McpEnvRef> {
  const env: Record<string, McpEnvRef> = {};
  if (value === undefined) return env;
  if (!isPlainObject(value)) {
    c.add('spec.env', 'Oczekiwano obiektu.');
    return env;
  }
  for (const name of Object.keys(value)) {
    const path = childPath('spec.env', name);
    if (FORBIDDEN_KEYS.has(name)) {
      c.add(path, 'Zabroniony klucz.');
      continue;
    }
    if (MCP_ENV_DENYLIST.test(name)) {
      c.add(
        path,
        'Ta zmienna zmienia sposob uruchamiania procesu lub ruch sieciowy i jest zabroniona.',
      );
      continue;
    }
    if (!ENV_NAME_PATTERN.test(name)) {
      c.add(path, 'Nazwa zmiennej ma miec zapis WIELKIMI_LITERAMI.');
      continue;
    }
    const entry = field(value, name);
    // Wartosc wpisana wprost jest odrzucana i nigdzie nie zapisywana ani nie cytowana.
    if (typeof entry === 'string') {
      c.add(
        path,
        'Wartosc wpisana wprost jest zabroniona. Uzyj envRef z nazwa zmiennej srodowiskowej.',
      );
      continue;
    }
    const obj = c.object(entry, path, ['envRef']);
    if (!obj) continue;
    const envRef = c.string(field(obj, 'envRef'), childPath(path, 'envRef'), ENV_NAME_PATTERN);
    if (envRef !== null) env[name] = { envRef };
  }
  return env;
}

/** Blok opcjonalny: brak bloku daje pusty obiekt, zeby wywolujacy mogl czytac pola bez warunkow. */
function optionalObject(
  c: Checker,
  value: unknown,
  path: string,
  allowed: readonly string[],
): PlainObject {
  return value === undefined ? {} : (c.object(value, path, allowed) ?? {});
}
