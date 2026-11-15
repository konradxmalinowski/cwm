import { join } from 'node:path';

import { isScalar, isSeq, parseDocument, type Document } from 'yaml';

import {
  API_VERSION,
  ID_NAME_PATTERN,
  RESOURCE_ID_PATTERN,
  namespaceOf,
  routingTokens,
  taskReachesShell,
  validateCompanyManifest,
  validateGlobalConfig,
  validateResource,
  withTaskPlaceholder,
  type Resource,
  type Workflow,
} from '../../core/cwm';
import { readChecked } from '../fs/bounded-read';
import {
  companyDir,
  companyManifestFile,
  isSafeSegment,
  registryKindDir,
  type CwmLayout,
} from './layout';
import { parseContent } from './import-source';
import { withGlobalLock } from './packs';
import { readTextWithin } from './read';
import { FileResourceRegistry, type RegistryEntry } from './registry';
import { readSourceFile, TREE_LIMITS } from './runtime-sources';
import { toYaml } from './serialize';
import { homeScope, replaceScopedTree, writeScopedFile } from './writer';
import { listCompanyIds } from './workspace';
import { parseManifestYaml } from './yaml-manifest';

/**
 * Zarzadzanie zasobami `Workflow` (ADR 0049): zapis do rejestru globalnego (`global/<nazwa>`) albo do
 * katalogu firmy (`<firma>/<nazwa>`) i dopisanie id do list wlaczajacych. Zapisy ida przez writer
 * `~/.cwm` pod mutexem `runtime/global`. Niczego tu nie zatwierdza: zatwierdzenie jest przy `cwm start`.
 */

export const WORKFLOW_VERSION = '1.0.0';
export const WORKFLOW_SOURCE_FILE = 'workflow.md';
export const MAX_ROUTING_KEYWORDS = 50;
export const MAX_ROUTING_EXAMPLES = 20;
export const MAX_ROUTING_TEXT = 300;

/** Blad do pokazania uzytkownikowi (kod 1), bez szczegolow wewnetrznych. */
export class WorkflowCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCommandError';
  }
}

export type GlobalList = 'optional' | 'mandatory';

export interface AddWorkflowInput {
  readonly id: string;
  readonly source: Uint8Array;
  readonly keywords: readonly string[];
  readonly examples: readonly string[];
  readonly priority: number;
  readonly manual: boolean;
  /** Firmy, w ktorych id trafia do `resources.enable.workflows`. */
  readonly companies: readonly string[];
  /** Lista w `config.yaml` (`resources.<lista>.workflows`) albo null. */
  readonly global: GlobalList | null;
}

export interface AddWorkflowResult {
  readonly status: 'created' | 'unchanged';
  readonly id: string;
  readonly dir: string;
  readonly enabled: readonly string[];
  readonly alreadyEnabled: readonly string[];
  readonly globalChanged: boolean;
  /** Cechy tresci, ktore wymusza zatwierdzenie przy `cwm start`. */
  readonly needsApproval: readonly string[];
}

export function workflowManifestDocument(
  id: string,
  routing: Pick<AddWorkflowInput, 'keywords' | 'examples' | 'priority' | 'manual'>,
): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'Workflow',
    metadata: { id, version: WORKFLOW_VERSION },
    spec: {
      type: 'instructional',
      source: WORKFLOW_SOURCE_FILE,
      routing: {
        mode: routing.manual ? 'manual' : 'automatic',
        priority: routing.priority,
        examples: [...routing.examples],
        keywords: [...routing.keywords],
      },
    },
  };
}

/** Odczyt pliku `.md` z dysku do `workflow add --from`: zwykly plik, bez dowiazania, z limitem. */
export async function readWorkflowSourceFile(path: string): Promise<Uint8Array> {
  const read = await readChecked(path, TREE_LIMITS.fileBytes, { strict: true });
  switch (read.kind) {
    case 'ok':
      return read.bytes;
    case 'missing':
      throw new WorkflowCommandError(`Brak pliku ${path}.`);
    case 'symlink':
      throw new WorkflowCommandError(`${path} jest dowiazaniem symbolicznym.`);
    case 'too-large':
      throw new WorkflowCommandError(`${path} jest wiekszy niz ${TREE_LIMITS.fileBytes} bajtow.`);
    default:
      throw new WorkflowCommandError(`${path} nie jest zwyklym plikiem.`);
  }
}

