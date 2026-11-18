import type { ItemId, LibraryItem, LoadedItem, ToolId } from '../../../core/model/item';
import type {
  CompatibilityVerdict,
  ConflictResolution,
  PlanConflictOption,
} from '../../../core/model/plan';
import type { DetectedRoot, ExportContext } from '../../../core/ports/tool-adapter';
import {
  checkMcpExport,
  describeMcpDifference,
  fromClaudeServer,
  fromCodexServer,
  readMcpServer,
  sameMcpServer,
  toClaudeServer,
  toCodexServer,
  type McpEnvRef,
  type McpServerSpec,
} from '../../../core/services/mcp/mcp-server';
import { TextDecodeError, encodeUtf8 } from '../text';
import { editMcpSegments, type McpSegment } from '../toml/mcp-segments';
import { parseTree } from '../toml/segment-editor';
import { decodeRaw } from './file-plans';
import { isJsonRecord, jsonEqual, setTopLevelKey, type JsonRecord } from './json-key';
import { PlanBuilder, TargetReadError, pickRoot, readTarget } from './plan-support';
import { verdict } from './verdicts';

/**
 * Eksport serwerow MCP (ADR 0061). Wspolne dla Claude Code (klucz `mcpServers` w `~/.claude.json` albo
 * w `.mcp.json` projektu) i Codeksa (segmenty `[mcp_servers.<nazwa>]` w `config.toml`). Reguly i mapowanie
 * sa w core (`mcp-server.ts`); tu jest tylko odczyt celu i edycja pliku istniejacymi mechanizmami.
 */

const BOM = '\uFEFF';

export const REPLACE_SERVER_OPTION: PlanConflictOption = {
  id: 'replace-server' satisfies ConflictResolution,
  label: 'Zastąp istniejący serwer definicją z biblioteki',
};

/** Werdykt serwera MCP dla narzedzia: odmowa z powodem albo `partial` z opisem, co trafi do pliku. */
export function mcpCapabilities(item: LibraryItem, tool: ToolId): CompatibilityVerdict {
  const read = readMcpServer(item);
  if (!read.ok) return verdict('unsupported', [read.reason]);
  const check = checkMcpExport(read.spec, tool);
  if (check.refusal !== null) return verdict('unsupported', [check.refusal]);
  const lost = item.source.snapshots.flatMap((s) =>
    s.unmappedKeys.filter((k) => k.path.startsWith('server.')).map((k) => k.path),
  );
  return verdict(
    'partial',
    [
      'Eksport serwera MCP jest zawsze jawny i wymaga osobnego potwierdzenia. Wartości zmiennych środowiskowych nie są kopiowane, tylko odniesienia do nich (ADR 0061).',
      ...(lost.length > 0
        ? ['Część pól serwera nie ma odpowiednika w bibliotece i nie trafi do pliku.']
        : []),
    ],
    lost,
  );
}

interface Prepared {
  readonly loaded: LoadedItem;
  readonly spec: McpServerSpec;
  readonly env: readonly McpEnvRef[];
  readonly warnings: readonly string[];
}

/** Serwery, ktore przeszly reguly; reszta trafia do odmow planu. Dwa elementy o tej samej nazwie to konflikt. */
function prepare(
  b: PlanBuilder,
  tool: ToolId,
  items: readonly LoadedItem[],
  relPath: string,
): Prepared[] {
  const out: Prepared[] = [];
  for (const loaded of items) {
    const read = readMcpServer(loaded.item);
    if (!read.ok) {
      b.refuse(loaded.item, read.reason);
      continue;
    }
    const check = checkMcpExport(read.spec, tool);
    if (check.refusal !== null) {
      b.refuse(loaded.item, check.refusal);
      continue;
    }
    out.push({ loaded, spec: read.spec, env: check.env, warnings: check.warnings });
  }
  const byName = new Map<string, Prepared[]>();
  for (const p of out) byName.set(p.spec.name, [...(byName.get(p.spec.name) ?? []), p]);
  const kept: Prepared[] = [];
  for (const group of byName.values()) {
    if (group.length === 1 && group[0] !== undefined) {
      kept.push(group[0]);
      continue;
    }
    b.conflict(
      group.map((g) => g.loaded.item.id),
      relPath,
      `Kilka elementów opisuje serwer MCP o nazwie „${group[0]?.spec.name ?? ''}”. Wybierz jeden do eksportu.`,
    );
  }
  return kept;
}

function decided(ctx: ExportContext, itemId: ItemId, relPath: string): boolean {
  return (
    ctx.decisions?.some(
      (d) => d.itemId === itemId && d.relPath === relPath && d.resolution === 'replace-server',
    ) ?? false
  );
}

/**
 * Plik roota MCP Claude Code: `.mcp.json` w projekcie (etykieta `acme-app: .mcp.json`), a poza nim
 * `.claude.json` (`~/.claude.json`, `$CLAUDE_CONFIG_DIR/.claude.json`). Nazwa musi byc rowna nazwie
 * pliku roota, bo bramka zapisu rozpoznaje po niej root bedacy plikiem.
 */
