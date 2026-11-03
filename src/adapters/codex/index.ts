import { SourceReadError, type SourceReader } from '../../core/ports/source-reader';
import type {
  DetectedRoot,
  ImportWarning,
  RootKind,
  ScanResult,
  ToolAdapter,
} from '../../core/ports/tool-adapter';
import type { JsonValue } from '../../core/model/item';
import { addHookCandidates, isRecord } from '../shared/hooks';
import { scanInstructionFile } from '../shared/instructions';
import type { MarkdownItem } from '../shared/markdown-item';
import { ScanContext, unsupportedRootKind } from '../shared/scan-context';
import { scanSkillsRoot } from '../shared/skills';
import { TextDecodeError, toParsableText } from '../shared/text';
import { readRegistry, reportRegistry, scanCodexAgents } from './agents';

const NAME = 'OpenAI Codex';

/** Adapter Codeksa w zakresie importu (Etap 3). `plan`, `apply` i `verify` dojda w Etapie 4. */
export class CodexAdapter implements ToolAdapter {
  readonly id = 'codex' as const;
  readonly displayName = NAME;
  readonly rootKinds: readonly RootKind[] = [
    'skills',
    'agents',
    'agent-registry',
    'global-instructions',
    'hooks',
  ];

  private agentFiles: ReadonlySet<string> | null = null;

  async scan(root: DetectedRoot, reader: SourceReader): Promise<ScanResult> {
    const ctx = new ScanContext(this.id, root, reader);
    if (!root.exists) return ctx.result();
    switch (root.kind) {
      case 'skills':
        await scanSkillsRoot(ctx, {
          flatFiles: false,
          baseWarnings: root.active ? [] : [INACTIVE_ROOT],
          extraWarnings: codexSkillWarnings,
        });
        break;
      case 'agents':
        this.agentFiles = await scanCodexAgents(ctx);
        break;
      case 'agent-registry': {
        // Root rejestru to sam config.toml. Pary z plikami agentow sprawdzamy tylko wtedy, gdy ten
        // sam adapter chwile wczesniej skanowal katalog agentow; pamiec jest jednorazowa.
        const registry = await readRegistry(ctx);
        if (registry !== null) reportRegistry(ctx, registry, this.agentFiles);
        this.agentFiles = null;
        break;
      }
      case 'global-instructions':
        await scanInstructionFile(ctx, 'AGENTS.md', 'agents-md');
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

const INACTIVE_ROOT: ImportWarning = {
  code: 'root-inactive',
  message: 'Codex nie czyta tego katalogu skilli, więc element nie działa w tym narzędziu.',
};

/** Codex wymaga frontmattera z `name` i `description`; Claude Code toleruje jego brak. */
function codexSkillWarnings(item: MarkdownItem): readonly ImportWarning[] {
  if (!item.frontmatter.present) {
    return [
      {
        code: 'codex-frontmatter-missing',
        message: 'SKILL.md nie ma frontmattera. Codex go wymaga, więc nie załaduje tego skilla.',
      },
    ];
  }
  const missing: string[] = [];
  if (item.draft.identity.declaredName === null) missing.push('name');
  if (item.draft.content.descriptionOrigin === 'derived') missing.push('description');
  return missing.length === 0
    ? []
    : [
        {
          code: 'codex-frontmatter-incomplete',
          message: `Frontmatter nie ma pól: ${missing.join(', ')}. Codex ich wymaga.`,
        },
      ];
}

async function scanHooks(ctx: ScanContext): Promise<void> {
  const file = 'hooks.json';
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

  // Klucz zdarzenia w korzeniu psuje parsowanie calego pliku w Codeksie (ARCHITECTURE 1.3, 12.3).
  const rootUnmapped: { path: string; value: JsonValue }[] = [];
  const stray: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'hooks') continue;
    if (key !== 'description' && (Array.isArray(value) || isRecord(value))) {
      stray.push(key);
      ctx.skip(
        `${file}#${key}`,
        'malformed',
        `Klucz "${key}" stoi w korzeniu "${file}", a powinien być w "hooks". Codex odrzuca wtedy cały plik i wszystkie hooki przestają działać bez komunikatu.`,
      );
    } else {
      rootUnmapped.push({ path: `root.${key}`, value: value as JsonValue });
    }
  }
  const warnings: ImportWarning[] =
    stray.length === 0
      ? []
      : [
          {
            code: 'hooks-file-invalid-in-codex',
            message: `"${file}" ma w korzeniu klucz zdarzenia (${stray.join(', ')}), więc Codex nie wczyta żadnego hooka z tego pliku.`,
          },
        ];
  if ('hooks' in parsed) addHookCandidates(ctx, parsed['hooks'], { file, warnings, rootUnmapped });
}

export function createCodexAdapter(): ToolAdapter {
  return new CodexAdapter();
}
