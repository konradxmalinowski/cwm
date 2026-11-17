import type { JsonValue, LibraryItem, LoadedItem } from '../../core/model/item';
import type { CompatibilityVerdict, WritePlan } from '../../core/model/plan';
import type { ExportContext } from '../../core/ports/tool-adapter';
import { renderCommandToml, renderMarkdown, type FrontmatterEdits } from '../shared/export/emit';
import { planHooks, planInstructions } from '../shared/export/file-plans';
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
import {
  foreignUnmapped,
  requiredFieldAdditions,
  unsupportedKind,
  verdict,
  worst,
} from '../shared/export/verdicts';
import type { YamlValue } from '../shared/frontmatter';
import { FILE_INJECTION, SHELL_INJECTION, parseCommandDraft } from './commands';

const TOOL = 'gemini-cli' as const;

/** Zdarzenia hookow z dokumentacji Gemini CLI (docs/hooks, 2026-11-17); inne sa pomijane przez narzedzie. */
export const GEMINI_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeModel',
  'AfterModel',
  'BeforeToolSelection',
  'BeforeTool',
  'AfterTool',
  'PreCompress',
  'Notification',
];

/** `timeout` hooka w settings.json Gemini CLI jest w milisekundach (docs/hooks/reference). */
const HOOK_TIMEOUT_PER_SECOND = 1000;

const FOREIGN =
  'Pola specyficzne dla innego narzędzia nie mają odpowiednika w Gemini CLI. Zostają w snapshocie źródła.';