/** Tresc komendy z rejestru (`--from-command`): id musi wskazywac dokladnie jedna definicje. */
export async function readCommandSource(layout: CwmLayout, id: string): Promise<Uint8Array> {
  const { ids } = await listCompanyIds(layout);
  const registry = await FileResourceRegistry.load(layout, ids);
  const found = registry.entries.filter(
    (e) => e.resource.kind === 'command' && e.resource.id === id,
  );
  if (found.length === 0) throw new WorkflowCommandError(`Komenda ${id} nie istnieje w rejestrze.`);
  if (found.length > 1) {
    throw new WorkflowCommandError(`Id ${id} ma w rejestrze kilka definicji (cwm doctor).`);
  }
  const [entry] = found;
  const resource = entry?.resource;
  if (entry === undefined || resource?.kind !== 'command') {
    throw new WorkflowCommandError(`Komenda ${id} nie istnieje w rejestrze.`);
  }
  const source = resource.source.startsWith('./') ? resource.source.slice(2) : resource.source;
  const bytes = await readSourceFile(entry.dir, source);
  if (bytes === null) {
    throw new WorkflowCommandError(
      `Plik zrodlowy komendy ${id} jest niedostepny albo niebezpieczny.`,
    );
  }
  return bytes;
}

export interface SourceCheck {
  readonly needsApproval: readonly string[];
}

/** Ta sama analiza tresci co przy `cwm start`: zle zrodlo to blad juz przy dodawaniu. */
export function checkWorkflowSource(bytes: Uint8Array, id: string): SourceCheck {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkflowCommandError('Plik zrodlowy nie jest poprawnym UTF-8.');
  }
  const parsed = parseContent(
    'command',
    new TextEncoder().encode(withTaskPlaceholder(text)),
    `cwm-${id.slice(id.indexOf('/') + 1)}`,
  );
  if (!parsed.ok) throw new WorkflowCommandError(`Zrodlo workflow: ${parsed.reason}.`);
  if (taskReachesShell(text)) {
    throw new WorkflowCommandError(
      'Wstawka ! uzywa $ARGUMENTS albo $1: opis zadania trafilby do powloki.',
    );
  }
  const features: string[] = [];
  if (parsed.flags.allowedTools) features.push('allowed-tools');
  if (parsed.flags.inlineCommands) features.push('wstawki ! (polecenia wykonywane przy wczytaniu)');
  return { needsApproval: features };
}

function checkRouting(input: AddWorkflowInput): void {
  const listCheck = (what: string, values: readonly string[], max: number): void => {
    if (values.length > max) throw new WorkflowCommandError(`Najwyzej ${max} pozycji: ${what}.`);
    for (const value of values) {
      if (value.length > MAX_ROUTING_TEXT) {
        throw new WorkflowCommandError(`${what}: pozycja ma ponad ${MAX_ROUTING_TEXT} znakow.`);
      }
      if (routingTokens(value).length === 0) {
        throw new WorkflowCommandError(`${what}: pozycja nie zawiera zadnego slowa.`);
      }
      if (/[\p{Cc}\p{Cf}]/u.test(value)) {
        throw new WorkflowCommandError(`${what}: pozycja zawiera znak sterujacy.`);
      }
    }
  };
  listCheck('keywords', input.keywords, MAX_ROUTING_KEYWORDS);
  listCheck('examples', input.examples, MAX_ROUTING_EXAMPLES);
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) {
    throw new WorkflowCommandError('Priorytet to liczba calkowita od 0 do 1000.');
  }
}

type Target = {
  readonly dir: string;
  readonly scope: 'global' | 'company';
  readonly space: string;
};

