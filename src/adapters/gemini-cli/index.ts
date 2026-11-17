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
import { scanGeminiCommands } from './commands';
import { geminiCapabilities, planGemini } from './export';

const NAME = 'Gemini CLI';

/** Adapter Gemini CLI (ADR 0055): import i plan eksportu. Zapis robi `WriteGate`. */
export class GeminiCliAdapter implements ToolAdapter, ToolExporter {
  readonly id = 'gemini-cli' as const;
  readonly displayName = NAME;
  readonly rootKinds: readonly RootKind[] = [
    'skills',
    'agents',
    'commands',
    'global-instructions',
    'hooks',
  ];

  capabilities(item: LibraryItem): CompatibilityVerdict {
    return geminiCapabilities(item);
  }

  plan(items: readonly LoadedItem[], ctx: ExportContext): Promise<WritePlan> {
    return planGemini(items, ctx);
  }

  async scan(root: DetectedRoot, reader: SourceReader): Promise<ScanResult> {
    const ctx = new ScanContext(this.id, root, reader);
    if (!root.exists) return ctx.result();
    switch (root.kind) {
      case 'skills':
        await scanSkillsRoot(ctx, { flatFiles: false, baseWarnings: [] });
        break;
      case 'agents':
        await scanMarkdownDirectory(ctx, {
          kind: 'agent',
          noun: 'agenci',
          warnWithoutFrontmatter: true,
        });
        break;
      case 'commands':
        await scanGeminiCommands(ctx);
        break;
      case 'global-instructions':
        await scanInstructionFile(ctx, 'GEMINI.md', 'gemini-md');
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

/** Z `settings.json` czytamy wylacznie klucz `hooks`; reszta (mcpServers z env i naglowkami) moze trzymac sekrety. */
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
  // `timeout` w Gemini CLI jest w milisekundach, model trzyma sekundy.
  addHookCandidates(ctx, parsed['hooks'], {
    file,
    warnings: [],
    rootUnmapped: [],
    timeoutPerSecond: 1000,
  });
}

export function createGeminiCliAdapter(): ToolAdapter {
  return new GeminiCliAdapter();
}
