import type { JsonValue, LibraryItem, LoadedItem, ReasoningDepth } from '../../core/model/item';
import type { CompatibilityVerdict, WritePlan } from '../../core/model/plan';
import type { ExportContext } from '../../core/ports/tool-adapter';
import { renderAgentToml, renderMarkdown, type FrontmatterEdits } from '../shared/export/emit';
import { planHooks, planInstructions, decodeRaw } from '../shared/export/file-plans';
import {
  listRoot,
  planSkillDirectory,
  planWholeFile,
  skillFiles,
  type RootListing,
} from '../shared/export/item-plans';
import {
  loadMarkdownSource,
  sameSemantics,
  withSourceEol,
  type MarkdownSource,
} from '../shared/export/markdown-export';
import {
  PlanBuilder,
  TargetReadError,
  encode,
  pickRoot,
  readTarget,
  snapshotBytes,
} from '../shared/export/plan-support';
import { foreignUnmapped, unsupportedKind, verdict, worst } from '../shared/export/verdicts';
import type { YamlValue } from '../shared/frontmatter';
import { SegmentTomlEditor, type AgentRegistration } from '../shared/toml/segment-editor';
import { TextDecodeError } from '../shared/text';
import { EFFORT_DEPTH, agentEffort, parseAgentDraft, registryTarget } from './agents';

const TOOL = 'codex' as const;

/** Zdarzenia hookow, ktore Codex czyta; inne sa po cichu pomijane (ARCHITECTURE 4.3). */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
];

const DEPTH_EFFORT: Readonly<Record<ReasoningDepth, string>> = {
  routine: 'low',
  deep: 'medium',
  deepest: 'xhigh',
};

const KNOWN_TOML_KEYS = new Set(['name', 'description', 'developer_instructions']);

const FOREIGN =
  'Pola specyficzne dla innego narzędzia nie mają odpowiednika w Codeksie. Zostają w snapshocie źródła.';

function skillAdditions(item: LibraryItem): string[] {
  const added: string[] = [];
  if (item.identity.declaredName === null) added.push('name');
  if (item.content.descriptionOrigin === 'derived') added.push('description');
  return added;
}

/** Werdykt dla konkretnego elementu (ARCHITECTURE 4.3, ADR 0021, 0026). Czysta funkcja, bez I/O. */
export function codexCapabilities(item: LibraryItem): CompatibilityVerdict {
  switch (item.kind) {
    case 'skill': {
      const reasons: string[] = [];
      const lost = foreignUnmapped(item, TOOL, 'frontmatter.');
      const added = skillAdditions(item);
      let level = verdict('full').level;
      if (lost.length > 0) {
        level = worst(level, 'partial');
        reasons.push(FOREIGN);
      }
      const declared = item.identity.declaredName;
      if (declared !== null && declared !== item.identity.slug) {
        level = worst(level, 'lossy');
        reasons.push(
          `Element będzie widoczny w Codeksie pod nazwą z frontmattera ("${declared}"), inną niż nazwa katalogu w Claude Code ("${item.identity.slug}").`,
        );
      }
      if (added.length > 0) {
        level = worst(level, 'lossy');
        reasons.push(
          `Codex wymaga frontmattera z polami name i description. Aplikacja dopisze: ${added.join(', ')}.`,
        );
      }
      return verdict(level, reasons, lost, added);
    }
    case 'command': {
      const lost = ['wywołanie przez /nazwa', ...foreignUnmapped(item, TOOL, 'frontmatter.')];
      return verdict(
        'lossy',
        [
          'Codex nie ma pojęcia komendy. Element będzie dostępny jako skill, bez wywołania przez ukośnik (ADR 0021).',
        ],
        lost,
        skillAdditions(item),
      );
    }
    case 'agent': {
      const reasons = [
        'Agent trafia w dwa miejsca: plik agents/<nazwa>.toml i wpis [agents.<nazwa>] w config.toml (ADR 0011).',
      ];
      const lost: string[] = [];
      if (item.attributes.reasoningDepth !== undefined) {
        reasons.push('Model jest przybliżany poziomem rozumowania (model_reasoning_effort).');
      }
      if (item.attributes.presentation?.accentColor !== undefined) lost.push('color');
      if (item.attributes.memoryScope !== undefined) lost.push('memory');
      lost.push(...foreignUnmapped(item, TOOL));
      if (lost.length > 0)
        reasons.push('Część pól nie ma odpowiednika w Codeksie i zostaje w snapshocie.');
      return verdict('partial', reasons, lost);
    }
    case 'global-instruction':
      return verdict('partial', [
        'Zarządzany jest blok między znacznikami aplikacji w AGENTS.md, nie cały plik. Treść poza blokiem nie jest ani eksportowana, ani kontrolowana (ADR 0025).',
      ]);
    case 'hook': {
      const reasons = [
        'Codex czyta tylko hooks.<Zdarzenie> i po cichu pomija zdarzenia, których nie zna.',
      ];
      const event = item.attributes.hook?.event;
      if (event !== undefined && !CODEX_HOOK_EVENTS.includes(event)) {
        reasons.push(`Zdarzenie "${event}" nie jest na liście znanych Codeksowi.`);
      }
      return verdict('partial', reasons);
    }
    default:
      return unsupportedKind(item);
  }
}