/** `global/<nazwa>` trafia do rejestru globalnego, `<firma>/<nazwa>` do katalogu istniejacej firmy. */
async function targetOf(layout: CwmLayout, id: string): Promise<Target> {
  if (!RESOURCE_ID_PATTERN.test(id)) {
    throw new WorkflowCommandError(`Niepoprawne id "${id}": oczekiwano <przestrzen>/<nazwa>.`);
  }
  const space = namespaceOf(id);
  const name = id.slice(id.indexOf('/') + 1);
  if (!ID_NAME_PATTERN.test(name)) {
    throw new WorkflowCommandError(`Niepoprawna nazwa workflow "${name}".`);
  }
  if (space === 'global') {
    return { dir: join(registryKindDir(layout, 'workflow'), space, name), scope: 'global', space };
  }
  const { ids } = await listCompanyIds(layout);
  if (!ids.includes(space)) {
    throw new WorkflowCommandError(
      `Przestrzen "${space}" to nie firma ani "global": uzyj global/<nazwa> albo <firma>/<nazwa>.`,
    );
  }
  return {
    dir: join(companyDir(layout, space), 'workflows', name),
    scope: 'company',
    space,
  };
}

interface ListEdit {
  readonly file: string;
  readonly text: string;
  readonly changed: boolean;
  readonly label: string;
}

/**
 * Nowy tekst manifestu z dopisanym `id` na liscie `<sciezka>.workflows`. Reszta dokumentu i komentarze
 * zostaja, wynik przechodzi ten sam walidator co odczyt. Nic nie zapisuje.
 */
