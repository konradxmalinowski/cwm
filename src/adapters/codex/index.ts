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
import type { ImportCandidate, RootScan } from '../../core/ports/tool-adapter';
import type { MarkdownItem } from '../shared/markdown-item';
import { ScanContext, unsupportedRootKind } from '../shared/scan-context';
import { scanSkillsRoot } from '../shared/skills';
import { TextDecodeError, toParsableText } from '../shared/text';
import { readRegistry, registeredFile, reportRegistry, scanCodexAgents } from './agents';

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
        await scanCodexAgents(ctx);
        break;
      case 'agent-registry':
        // Root rejestru to sam config.toml, a pary z agentami wylicza `finalize` po skanie rootow.
        break;
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

  /**
   * Paruje agentow z wpisami `[agents.<nazwa>]`, ktore leza w innym roocie niz pliki. Bez roota
   * agentow w skanie (albo bez rejestru) wyniki zostaja bez zmian, z ostrzezeniem o braku kontroli.
   */
  async finalize(scans: readonly RootScan[], reader: SourceReader): Promise<readonly ScanResult[]> {
    const registryScan = scans.find((s) => s.root.kind === 'agent-registry' && s.root.exists);
    const agentScans = scans.filter((s) => s.root.kind === 'agents' && s.root.exists);
    if (registryScan === undefined || agentScans.length === 0) return scans.map((s) => s.result);

    const ctx = new ScanContext(this.id, registryScan.root, reader);
    const registry = await readRegistry(ctx);
    if (registry === null) {
      return scans.map((s) => (s === registryScan ? merge(s.result, ctx.result()) : s.result));
    }
    const registered = new Map<string, (typeof registry.entries)[number]>();
    for (const e of registry.entries) {
      const file = registeredFile(e);
      if (file !== null && !registered.has(file)) registered.set(file, e);
    }
    const present = new Set<string>();
    for (const s of agentScans) {
      for (const c of s.result.candidates) present.add(c.relPath);
      for (const k of s.result.skipped) present.add(k.relPath);
    }
    reportRegistry(ctx, registry, present);

    return scans.map((s) => {
      if (s === registryScan) return merge(s.result, ctx.result());
      if (!agentScans.includes(s)) return s.result;
      return {
        candidates: s.result.candidates.map((c) => pairAgent(c, registered.get(c.relPath))),
        skipped: s.result.skipped,
      };
    });
  }
}

function merge(base: ScanResult, extra: ScanResult): ScanResult {
  return {
    candidates: [...base.candidates, ...extra.candidates],
    skipped: [...base.skipped, ...extra.skipped],
  };
}

function pairAgent(
  c: ImportCandidate,
  entry:
    | {
        readonly name: string;
        readonly extra: readonly { readonly key: string; readonly value: JsonValue }[];
      }
    | undefined,
): ImportCandidate {
  if (c.kind !== 'agent') return c;
  const warnings = c.warnings.filter((w) => w.code !== 'agent-registration-unchecked');
  if (entry === undefined) {
    return {
      ...c,
      warnings: [
        ...warnings,
        {
          code: 'agent-not-registered',
          message:
            'Plik agenta nie ma wpisu [agents.<nazwa>] w config.toml, więc Codex go nie załaduje.',
        },
      ],
    };
  }
  const snapshot = c.draft.source?.snapshots[0];
  if (c.draft.source === undefined || snapshot === undefined) return { ...c, warnings };
  const unmappedKeys = [
    ...snapshot.unmappedKeys,
    { path: 'registry.entry', value: entry.name },
    ...entry.extra.map((e) => ({ path: `registry.${e.key}`, value: e.value })),
  ];
  return {
    ...c,
    warnings,
    draft: {
      ...c.draft,
      source: {
        ...c.draft.source,
        snapshots: [{ ...snapshot, unmappedKeys }, ...c.draft.source.snapshots.slice(1)],
      },
    },
  };
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