function mainPath(loaded: LoadedItem): string | null {
  const snapshot = loaded.item.source.snapshots.find((s) => s.tool === TOOL);
  return snapshot?.files[0]?.relPath ?? null;
}

function renderSkill(loaded: LoadedItem, src: MarkdownSource | null): Uint8Array {
  if (src !== null && sameSemantics(loaded, src.draft)) return src.bytes;
  const { item } = loaded;
  const description =
    item.content.description !== '' ? item.content.description : item.content.title;
  const edits: FrontmatterEdits = new Map<string, YamlValue | undefined>([
    ['name', item.identity.declaredName ?? item.identity.slug],
    ['description', description],
  ]);
  const base = src !== null && src.frontmatter.present ? src.frontmatter : null;
  return encode(withSourceEol(renderMarkdown(base, edits, item.content.body), src?.bytes ?? null));
}

function effortFor(depth: ReasoningDepth, current: string | null): string {
  if (current !== null && EFFORT_DEPTH[current.toLowerCase()] === depth) return current;
  return DEPTH_EFFORT[depth];
}

function renderAgentFile(loaded: LoadedItem, source: Uint8Array | undefined): Uint8Array {
  const { item } = loaded;
  const depth = item.attributes.reasoningDepth;
  const extras: { key: string; value: JsonValue }[] = [];
  const snapshot = item.source.snapshots.find((s) => s.tool === TOOL);
  for (const u of snapshot?.unmappedKeys ?? []) {
    if (!u.path.startsWith('toml.')) continue;
    const key = u.path.slice('toml.'.length);
    if (!KNOWN_TOML_KEYS.has(key)) extras.push({ key, value: u.value });
  }
  return encode(
    renderAgentToml({
      name: item.identity.declaredName ?? item.identity.slug,
      description: item.content.description,
      effort:
        depth === undefined
          ? null
          : effortFor(depth, source === undefined ? null : agentEffort(source)),
      instructions: item.content.body,
      extras,
    }),
  );
}

interface SkillLike {
  readonly loaded: LoadedItem;
  readonly name: string;
}

export async function planCodex(
  items: readonly LoadedItem[],
  ctx: ExportContext,
): Promise<WritePlan> {
  const b = new PlanBuilder(TOOL);
  const skillLike: SkillLike[] = [];
  const agents: LoadedItem[] = [];
  const instructions: LoadedItem[] = [];
  const hooks: LoadedItem[] = [];

  for (const loaded of items) {
    const { item } = loaded;
    const v = codexCapabilities(item);
    b.verdict(item, v);
    if (v.level === 'unsupported') {
      b.refuse(item, v.reasons.join(' '));
      continue;
    }
    switch (item.kind) {
      case 'skill':
      case 'command':
        skillLike.push({ loaded, name: item.identity.declaredName ?? item.identity.slug });
        break;
      case 'agent':
        agents.push(loaded);
        break;
      case 'global-instruction':
        instructions.push(loaded);
        break;
      case 'hook':
        hooks.push(loaded);
        break;
      default:
        break;
    }
  }

  await planSkills(b, ctx, skillLike);
  await planAgents(b, ctx, agents);
  await planInstructions(
    b,
    ctx,
    { tool: TOOL, kind: 'global-instructions', fileName: 'AGENTS.md' },
    instructions,
  );
  await planHooks(
    b,
    ctx,
    { tool: TOOL, kind: 'hooks', fileName: 'hooks.json', knownEvents: CODEX_HOOK_EVENTS },
    hooks,
  );
  return b.build();
}

