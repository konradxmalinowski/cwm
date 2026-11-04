import type { LibraryItem, LoadedItem, ReasoningDepth } from '../../core/model/item';
import type { CompatibilityVerdict, WritePlan } from '../../core/model/plan';
import type { ExportContext } from '../../core/ports/tool-adapter';
import { asText, type YamlValue } from '../shared/frontmatter';
import { renderMarkdown, type FrontmatterEdits } from '../shared/export/emit';
import { planInstructions, planHooks } from '../shared/export/file-plans';
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
import { PlanBuilder, encode, pickRoot } from '../shared/export/plan-support';
import { foreignUnmapped, unsupportedKind, verdict } from '../shared/export/verdicts';
import { MODEL_DEPTH, mapAgentAttributes } from './agent-attributes';

const TOOL = 'claude-code' as const;
const DEPTH_MODEL: Readonly<Record<ReasoningDepth, string>> = {
  routine: 'haiku',
  deep: 'sonnet',
  deepest: 'opus',
};

const FOREIGN_KEYS =
  'Pola specyficzne dla innego narzędzia nie mają odpowiednika w Claude Code. Zostają w snapshocie źródła.';

/** Werdykt dla konkretnego elementu (ARCHITECTURE 4.3). Czysta funkcja, bez I/O. */
export function claudeCapabilities(item: LibraryItem): CompatibilityVerdict {
  switch (item.kind) {
    case 'skill':
    case 'command': {
      const lost = foreignUnmapped(item, TOOL, 'frontmatter.');
      return lost.length === 0 ? verdict('full') : verdict('partial', [FOREIGN_KEYS], lost);
    }
    case 'agent': {
      const lost = foreignUnmapped(item, TOOL);
      return lost.length === 0 ? verdict('full') : verdict('partial', [FOREIGN_KEYS], lost);
    }
    case 'global-instruction':
      return verdict('partial', [
        'Zarządzany jest blok między znacznikami aplikacji w CLAUDE.md, nie cały plik. Treść poza blokiem nie jest ani eksportowana, ani kontrolowana (ADR 0025).',
      ]);
    case 'hook':
      return verdict('full');
    default:
      return unsupportedKind(item);
  }
}

/** Glowny plik zrodla z tego samego narzedzia, jesli element stamtad pochodzi. */
function mainPath(loaded: LoadedItem): string | null {
  const snapshot = loaded.item.source.snapshots.find((s) => s.tool === TOOL);
  return snapshot?.files[0]?.relPath ?? null;
}

function modelFor(depth: ReasoningDepth, src: MarkdownSource | null): string {
  const current = src === null ? null : asText(src.frontmatter.data.get('model'));
  if (current !== null && MODEL_DEPTH[current.toLowerCase()] === depth) return current;
  return DEPTH_MODEL[depth];
}

function baseOf(src: MarkdownSource | null): MarkdownSource['frontmatter'] | null {
  return src !== null && src.frontmatter.present ? src.frontmatter : null;
}

function renderSkillLike(loaded: LoadedItem, src: MarkdownSource | null): Uint8Array {
  if (src !== null && sameSemantics(loaded, src.draft)) return src.bytes;
  const { item } = loaded;
  const edits: FrontmatterEdits = new Map<string, YamlValue | undefined>([
    ['name', item.identity.declaredName ?? undefined],
    [
      'description',
      item.content.descriptionOrigin === 'source' ? item.content.description : undefined,
    ],
  ]);
  const text = renderMarkdown(baseOf(src), edits, item.content.body);
  return encode(withSourceEol(text, src?.bytes ?? null));
}

function renderAgent(loaded: LoadedItem, src: MarkdownSource | null): Uint8Array {
  if (src !== null && sameSemantics(loaded, src.draft)) return src.bytes;
  const { item } = loaded;
  const edits = new Map<string, YamlValue | undefined>([
    ['name', item.identity.declaredName ?? item.identity.slug],
    ['description', item.content.description],
  ]);
  const depth = item.attributes.reasoningDepth;
  if (depth !== undefined) edits.set('model', modelFor(depth, src));
  edits.set('color', item.attributes.presentation?.accentColor);
  edits.set('memory', item.attributes.memoryScope);
  const text = renderMarkdown(baseOf(src), edits, item.content.body);
  return encode(withSourceEol(text, src?.bytes ?? null));
}

export async function planClaude(
  items: readonly LoadedItem[],
  ctx: ExportContext,
): Promise<WritePlan> {
  const b = new PlanBuilder(TOOL);
  const instructions: LoadedItem[] = [];
  const hooks: LoadedItem[] = [];
  const listings = new Map<string, RootListing>();
  const listingFor = async (root: Parameters<typeof listRoot>[1]): Promise<RootListing> => {
    const cached = listings.get(root.rootId);
    if (cached !== undefined) return cached;
    const fresh = await listRoot(ctx, root);
    listings.set(root.rootId, fresh);
    return fresh;
  };

  for (const loaded of items) {
    const { item } = loaded;
    const v = claudeCapabilities(item);
    b.verdict(item, v);
    if (v.level === 'unsupported') {
      b.refuse(item, v.reasons.join(' '));
      continue;
    }
    switch (item.kind) {
      case 'skill': {
        const choice = pickRoot(ctx, TOOL, 'skills');
        if (choice.root === null) {
          b.refuse(item, choice.missing);
          break;
        }
        const path = mainPath(loaded) ?? 'SKILL.md';
        const src = loadMarkdownSource(loaded, { tool: TOOL, kind: 'skill', relPath: path });
        const md = renderSkillLike(loaded, src);
        if (path !== 'SKILL.md' && path.toLowerCase().endsWith('.md')) {
          // Skill plaski zostaje plaskim plikiem, tak jak go napisal autor.
          await planWholeFile(b, ctx, choice.root, loaded, `${item.identity.slug}.md`, md);
        } else {
          await planSkillDirectory(
            b,
            ctx,
            await listingFor(choice.root),
            loaded,
            item.identity.slug,
            skillFiles(loaded, md, TOOL),
          );
        }
        break;
      }
      case 'agent': {
        const choice = pickRoot(ctx, TOOL, 'agents');
        if (choice.root === null) {
          b.refuse(item, choice.missing);
          break;
        }
        const src = loadMarkdownSource(loaded, {
          tool: TOOL,
          kind: 'agent',
          relPath: mainPath(loaded) ?? `${item.identity.slug}.md`,
          mapAttributes: mapAgentAttributes,
        });
        await planWholeFile(
          b,
          ctx,
          choice.root,
          loaded,
          `${item.identity.slug}.md`,
          renderAgent(loaded, src),
        );
        break;
      }
      case 'command': {
        const choice = pickRoot(ctx, TOOL, 'commands');
        if (choice.root === null) {
          b.refuse(item, choice.missing);
          break;
        }
        const src = loadMarkdownSource(loaded, {
          tool: TOOL,
          kind: 'command',
          relPath: mainPath(loaded) ?? `${item.identity.slug}.md`,
        });
        await planWholeFile(
          b,
          ctx,
          choice.root,
          loaded,
          `${item.identity.slug}.md`,
          renderSkillLike(loaded, src),
        );
        break;
      }
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

  await planInstructions(
    b,
    ctx,
    { tool: TOOL, kind: 'global-instructions', fileName: 'CLAUDE.md' },
    instructions,
  );
  await planHooks(
    b,
    ctx,
    { tool: TOOL, kind: 'hooks', fileName: 'settings.json', knownEvents: null },
    hooks,
  );
  return b.build();
}
