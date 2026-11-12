import { TOOL_IDS } from '../model/item';
import { Checker, childPath, field } from './check';
import { fail, ok, type Result } from './errors';
import { ALL_SET_KEYS, API_VERSION, ID_SPACE_PATTERN, isSharedNamespace } from './kinds';
import { CWM_OWNED_ENV } from './patterns';
import { ENV_NAME_PATTERN } from './env-policy';
import type {
  CompanyManifest,
  CompanyRuntime,
  GlobalConfig,
  ProjectImport,
  ProjectManifest,
} from './manifest';
import { readBlock, readFields } from './read-set';

const WORD_PATTERN = /^[a-z][a-z-]{0,31}$/;
const ASSET_KEYS = ['skills', 'agents', 'workflows', 'commands', 'settings'] as const;
const OPTIONAL_KEYS = ['skills', 'agents', 'commands', 'settings'] as const;

/** Wspolna otoczka: apiVersion i kind. Reszte pol sprawdza wywolujacy. */
function readRoot(
  c: Checker,
  input: unknown,
  kind: string,
  fields: readonly string[],
  required: readonly string[] = [],
) {
  const root = c.object(
    input,
    '$',
    ['apiVersion', 'kind', ...fields],
    ['apiVersion', 'kind', ...required],
  );
  if (root) {
    c.literal(field(root, 'apiVersion'), 'apiVersion', API_VERSION);
    c.literal(field(root, 'kind'), 'kind', kind);
  }
  return root;
}

/** Id firmy: jak kazde id, ale nie moze zajmowac przestrzeni zarezerwowanej dla zrodel. */
function companyId(c: Checker, value: unknown, path: string): string | null {
  const id = c.string(value, path, ID_SPACE_PATTERN, 'male litery, cyfry, -');
  if (id !== null && isSharedNamespace(id)) {
    c.add(path, `Id "${id}" jest zarezerwowane i nie moze byc nazwa firmy.`);
    return null;
  }
  return id;
}

/** Podblok z dwiema listami `mandatory`/`optional` lub `enable`/`disableOptional`. */
function subObject(c: Checker, value: unknown, path: string, keys: readonly string[]) {
  return value === undefined ? {} : (c.object(value, path, keys) ?? {});
}

export function validateGlobalConfig(input: unknown): Result<GlobalConfig> {
  const c = new Checker();
  const root = readRoot(
    c,
    input,
    'GlobalConfig',
    ['defaults', 'resources', 'runtime'],
    ['defaults', 'runtime'],
  );
  if (!root) return fail(c.errors);

  const defaults = c.object(
    field(root, 'defaults'),
    'defaults',
    ['engine', 'projectMode', 'workflowSelection'],
    ['engine', 'projectMode', 'workflowSelection'],
  );
  const resources = subObject(c, field(root, 'resources'), 'resources', ['mandatory', 'optional']);
  const runtimeKeys = [
    'separateCompanyConfigs',
    'preserveNativeConfiguration',
    'overwriteNativeFiles',
  ];
  const runtime = c.object(field(root, 'runtime'), 'runtime', runtimeKeys, runtimeKeys);
  const flag = (key: string): boolean =>
    (runtime && c.boolean(field(runtime, key), childPath('runtime', key))) ?? false;
  const word = (key: string): string =>
    (defaults && c.string(field(defaults, key), childPath('defaults', key), WORD_PATTERN)) ?? '';

  const value: GlobalConfig = {
    apiVersion: API_VERSION,
    kind: 'GlobalConfig',
    defaults: {
      engine:
        (defaults && c.oneOf(field(defaults, 'engine'), 'defaults.engine', TOOL_IDS)) ||
        TOOL_IDS[0],
      projectMode: word('projectMode'),
      workflowSelection: word('workflowSelection'),
    },
    resources: {
      mandatory: readBlock(c, field(resources, 'mandatory'), 'resources.mandatory', OPTIONAL_KEYS),
      optional: readBlock(c, field(resources, 'optional'), 'resources.optional', OPTIONAL_KEYS),
    },
    runtime: {
      separateCompanyConfigs: flag('separateCompanyConfigs'),
      preserveNativeConfiguration: flag('preserveNativeConfiguration'),
      overwriteNativeFiles: flag('overwriteNativeFiles'),
    },
  };
  return c.errors.length > 0 ? fail(c.errors) : ok(value);
}

function readCompanyRuntime(c: Checker, value: unknown): CompanyRuntime {
  const runtime =
    value === undefined ? {} : (c.object(value, 'runtime', ['isolation', 'claude', 'env']) ?? {});
  const isolation = field(runtime, 'isolation');
  const claudeValue = field(runtime, 'claude');
  const claude =
    claudeValue === undefined ? {} : (c.object(claudeValue, 'runtime.claude', ['path']) ?? {});
  const pathValue = field(claude, 'path');
  let claudePath: string | null = null;
  if (pathValue !== undefined) {
    claudePath = c.string(pathValue, 'runtime.claude.path');
    if (claudePath !== null && (!claudePath.startsWith('/') || claudePath.includes('..'))) {
      c.add('runtime.claude.path', 'Sciezka ma byc bezwzgledna i bez "..".');
      claudePath = null;
    }
  }
  const envValue = field(runtime, 'env');
  const env =
    envValue === undefined ? {} : (c.object(envValue, 'runtime.env', ['passthrough']) ?? {});
  const passthrough = c.list(field(env, 'passthrough'), 'runtime.env.passthrough', (el, p) => {
    const name = c.string(el, p, ENV_NAME_PATTERN, 'NAZWA_ZMIENNEJ');
    if (name !== null && CWM_OWNED_ENV.has(name)) {
      c.add(p, 'Ta zmienna jest ustawiana przez CWM.');
      return null;
    }
    return name;
  });
  return {
    isolation: isolation === undefined ? true : (c.boolean(isolation, 'runtime.isolation') ?? true),
    claudePath,
    envPassthrough: passthrough,
  };
}