/** Konflikty nazw w obrebie jednego celu: ta sama sciezka (ADR 0021) albo ta sama nazwa (ADR 0026). */
function findConflicts(b: PlanBuilder, entries: readonly SkillLike[]): ReadonlySet<LoadedItem> {
  const blocked = new Set<LoadedItem>();
  const byDir = new Map<string, SkillLike[]>();
  const byName = new Map<string, SkillLike[]>();
  for (const e of entries) {
    const dir = e.loaded.item.identity.slug.toLowerCase();
    byDir.set(dir, [...(byDir.get(dir) ?? []), e]);
    const name = e.name.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), e]);
  }
  const report = (group: readonly SkillLike[], relPath: string, reason: string): void => {
    const fresh = group.filter((g) => !blocked.has(g.loaded));
    if (group.length < 2 || fresh.length === 0) return;
    for (const g of group) blocked.add(g.loaded);
    b.conflict(
      group.map((g) => g.loaded.item.id),
      relPath,
      reason,
    );
  };
  for (const group of byDir.values()) {
    const kinds = new Set(group.map((g) => g.loaded.item.kind));
    report(
      group,
      `skills/${group[0]?.loaded.item.identity.slug ?? ''}`,
      kinds.has('command') && kinds.has('skill')
        ? 'Komenda i skill mają tę samą nazwę, a w Codeksie komenda staje się skillem. Aplikacja nie zapisze obu pod jedną nazwą: zdecyduj, który zostaje (ADR 0021).'
        : 'Dwa elementy trafiłyby w to samo miejsce w Codeksie. Zdecyduj, który zostaje.',
    );
  }
  for (const group of byName.values()) {
    report(
      group,
      `skills/${group[0]?.loaded.item.identity.slug ?? ''}`,
      `Dwa różne elementy deklarują w Codeksie tę samą nazwę ("${group[0]?.name ?? ''}"). Codex kluczuje skille po nazwie z frontmattera, więc jeden przesłoniłby drugi (ADR 0026).`,
    );
  }
  return blocked;
}

async function planSkills(
  b: PlanBuilder,
  ctx: ExportContext,
  entries: readonly SkillLike[],
): Promise<void> {
  if (entries.length === 0) return;
  const blocked = findConflicts(b, entries);
  const choice = pickRoot(ctx, TOOL, 'skills');
  let listing: RootListing | null = null;
  for (const { loaded } of entries) {
    if (blocked.has(loaded)) continue;
    if (choice.root === null) {
      b.refuse(loaded.item, choice.missing);
      continue;
    }
    listing ??= await listRoot(ctx, choice.root);
    const { item } = loaded;
    const path = mainPath(loaded) ?? 'SKILL.md';
    const src =
      item.kind === 'skill'
        ? loadMarkdownSource(loaded, { tool: TOOL, kind: 'skill', relPath: path })
        : null;
    const md = renderSkill(loaded, src);
    const notes: string[] = [];
    if (item.kind === 'command') {
      notes.push('Komenda zostanie zapisana jako skill: Codex nie ma pojęcia komendy.');
    }
    await planSkillDirectory(
      b,
      ctx,
      listing,
      loaded,
      item.identity.slug,
      skillFiles(loaded, md, TOOL),
      notes,
    );
  }
}