export function mcpFileName(root: DetectedRoot): string {
  return root.label.endsWith('.mcp.json') ? '.mcp.json' : '.claude.json';
}

/** Wynik porownania z serwerem o tej samej nazwie w pliku celu. */
type Existing = 'absent' | 'same' | 'replace' | 'conflict';

function compare(
  b: PlanBuilder,
  ctx: ExportContext,
  p: Prepared,
  current: McpServerSpec | null,
  unreadable: string | null,
  relPath: string,
): Existing {
  if (current === null && unreadable === null) return 'absent';
  if (current !== null && sameMcpServer(current, { ...p.spec, env: p.env })) return 'same';
  if (decided(ctx, p.loaded.item.id, relPath)) return 'replace';
  const difference =
    current === null
      ? `obecnej definicji aplikacja nie umie odczytać (${unreadable ?? ''})`
      : describeMcpDifference(current, { ...p.spec, env: p.env });
  b.conflict(
    [p.loaded.item.id],
    relPath,
    `Serwer MCP „${p.spec.name}” już istnieje w ${relPath} z inną definicją: ${difference}. Aplikacja nadpisze go tylko po jawnym wyborze.`,
    [REPLACE_SERVER_OPTION],
  );
  return 'conflict';
}

/** Claude Code: klucz `mcpServers` w `~/.claude.json` albo w `.mcp.json` projektu. Reszta pliku bez zmian. */
export async function planClaudeMcp(
  b: PlanBuilder,
  ctx: ExportContext,
  items: readonly LoadedItem[],
): Promise<void> {
  if (items.length === 0) return;
  const choice = pickRoot(ctx, 'claude-code', 'mcp');
  if (choice.root === null) {
    for (const l of items) b.refuse(l.item, choice.missing);
    return;
  }
  const root = choice.root;
  const fileName = mcpFileName(root);
  const prepared = prepare(b, 'claude-code', items, fileName);
  if (prepared.length === 0) return;
  const refuseAll = (reason: string): void => {
    for (const p of prepared) b.refuse(p.loaded.item, reason);
  };

  let previous: Uint8Array | null;
  try {
    previous = await readTarget(ctx.reader, root.rootId, '');
  } catch (error) {
    if (!(error instanceof TargetReadError)) throw error;
    return refuseAll(error.message);
  }
  let text = '';
  let parsed: unknown = {};
  try {
    if (previous !== null) {
      text = decodeRaw(previous);
      parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    }
  } catch {
    return refuseAll(`Plik ${fileName} nie jest poprawnym JSON-em, więc aplikacja go nie zmieni.`);
  }
  if (!isJsonRecord(parsed)) {
    return refuseAll(`Plik ${fileName} nie zawiera obiektu JSON, więc aplikacja go nie zmieni.`);
  }
  const existing = parsed['mcpServers'];
  if (existing !== undefined && !isJsonRecord(existing)) {
    return refuseAll(
      `Klucz "mcpServers" w ${fileName} nie jest obiektem, więc aplikacja go nie zmieni.`,
    );
  }
  const servers: JsonRecord = structuredClone<JsonRecord>(existing ?? {});
  const used: Prepared[] = [];
  let changed = false;
  for (const p of prepared) {
    const raw = servers[p.spec.name];
    const read = raw === undefined ? null : fromClaudeServer(p.spec.name, raw);
    const state = compare(
      b,
      ctx,
      p,
      read !== null && read.ok ? read.spec : null,
      read !== null && !read.ok ? read.reason : null,
      fileName,
    );
    if (state === 'conflict') continue;
    used.push(p);
    if (state === 'same') continue;
    servers[p.spec.name] = toClaudeServer(p.spec, p.env);
    changed = true;
  }
  if (used.length === 0) return;
  const ids = used.map((p) => p.loaded.item.id);
  const warnings = used.flatMap((p) => p.warnings);

  if (previous === null) {
    b.entry({
      rootId: root.rootId,
      relPath: fileName,
      action: 'create',
      scope: 'json-key',
      itemIds: ids,
      content: encodeUtf8(`${JSON.stringify({ mcpServers: servers }, null, 2)}\n`),
      previous: null,
      warnings,
    });
    return;
  }
  if (!changed) {
    b.entry({
      rootId: root.rootId,
      relPath: fileName,
      action: 'unchanged',
      scope: 'json-key',
      itemIds: ids,
      content: previous,
      previous,
      warnings,
    });
    return;
  }
  const edited = setTopLevelKey(text, 'mcpServers', servers);
  if (!edited.ok) {
    for (const p of used) b.refuse(p.loaded.item, edited.message);
    return;
  }
  // Weryfikacja: poza kluczem mcpServers drzewo jest to samo, a w nim zmienione sa tylko serwery z planu.
  const after = JSON.parse(
    edited.text.startsWith(BOM) ? edited.text.slice(1) : edited.text,
  ) as JsonRecord;
  const { mcpServers: afterServers, ...afterRest } = after;
  const { mcpServers: _beforeServers, ...beforeRest } = parsed;
  void _beforeServers;
  if (!jsonEqual(afterRest, beforeRest) || !jsonEqual(afterServers, servers)) {
    for (const p of used) {
      b.refuse(
        p.loaded.item,
        `Weryfikacja semantyczna ${fileName} nie przeszła. Plik zostaje bez zmian.`,
      );
    }
    return;
  }
  b.entry({
    rootId: root.rootId,
    relPath: fileName,
    action: 'modify',
    scope: 'json-key',
    itemIds: ids,
    content: encodeUtf8(edited.text),
    previous,
    warnings,
  });
}