/** Skladnia argumentow i powloki Claude Code, ktorej Gemini CLI nie rozumie (`{{args}}`, `!{...}`). */
const CLAUDE_ARGUMENTS = /\$ARGUMENTS|(^|[^\w$])\$[1-9]\b/;
const CLAUDE_SHELL = /!`[^`\n]+`/;

/** Werdykt dla konkretnego elementu (ARCHITECTURE 4.3, ADR 0055). Czysta funkcja, bez I/O. */
export function geminiCapabilities(item: LibraryItem): CompatibilityVerdict {
  switch (item.kind) {
    case 'skill': {
      const reasons: string[] = [];
      const lost = foreignUnmapped(item, TOOL, 'frontmatter.');
      const added = requiredFieldAdditions(item);
      let level = verdict('full').level;
      if (lost.length > 0) {
        level = worst(level, 'partial');
        reasons.push(FOREIGN);
      }
      const declared = item.identity.declaredName;
      if (declared !== null && declared !== item.identity.slug) {
        level = worst(level, 'partial');
        reasons.push(
          `Dokumentacja Gemini CLI zaleca, by name zgadzało się z nazwą katalogu. Katalog to "${item.identity.slug}", a name to "${declared}".`,
        );
      }
      if (added.length > 0) {
        level = worst(level, 'lossy');
        reasons.push(
          `Gemini CLI oczekuje frontmattera z polami name i description. Aplikacja dopisze: ${added.join(', ')}.`,
        );
      }
      return verdict(level, reasons, lost, added);
    }
    case 'command': {
      const reasons: string[] = [];
      const lost = foreignUnmapped(item, TOOL, 'frontmatter.');
      let level = verdict('full').level;
      if (lost.length > 0) {
        level = worst(level, 'partial');
        reasons.push(FOREIGN);
      }
      const body = item.content.body;
      if (CLAUDE_ARGUMENTS.test(body) || CLAUDE_SHELL.test(body)) {
        level = worst(level, 'lossy');
        lost.push('składnia argumentów i powłoki Claude Code');
        reasons.push(
          'Treść używa składni argumentów ($ARGUMENTS, $1) albo powłoki (!`...`) Claude Code. Gemini CLI zna {{args}} i !{...}, więc te fragmenty trafią do promptu bez zmian i nie zadziałają.',
        );
      }
      if (SHELL_INJECTION.test(body)) {
        level = worst(level, 'partial');
        reasons.push(
          'Prompt zawiera wstawkę powłoki !{...}, którą Gemini CLI wykona po potwierdzeniu w narzędziu. Traktuj ją jak kod do uruchomienia.',
        );
      }
      if (FILE_INJECTION.test(body)) {
        level = worst(level, 'partial');
        reasons.push(
          'Prompt zawiera wstawkę pliku @{...}, przez którą Gemini CLI wyśle treść wskazanych plików do modelu. Sprawdź, co komenda czyta.',
        );
      }
      return verdict(level, reasons, lost);
    }
    case 'agent': {
      const reasons: string[] = [];
      const lost: string[] = [];
      if (item.attributes.reasoningDepth !== undefined) lost.push('reasoningDepth');
      if (item.attributes.presentation?.accentColor !== undefined) lost.push('color');
      if (item.attributes.memoryScope !== undefined) lost.push('memory');
      lost.push(...foreignUnmapped(item, TOOL));
      if (lost.length > 0) {
        reasons.push(
          'Gemini CLI nie ma odpowiednika poziomu rozumowania, koloru ani pamięci agenta, a pole model przyjmuje nazwy modeli Gemini. Te pola zostają w snapshocie źródła.',
        );
      }
      const added = requiredFieldAdditions(item);
      if (added.length > 0) {
        reasons.push(
          `Plik agenta Gemini CLI wymaga pól name i description. Aplikacja dopisze: ${added.join(', ')}.`,
        );
      }
      const level = worst(
        lost.length === 0 ? 'full' : 'partial',
        added.length > 0 ? 'lossy' : 'full',
      );
      return verdict(level, reasons, lost, added);
    }
    case 'global-instruction':
      return verdict('partial', [
        'Zarządzany jest blok między znacznikami aplikacji w GEMINI.md, nie cały plik. Treść poza blokiem nie jest ani eksportowana, ani kontrolowana (ADR 0025). Gemini CLI wczyta ten plik tylko wtedy, gdy context.fileName w settings.json go nie wyklucza.',
      ]);
    case 'hook': {
      const reasons: string[] = [];
      const event = item.attributes.hook?.event;
      if (event !== undefined && !GEMINI_HOOK_EVENTS.includes(event)) {
        reasons.push(
          `Zdarzenie "${event}" nie jest na liście zdarzeń Gemini CLI (np. BeforeTool, AfterTool, SessionStart). Narzędzie go nie uruchomi.`,
        );
      }
      if ((item.attributes.hook?.matcher ?? null) !== null) {
        reasons.push(
          'W zdarzeniach narzędzi matcher Gemini CLI to wyrażenie regularne dopasowane do nazw jego narzędzi, które mogą się różnić od nazw w innym narzędziu.',
        );
      }
      return reasons.length === 0 ? verdict('full') : verdict('partial', reasons);
    }
    default:
      return unsupportedKind(item);
  }
}

function mainPath(loaded: LoadedItem): string | null {
  const snapshot = loaded.item.source.snapshots.find((s) => s.tool === TOOL);
  return snapshot?.files[0]?.relPath ?? null;
}

function baseOf(src: MarkdownSource | null): MarkdownSource['frontmatter'] | null {
  return src !== null && src.frontmatter.present ? src.frontmatter : null;
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
  return encode(
    withSourceEol(renderMarkdown(baseOf(src), edits, item.content.body), src?.bytes ?? null),
  );
}

function renderAgent(loaded: LoadedItem, src: MarkdownSource | null): Uint8Array {
  if (src !== null && sameSemantics(loaded, src.draft)) return src.bytes;
  const { item } = loaded;
  const edits = new Map<string, YamlValue | undefined>([
    ['name', item.identity.declaredName ?? item.identity.slug],
    ['description', item.content.description],
  ]);
  return encode(
    withSourceEol(renderMarkdown(baseOf(src), edits, item.content.body), src?.bytes ?? null),
  );
}

const KNOWN_TOML_KEYS = new Set(['prompt', 'description']);

function renderCommand(loaded: LoadedItem, path: string): Uint8Array {
  const { item } = loaded;
  const snapshot = item.source.snapshots.find((s) => s.tool === TOOL);
  const sourceFile = loaded.snapshotFiles.find((f) => f.tool === TOOL && f.relPath === path);
  if (sourceFile !== undefined) {
    const draft = parseCommandDraft(sourceFile.bytes, path.replace(/\.toml$/i, ''));
    if (draft !== null && sameSemantics(loaded, draft)) return sourceFile.bytes;
  }
  const extras: { key: string; value: JsonValue }[] = [];
  for (const u of snapshot?.unmappedKeys ?? []) {
    if (!u.path.startsWith('toml.')) continue;
    const key = u.path.slice('toml.'.length);
    if (!KNOWN_TOML_KEYS.has(key)) extras.push({ key, value: u.value });
  }
  const described =
    item.content.descriptionOrigin === 'source' && item.content.description.trim() !== '';
  return encode(
    renderCommandToml({
      description: described ? item.content.description : null,
      prompt: item.content.body,
      extras,
    }),
  );
}

export async function planGemini(
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
    const v = geminiCapabilities(item);
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
        const own = mainPath(loaded);
        const src =
          own === 'SKILL.md'
            ? loadMarkdownSource(loaded, { tool: TOOL, kind: 'skill', relPath: own })
            : null;
        await planSkillDirectory(
          b,
          ctx,
          await listingFor(choice.root),
          loaded,
          item.identity.slug,
          skillFiles(loaded, renderSkill(loaded, src), TOOL),
        );
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
        const file = `${item.identity.slug}.toml`;
        const notes: string[] = [];
        if (SHELL_INJECTION.test(item.content.body)) {
          notes.push(
            'Komenda zawiera wstawkę powłoki !{...}. Gemini CLI wykona ją po potwierdzeniu w narzędziu. To tylko ostrzeżenie: aplikacja nie blokuje zapisu, więc sprawdź treść przed zatwierdzeniem planu.',
          );
        }
        if (FILE_INJECTION.test(item.content.body)) {
          notes.push(
            'Komenda zawiera wstawkę pliku @{...}. Gemini CLI wyśle treść wskazanych plików do modelu. To tylko ostrzeżenie: sprawdź treść przed zatwierdzeniem planu.',
          );
        }
        await planWholeFile(b, ctx, choice.root, loaded, file, renderCommand(loaded, file), notes);
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
    { tool: TOOL, kind: 'global-instructions', fileName: 'GEMINI.md' },
    instructions,
  );
  await planHooks(
    b,
    ctx,
    {
      tool: TOOL,
      kind: 'hooks',
      fileName: 'settings.json',
      knownEvents: GEMINI_HOOK_EVENTS,
      timeoutPerSecond: HOOK_TIMEOUT_PER_SECOND,
      entryWarnings: [
        'Hook uruchamia polecenie z uprawnieniami użytkownika przy każdym zdarzeniu. To tylko ostrzeżenie: aplikacja nie blokuje zapisu, więc sprawdź polecenie przed zatwierdzeniem planu.',
      ],
    },
    hooks,
  );
  return b.build();
}