export function validateCompanyManifest(input: unknown): Result<CompanyManifest> {
  const c = new Checker();
  const root = readRoot(
    c,
    input,
    'Company',
    ['metadata', 'resources', 'plugins', 'mcp', 'instructions', 'exports', 'runtime'],
    ['metadata'],
  );
  if (!root) return fail(c.errors);

  const metadata = c.object(field(root, 'metadata'), 'metadata', ['id', 'name'], ['id', 'name']);
  const resources = subObject(c, field(root, 'resources'), 'resources', [
    'enable',
    'disableOptional',
  ]);
  const instructionsValue = field(root, 'instructions');
  const instructions =
    instructionsValue === undefined
      ? null
      : c.object(instructionsValue, 'instructions', ['file'], ['file']);
  const file = instructions && c.relativePath(field(instructions, 'file'), 'instructions.file');
  const exportsObj = subObject(c, field(root, 'exports'), 'exports', ALL_SET_KEYS);
  const runtime = readCompanyRuntime(c, field(root, 'runtime'));

  const value: CompanyManifest = {
    apiVersion: API_VERSION,
    kind: 'Company',
    metadata: {
      id: (metadata && companyId(c, field(metadata, 'id'), 'metadata.id')) || '',
      name: (metadata && c.string(field(metadata, 'name'), 'metadata.name')) || '',
    },
    resources: {
      enable: readBlock(c, field(resources, 'enable'), 'resources.enable', ASSET_KEYS),
      disableOptional: readBlock(
        c,
        field(resources, 'disableOptional'),
        'resources.disableOptional',
        ASSET_KEYS,
      ),
    },
    plugins: readBlock(c, field(root, 'plugins'), 'plugins', ['enable', 'forbid']),
    mcp: readBlock(c, field(root, 'mcp'), 'mcp', ['enable']),
    instructions: file ? { file } : null,
    exports: readFields(c, exportsObj, 'exports', ALL_SET_KEYS),
    runtime,
  };
  return c.errors.length > 0 ? fail(c.errors) : ok(value);
}

export function validateProjectManifest(input: unknown): Result<ProjectManifest> {
  const c = new Checker();
  const root = readRoot(c, input, 'Project', ['metadata', 'spec'], ['metadata', 'spec']);
  if (!root) return fail(c.errors);

  // Metadata i spec sa sprawdzane niezaleznie, zeby jeden blad nie ukrywal drugiego.
  const metadata = c.object(
    field(root, 'metadata'),
    'metadata',
    ['id', 'company', 'path'],
    ['id', 'company'],
  );
  const projectPath =
    metadata && Object.hasOwn(metadata, 'path')
      ? c.string(field(metadata, 'path'), 'metadata.path')
      : null;
  const spec = c.object(
    field(root, 'spec'),
    'spec',
    ['engine', 'resources', 'plugins', 'mcp', 'workflows', 'native', 'imports'],
    ['engine'],
  );
  const s = spec ?? {};
  const resources = subObject(c, field(s, 'resources'), 'spec.resources', [
    'enable',
    'disableOptional',
  ]);
  const workflows = subObject(c, field(s, 'workflows'), 'spec.workflows', ['selection']);
  const native = subObject(c, field(s, 'native'), 'spec.native', ['preserve']);
  const selection = field(workflows, 'selection');
  const preserve = field(native, 'preserve');

  const imports = c.list(
    field(s, 'imports'),
    'spec.imports',
    (element, path): ProjectImport | null => {
      const obj = c.object(element, path, ['from', ...ALL_SET_KEYS], ['from']);
      if (!obj) return null;
      const from = companyId(c, field(obj, 'from'), childPath(path, 'from'));
      return from === null ? null : { from, ...readFields(c, obj, path, ALL_SET_KEYS) };
    },
    (entry) => entry.from,
  );

  const value: ProjectManifest = {
    apiVersion: API_VERSION,
    kind: 'Project',
    metadata: {
      id:
        (metadata &&
          c.string(
            field(metadata, 'id'),
            'metadata.id',
            ID_SPACE_PATTERN,
            'male litery, cyfry, -',
          )) ||
        '',
      company: (metadata && companyId(c, field(metadata, 'company'), 'metadata.company')) || '',
      ...(projectPath === null ? {} : { path: projectPath }),
    },
    spec: {
      engine: (spec && c.oneOf(field(spec, 'engine'), 'spec.engine', TOOL_IDS)) || TOOL_IDS[0],
      resources: {
        enable: readBlock(c, field(resources, 'enable'), 'spec.resources.enable', ASSET_KEYS),
        disableOptional: readBlock(
          c,
          field(resources, 'disableOptional'),
          'spec.resources.disableOptional',
          ASSET_KEYS,
        ),
      },
      plugins: readBlock(c, field(s, 'plugins'), 'spec.plugins', ['enable', 'disable']),
      mcp: readBlock(c, field(s, 'mcp'), 'spec.mcp', ['enable', 'disable']),
      workflows: {
        selection:
          selection === undefined || selection === null
            ? null
            : c.string(selection, 'spec.workflows.selection', WORD_PATTERN),
      },
      native: {
        preserve:
          preserve === undefined || preserve === null
            ? null
            : c.boolean(preserve, 'spec.native.preserve'),
      },
      imports,
    },
  };
  return c.errors.length > 0 ? fail(c.errors) : ok(value);
}