async function planListEdit(
  layout: CwmLayout,
  file: string,
  label: string,
  block: readonly string[],
  id: string,
  validate: (value: unknown) => { readonly ok: boolean },
  guard?: (doc: Document) => void,
): Promise<ListEdit> {
  const read = await readTextWithin(layout.home, file);
  if (!read.ok) {
    throw new WorkflowCommandError(
      read.reason === 'missing'
        ? `Brak pliku ${label}.`
        : `${label}: nie da sie odczytac (${read.message}).`,
    );
  }
  const doc = parseDocument(read.text, {
    schema: 'core',
    version: '1.2',
    merge: false,
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length > 0) throw new WorkflowCommandError(`${label} nie jest poprawnym YAML.`);
  guard?.(doc);
  const path = [...block, 'workflows'];
  const list = doc.getIn(path, true);
  if (isSeq(list) && list.items.some((item) => isScalar(item) && item.value === id)) {
    return { file, text: read.text, changed: false, label };
  }
  if (isSeq(list)) list.add(doc.createNode(id));
  else doc.setIn(path, doc.createNode([id]));
  const text = doc.toString({ lineWidth: 0 });
  const parsed = parseManifestYaml(text);
  if (!parsed.ok || !validate(parsed.value).ok) {
    throw new WorkflowCommandError(`Zmieniony ${label} nie przechodzi walidacji; zapis odrzucony.`);
  }
  return { file, text, changed: true, label };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function addWorkflowToRegistry(
  layout: CwmLayout,
  input: AddWorkflowInput,
): Promise<AddWorkflowResult> {
  return withGlobalLock(layout, async () => {
    checkRouting(input);
    const target = await targetOf(layout, input.id);
    const check = checkWorkflowSource(input.source, input.id);
    const manifest = workflowManifestDocument(input.id, input);
    const validated = validateResource(manifest);
    if (!validated.ok) {
      throw new WorkflowCommandError('Manifest workflow nie przechodzi walidacji.');
    }

    const { ids } = await listCompanyIds(layout);
    const registry = await FileResourceRegistry.load(layout, ids);
    const existing = registry.entries.filter(
      (e) => e.resource.kind === 'workflow' && e.resource.id === input.id,
    );
    if (existing.length > 1) {
      throw new WorkflowCommandError(`Id ${input.id} ma w rejestrze kilka definicji (cwm doctor).`);
    }
    const encoder = new TextEncoder();
    const manifestBytes = encoder.encode(toYaml(manifest));
    let unchanged = false;
    const [current] = existing;
    if (current !== undefined) {
      const sameSource = await readSourceFile(current.dir, WORKFLOW_SOURCE_FILE);
      const sameManifest = await readSourceFile(current.dir, 'workflow.yaml');
      if (
        sameSource === null ||
        sameManifest === null ||
        !sameBytes(sameSource, input.source) ||
        !sameBytes(sameManifest, manifestBytes)
      ) {
        throw new WorkflowCommandError(
          `Workflow ${input.id} juz istnieje (${current.file}) z inna trescia albo regulami; nie nadpisuje.`,
        );
      }
      unchanged = true;
    }

    // Firma z id we wlasnej przestrzeni moze wlaczyc workflow tylko u siebie (reszta to zasob obcy).
    const companies = [...new Set(input.companies)];
    for (const company of companies) {
      if (!isSafeSegment(company)) {
        throw new WorkflowCommandError(`Niepoprawne id firmy "${company}".`);
      }
      if (target.scope === 'company' && company !== target.space) {
        throw new WorkflowCommandError(
          `Workflow ${input.id} nalezy do firmy "${target.space}" i nie moze byc wlaczony w firmie "${company}".`,
        );
      }
    }
    if (input.global !== null && target.scope === 'company') {
      throw new WorkflowCommandError(
        `Workflow firmy "${target.space}" nie moze byc na liscie globalnej (uzyj id global/<nazwa>).`,
      );
    }

    const edits: ListEdit[] = [];
    for (const company of companies) {
      edits.push(
        await planListEdit(
          layout,
          companyManifestFile(layout, company),
          `companies/${company}/company.yaml`,
          ['resources', 'enable'],
          input.id,
          validateCompanyManifest,
          (doc) => {
            const off = doc.getIn(['resources', 'disableOptional', 'workflows'], true);
            if (isSeq(off) && off.items.some((i) => isScalar(i) && i.value === input.id)) {
              throw new WorkflowCommandError(
                `Firma "${company}" wylacza ${input.id} (resources.disableOptional); nie wlaczono.`,
              );
            }
          },
        ),
      );
    }
    let globalEdit: ListEdit | null = null;
    if (input.global !== null) {
      globalEdit = await planListEdit(
        layout,
        layout.configFile,
        'config.yaml',
        ['resources', input.global],
        input.id,
        validateGlobalConfig,
      );
    }

    if (!unchanged) {
      await replaceScopedTree(homeScope(layout.home), target.dir, [
        { rel: 'workflow.yaml', bytes: manifestBytes, executable: false },
        { rel: WORKFLOW_SOURCE_FILE, bytes: input.source, executable: false },
      ]);
    }
    const scope = homeScope(layout.home);
    for (const edit of [...edits, ...(globalEdit === null ? [] : [globalEdit])]) {
      if (edit.changed) await writeScopedFile(scope, edit.file, edit.text);
    }
    return {
      status: unchanged ? 'unchanged' : 'created',
      id: input.id,
      dir: target.dir,
      enabled: companies.filter((_, index) => edits[index]?.changed === true),
      alreadyEnabled: companies.filter((_, index) => edits[index]?.changed === false),
      globalChanged: globalEdit?.changed === true,
      needsApproval: check.needsApproval,
    };
  });
}

export interface WorkflowEntry {
  readonly workflow: Workflow;
  readonly entry: RegistryEntry;
}

/** Zasoby `Workflow` z rejestru i katalogow firm, posortowane po id. */
export function workflowEntries(registry: FileResourceRegistry): WorkflowEntry[] {
  return registry.entries
    .filter((e): e is RegistryEntry & { resource: Workflow } => isWorkflow(e.resource))
    .map((entry) => ({ workflow: entry.resource, entry }))
    .sort((a, b) => (a.workflow.id < b.workflow.id ? -1 : a.workflow.id > b.workflow.id ? 1 : 0));
}

const isWorkflow = (resource: Resource): resource is Workflow => resource.kind === 'workflow';