async function planAgents(
  b: PlanBuilder,
  ctx: ExportContext,
  agents: readonly LoadedItem[],
): Promise<void> {
  if (agents.length === 0) return;
  const refuseAll = (reason: string): void => {
    for (const a of agents) b.refuse(a.item, reason);
  };
  const dir = pickRoot(ctx, TOOL, 'agents');
  const registry = pickRoot(ctx, TOOL, 'agent-registry');
  if (dir.root === null) return refuseAll(dir.missing);
  if (registry.root === null) return refuseAll(registry.missing);

  let configBytes: Uint8Array | null;
  try {
    configBytes = await readTarget(ctx.reader, registry.root.rootId, '');
  } catch (error) {
    if (!(error instanceof TargetReadError)) throw error;
    return refuseAll(error.message);
  }
  if (configBytes === null) {
    return refuseAll(
      'Plik config.toml nie istnieje. Aplikacja nie tworzy konfiguracji narzędzia od zera.',
    );
  }
  let configText: string;
  try {
    configText = decodeRaw(configBytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    return refuseAll(
      'Plik config.toml nie jest poprawnym tekstem UTF-8, więc aplikacja go nie zmieni.',
    );
  }

  interface Prepared {
    readonly loaded: LoadedItem;
    readonly file: string;
    readonly bytes: Uint8Array;
    readonly previous: Uint8Array | null;
    readonly registration: AgentRegistration;
  }
  const prepared: Prepared[] = [];
  for (const loaded of agents) {
    const { item } = loaded;
    const path = mainPath(loaded) ?? `${item.identity.slug}.toml`;
    const stem = path.replace(/\.toml$/i, '');
    let previous: Uint8Array | null;
    try {
      previous = await readTarget(ctx.reader, dir.root.rootId, path);
    } catch (error) {
      if (!(error instanceof TargetReadError)) throw error;
      b.refuse(item, error.message);
      continue;
    }
    const sourceBytes = snapshotBytes(loaded, TOOL, path);
    const srcDraft = sourceBytes === undefined ? null : parseAgentDraft(sourceBytes, stem);
    const bytes =
      sourceBytes !== undefined && srcDraft !== null && sameSemantics(loaded, srcDraft)
        ? sourceBytes
        : renderAgentFile(loaded, sourceBytes);
    const prevDraft = previous === null ? null : parseAgentDraft(previous, stem);
    const entryName = registryName(loaded) ?? stem;
    prepared.push({
      loaded,
      file: path,
      bytes,
      previous,
      registration: {
        name: entryName,
        description: item.content.description,
        // Opis wpisu zostaje, dopoki opis w pliku agenta nie zmienil sie od ostatniego zapisu.
        keepDescription:
          prevDraft !== null && prevDraft.content.description === item.content.description,
        configFile: `agents/${path}`,
      },
    });
  }
  if (prepared.length === 0) return;

  const editor = new SegmentTomlEditor();
  const edit = editor.edit(
    configText,
    prepared.map((p) => p.registration),
    { sameConfigFile: (existing, desired) => registryTarget(existing) === desired },
  );
  if (!edit.ok) {
    for (const p of prepared) b.refuse(p.loaded.item, edit.message);
    return;
  }
  for (const p of prepared) {
    await planWholeFile(b, ctx, dir.root, p.loaded, p.file, p.bytes);
  }
  b.entry({
    rootId: registry.root.rootId,
    relPath: 'config.toml',
    action: edit.changed ? 'modify' : 'unchanged',
    scope: 'toml-segment',
    itemIds: prepared.map((p) => p.loaded.item.id),
    content: edit.changed ? encode(edit.text) : configBytes,
    previous: configBytes,
  });
}

/** Nazwa tabeli `[agents.<nazwa>]` zapamietana przy imporcie (snapshot `registry.entry`). */
function registryName(loaded: LoadedItem): string | null {
  const snapshot = loaded.item.source.snapshots.find((s) => s.tool === TOOL);
  const entry = snapshot?.unmappedKeys.find((k) => k.path === 'registry.entry');
  return typeof entry?.value === 'string' && entry.value !== '' ? entry.value : null;
}
