import type { ItemAttributes, ReasoningDepth } from '../../core/model/item';
import { SourceReadError, type SourceReader } from '../../core/ports/source-reader';
import type {
  DetectedRoot,
  RootKind,
  ScanResult,
  ToolAdapter,
} from '../../core/ports/tool-adapter';
import { asText, type FrontmatterResult } from '../shared/frontmatter';
import { addHookCandidates, isRecord } from '../shared/hooks';
import { scanInstructionFile } from '../shared/instructions';
import { scanMarkdownDirectory } from '../shared/markdown-dir';
import type { MappedAttributes } from '../shared/markdown-item';
import { ScanContext, unsupportedRootKind } from '../shared/scan-context';
import { scanSkillsRoot } from '../shared/skills';
import { TextDecodeError, toParsableText } from '../shared/text';

const NAME = 'Claude Code';

// Przyblizenie: model Claude'a to nie to samo co glebokosc rozumowania (ADR 0023).
// Wartosc spoza listy zostaje w `unmappedKeys`, a oryginal i tak jest w snapshocie.
const MODEL_DEPTH: Readonly<Record<string, ReasoningDepth>> = {
  haiku: 'routine',
  sonnet: 'deep',
  opus: 'deepest',
};

function mapAgentAttributes(fm: FrontmatterResult): MappedAttributes {
  const attributes: { -readonly [K in keyof ItemAttributes]: ItemAttributes[K] } = {};
  const consumed: string[] = [];
  const color = asText(fm.data.get('color'));
  if (color !== null) {
    attributes.presentation = { accentColor: color };
    consumed.push('color');
  }
  const memory = asText(fm.data.get('memory'));
  if (memory !== null) {
    attributes.memoryScope = memory;
    consumed.push('memory');
  }
  const model = asText(fm.data.get('model'));
  const depth = model === null ? undefined : MODEL_DEPTH[model.toLowerCase()];
  if (depth !== undefined) {
    attributes.reasoningDepth = depth;
    consumed.push('model');
  }
  return { attributes, consumed, warnings: [] };
}

/** Adapter Claude Code w zakresie importu (Etap 3). `plan`, `apply` i `verify` dojda w Etapie 4. */
export class ClaudeCodeAdapter implements ToolAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = NAME;
  readonly rootKinds: readonly RootKind[] = [
    'skills',
    'agents',
    'commands',
    'global-instructions',
    'hooks',
  ];

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