/**
 * Codex: segmenty `[mcp_servers.<nazwa>]` w `config.toml`. Codex nie ma serwerow MCP w projekcie, wiec
 * bez roota `config.toml` w celu (np. eksport do projektu) kazdy serwer jest odmowiony z tym powodem.
 * `base` to tekst pliku po edycji agentow z tego samego planu: plik ma jeden wpis.
 */
export interface CodexConfigState {
  readonly rootId: string;
  readonly previous: Uint8Array | null;
  readonly text: string;
  readonly changed: boolean;
  readonly itemIds: readonly ItemId[];
  readonly warnings: readonly string[];
}

export const CODEX_PROJECT_REFUSAL =
  'Codex trzyma serwery MCP wyłącznie w globalnym config.toml i nie ma ich w projekcie, więc serwer nie ma gdzie trafić. Wyeksportuj go do katalogu globalnego Codeksa albo do projektu w Claude Code (ADR 0061).';

export async function planCodexMcp(
  b: PlanBuilder,
  ctx: ExportContext,
  items: readonly LoadedItem[],
  base: CodexConfigState | null,
): Promise<CodexConfigState | null> {
  if (items.length === 0) return base;
  const registry = pickRoot(ctx, 'codex', 'agent-registry');
  if (registry.root === null) {
    for (const l of items) b.refuse(l.item, CODEX_PROJECT_REFUSAL);
    return base;
  }
  const rootId = registry.root.rootId;
  const prepared = prepare(b, 'codex', items, 'config.toml');
  if (prepared.length === 0) return base;
  const refuseAll = (reason: string): CodexConfigState | null => {
    for (const p of prepared) b.refuse(p.loaded.item, reason);
    return base;
  };

  let previous: Uint8Array | null;
  let text: string;
  if (base !== null) {
    previous = base.previous;
    text = base.text;
  } else {
    try {
      previous = await readTarget(ctx.reader, rootId, '');
    } catch (error) {
      if (!(error instanceof TargetReadError)) throw error;
      return refuseAll(error.message);
    }
    try {
      text = previous === null ? '' : decodeRaw(previous);
    } catch (error) {
      if (!(error instanceof TextDecodeError)) throw error;
      return refuseAll(
        'Plik config.toml nie jest poprawnym tekstem UTF-8, więc aplikacja go nie zmieni.',
      );
    }
  }
  const tree = parseTree(text);
  if (typeof tree === 'string') return refuseAll(tree);
  const area = tree['mcp_servers'];
  const servers =
    typeof area === 'object' && area !== null && !Array.isArray(area)
      ? (area as Record<string, unknown>)
      : {};

  const segments: McpSegment[] = [];
  const used: Prepared[] = [];
  for (const p of prepared) {
    const raw = servers[p.spec.name];
    const read = raw === undefined ? null : fromCodexServer(p.spec.name, raw);
    const state = compare(
      b,
      ctx,
      p,
      read !== null && read.ok ? read.spec : null,
      read !== null && !read.ok ? read.reason : null,
      'config.toml',
    );
    if (state === 'conflict') continue;
    used.push(p);
    if (state === 'same') continue;
    segments.push({
      name: p.spec.name,
      fields: toCodexServer(p.spec, p.env),
      replace: state === 'replace',
    });
  }
  if (used.length === 0) return base;
  const edit = editMcpSegments(text, segments);
  if (!edit.ok) {
    for (const p of used) b.refuse(p.loaded.item, edit.message);
    return base;
  }
  return {
    rootId,
    previous,
    text: edit.text,
    changed: (base?.changed ?? false) || edit.changed,
    itemIds: [...(base?.itemIds ?? []), ...used.map((p) => p.loaded.item.id)],
    warnings: [...(base?.warnings ?? []), ...used.flatMap((p) => p.warnings)],
  };
}

/** Jeden wpis `config.toml` dla agentow i serwerow MCP z tego samego planu. */
export function emitCodexConfig(b: PlanBuilder, state: CodexConfigState | null): void {
  if (state === null || state.itemIds.length === 0) return;
  b.entry({
    rootId: state.rootId,
    relPath: 'config.toml',
    action: state.previous === null ? 'create' : state.changed ? 'modify' : 'unchanged',
    scope: 'toml-segment',
    itemIds: state.itemIds,
    content:
      state.changed || state.previous === null ? encodeUtf8(state.text) : (state.previous ?? null),
    previous: state.previous,
    warnings: state.warnings,
  });
}
