import type { LoadedItem, ToolId } from '../../../core/model/item';
import type { MaterializationMode } from '../../../core/model/plan';
import { SourceReadError } from '../../../core/ports/source-reader';
import type { DetectedRoot, ExportContext } from '../../../core/ports/tool-adapter';
import { checkAssetPath, normalizeAssetPath } from '../../../core/services/library/validate';
import {
  PlanBuilder,
  TargetReadError,
  bytesEqual,
  dirMatches,
  readDirState,
  readTarget,
} from './plan-support';

/** Plany plikow w calosci nalezacych do eksportu: plik pojedynczy i katalog skilla. */

export interface RootListing {
  readonly root: DetectedRoot;
  readonly entries: readonly { readonly name: string; readonly type: string }[];
}

export async function listRoot(ctx: ExportContext, root: DetectedRoot): Promise<RootListing> {
  try {
    return { root, entries: await ctx.reader.list(root.rootId, '') };
  } catch (error) {
    if (error instanceof SourceReadError && error.failure === 'not-found') {
      return { root, entries: [] };
    }
    throw error;
  }
}

export async function planWholeFile(
  b: PlanBuilder,
  ctx: ExportContext,
  root: DetectedRoot,
  loaded: LoadedItem,
  relPath: string,
  bytes: Uint8Array,
  warnings: readonly string[] = [],
): Promise<void> {
  let previous: Uint8Array | null;
  try {
    previous = await readTarget(ctx.reader, root.rootId, relPath);
  } catch (error) {
    if (!(error instanceof TargetReadError)) throw error;
    b.refuse(loaded.item, error.message);
    return;
  }
  b.entry({
    rootId: root.rootId,
    relPath,
    action: previous === null ? 'create' : bytesEqual(previous, bytes) ? 'unchanged' : 'modify',
    scope: 'whole-file',
    itemIds: [loaded.item.id],
    content: bytes,
    previous,
    warnings,
  });
}

/**
 * Katalog skilla: `SKILL.md` plus pliki pomocnicze jako wpis katalogowy. Przy dostepnych
 * dowiazaniach akcja to `link` (ADR 0015); wtedy to `WriteGate` rozstrzyga, czy dowiazanie juz
 * wskazuje wlasciwa kopie, bo adapter nie zna sciezki `userData`.
 */
export async function planSkillDirectory(
  b: PlanBuilder,
  ctx: ExportContext,
  listing: RootListing,
  loaded: LoadedItem,
  dirName: string,
  files: readonly { readonly relPath: string; readonly bytes: Uint8Array }[],
  warnings: readonly string[] = [],
): Promise<void> {
  const { root } = listing;
  let state;
  let previous: Uint8Array | null = null;
  try {
    state = await readDirState(ctx.reader, root.rootId, listing.entries, dirName);
    if (state.kind === 'directory') {
      previous = state.files.get('SKILL.md') ?? null;
    }
  } catch (error) {
    if (!(error instanceof SourceReadError)) throw error;
    if (error.failure !== 'permission-denied') {
      b.refuse(
        loaded.item,
        `Nie udało się odczytać stanu katalogu "${dirName}" (${error.failure}).`,
      );
      return;
    }
    // Nieczytelny plik w katalogu: wpis idzie do bramki, ktora go zablokuje (ADR 0028), zeby plan
    // pokazal blokade z powodem zamiast cichej odmowy.
    state = { kind: 'directory', files: new Map() };
  }
  if (state.kind === 'other') {
    b.refuse(
      loaded.item,
      `W miejscu docelowym leży "${dirName}", które nie jest katalogiem ani dowiązaniem. Aplikacja go nie zastąpi.`,
    );
    return;
  }
  const mode: MaterializationMode = ctx.materialization.directory;
  const linkMode = mode !== 'copy';
  let action: 'create' | 'modify' | 'link' | 'unchanged';
  const notes = [...warnings];
  if (state.kind === 'directory' && dirMatches(state.files, files)) {
    action = 'unchanged';
  } else {
    action = linkMode ? 'link' : state.kind === 'absent' ? 'create' : 'modify';
    if (state.kind === 'directory') {
      notes.push(overwriteNote(dirName, linkMode, state.files, files));
    }
  }
  b.entry({
    rootId: root.rootId,
    relPath: dirName,
    action,
    scope: 'whole-file',
    itemIds: [loaded.item.id],
    files,
    previous,
    materialization: action === 'unchanged' ? null : mode,
    warnings: notes,
  });
}

const MAX_LISTED = 10;

/** Ostrzezenie "nadpisze": zwykly katalog jest zastepowany, a pliki spoza nowej wersji znikaja. */
function overwriteNote(
  dirName: string,
  linkMode: boolean,
  existing: ReadonlyMap<string, Uint8Array>,
  wanted: readonly { readonly relPath: string }[],
): string {
  const keep = new Set(wanted.map((w) => w.relPath));
  const vanishing = [...existing.keys()].filter((p) => p !== '\0link' && !keep.has(p)).sort();
  const head = linkMode
    ? `Nadpisze istniejący katalog "${dirName}": zostanie zastąpiony dowiązaniem do kopii z biblioteki.`
    : `Nadpisze zawartość istniejącego katalogu "${dirName}".`;
  const tail = 'Cała jego poprzednia zawartość trafi do kopii zapasowej.';
  if (vanishing.length === 0) return `${head} ${tail}`;
  const shown = vanishing.slice(0, MAX_LISTED).join(', ');
  const rest = vanishing.length > MAX_LISTED ? ` i ${vanishing.length - MAX_LISTED} innych` : '';
  return `${head} ${tail} Znikną z katalogu pliki, których nie ma w nowej wersji: ${shown}${rest}.`;
}

/**
 * Pliki katalogu skilla: `SKILL.md`, pliki pomocnicze z biblioteki i pliki zrodla tego samego
 * narzedzia, ktorych nie dalo sie zaimportowac jako asset (zostaja w snapshocie, a bez nich
 * eksport co chwile widzialby roznice).
 */
export function skillFiles(
  loaded: LoadedItem,
  skillMd: Uint8Array,
  tool: ToolId,
): { relPath: string; bytes: Uint8Array }[] {
  const files = [{ relPath: 'SKILL.md', bytes: skillMd }];
  const seen = new Set(['SKILL.md']);
  for (const a of loaded.assets) {
    if (seen.has(a.relPath)) continue;
    seen.add(a.relPath);
    files.push({ relPath: a.relPath, bytes: a.bytes });
  }
  for (const f of loaded.snapshotFiles) {
    if (f.tool !== tool || seen.has(f.relPath)) continue;
    if (checkAssetPath(normalizeAssetPath(f.relPath)) === null) continue;
    seen.add(f.relPath);
    files.push({ relPath: f.relPath, bytes: f.bytes });
  }
  return files;
}
