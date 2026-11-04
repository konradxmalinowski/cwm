import { SourceReadError, type SourceReader } from '../../core/ports/source-reader';
import type { LibraryItem, LoadedItem } from '../../core/model/item';
import type { CompatibilityVerdict, WritePlan } from '../../core/model/plan';
import type {
  DetectedRoot,
  ExportContext,
  RootKind,
  ScanResult,
  ToolAdapter,
  ToolExporter,
} from '../../core/ports/tool-adapter';
import { addHookCandidates, isRecord } from '../shared/hooks';
import { scanInstructionFile } from '../shared/instructions';
import { scanMarkdownDirectory } from '../shared/markdown-dir';
import { ScanContext, unsupportedRootKind } from '../shared/scan-context';
import { scanSkillsRoot } from '../shared/skills';
import { TextDecodeError, toParsableText } from '../shared/text';
import { mapAgentAttributes } from './agent-attributes';
import { claudeCapabilities, planClaude } from './export';

const NAME = 'Claude Code';

/** Adapter Claude Code: import (Etap 3) i plan eksportu (Etap 4). Zapis robi `WriteGate`. */
export class ClaudeCodeAdapter implements ToolAdapter, ToolExporter {
  readonly id = 'claude-code' as const;
  readonly displayName = NAME;
  readonly rootKinds: readonly RootKind[] = [
    'skills',
    'agents',
    'commands',
    'global-instructions',
    'hooks',
  ];

  capabilities(item: LibraryItem): CompatibilityVerdict {
    return claudeCapabilities(item);
  }

  plan(items: readonly LoadedItem[], ctx: ExportContext): Promise<WritePlan> {
    return planClaude(items, ctx);
  }

  async scan(root: DetectedRoot, reader: SourceReader): Promise<ScanResult> {
    const ctx = new ScanContext(this.id, root, reader);
    if (!root.exists) return ctx.result();
    switch (root.kind) {
      case 'skills':
        await scanSkillsRoot(ctx, { flatFiles: true, baseWarnings: [] });
        break;
      case 'agents':
        await scanMarkdownDirectory(ctx, {
          kind: 'agent',
          noun: 'agenci',
          mapAttributes: mapAgentAttributes,
          warnWithoutFrontmatter: true,
        });
        break;
      case 'commands':
        await scanMarkdownDirectory(ctx, {
          kind: 'command',
          noun: 'komendy',
          warnWithoutFrontmatter: false,
        });
        break;
      case 'global-instructions':
        await scanInstructionFile(ctx, 'CLAUDE.md', 'claude-md');
        break;
      case 'hooks':
        await scanHooks(ctx);
        break;
      default:
        return unsupportedRootKind(this.id, root, NAME);
    }
    return ctx.result();
  }
}

/** Z `settings.json` czytamy wylacznie klucz `hooks`; reszta pliku moze trzymac sekrety. */
async function scanHooks(ctx: ScanContext): Promise<void> {
  const file = 'settings.json';
  let bytes: Uint8Array;
  try {
    bytes = await ctx.read('');
  } catch (error) {
    if (error instanceof SourceReadError && error.failure === 'not-found') return;
    ctx.skipFromError(error, file);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toParsableText(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TextDecodeError)) throw error;
    ctx.skip(file, 'malformed', `Plik "${file}" nie jest poprawnym JSON-em.`);
    return;
  }
  if (!isRecord(parsed)) {
    ctx.skip(file, 'malformed', `Plik "${file}" nie zawiera obiektu JSON.`);
    return;
  }
  if (!('hooks' in parsed)) return;
  addHookCandidates(ctx, parsed['hooks'], { file, warnings: [], rootUnmapped: [] });
}

export function createClaudeCodeAdapter(): ToolAdapter {
  return new ClaudeCodeAdapter();
}
