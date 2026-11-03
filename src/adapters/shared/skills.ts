import type { AssetInput } from '../../core/model/item';
import { isIgnoredPath } from '../../core/model/library-file-names';
import {
  MAX_ASSETS_PER_ITEM,
  MAX_ASSET_PATH_SEGMENTS,
  MAX_ITEM_BYTES,
  MAX_SNAPSHOT_FILES_PER_TOOL,
} from '../../core/model/library-limits';
import { SourceReadError } from '../../core/ports/source-reader';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import { checkAssetPath, normalizeAssetPath } from '../../core/services/library/validate';
import { buildMarkdownItem, type LoadedFile, type MarkdownItem } from './markdown-item';
import type { ScanContext } from './scan-context';
import { TextDecodeError, toParsableText } from './text';

export interface SkillScanOptions {
  /** Claude Code czyta takze plaskie `NAZWA.md` w katalogu skilli; Codex tylko `NAZWA/SKILL.md`. */
  readonly flatFiles: boolean;
  /** Ostrzezenia dopisywane do kazdego elementu z tego roota (np. root nieczytany przez narzedzie). */
  readonly baseWarnings: readonly ImportWarning[];
  readonly extraWarnings?: (item: MarkdownItem) => readonly ImportWarning[];
}

const SKILL_FILE = 'SKILL.md';
const MD_EXTENSION = /\.md$/i;

interface Pending {
  readonly rel: string;
  readonly readPath: string;
}

/** Skan katalogu skilli: skillem jest katalog ze `SKILL.md` (ARCHITECTURE 1.3), nic poza tym. */
export async function scanSkillsRoot(ctx: ScanContext, options: SkillScanOptions): Promise<void> {
  let entries;
  try {
    entries = await ctx.list('');
  } catch (error) {
    ctx.skipFromError(error, '');
    return;
  }
  for (const entry of entries) {
    if (isIgnoredPath(entry.name)) continue;
    try {
      switch (entry.type) {
        case 'directory':
          await scanSkillDirectory(ctx, options, entry.name, entry.name);
          break;
        case 'file':
          await scanFlatFile(ctx, options, entry.name, entry.name);
          break;
        case 'symlink': {
          const target = await ctx.follow(entry.name);
          if (target.outside) {
            ctx.skip(
              entry.name,
              'symlink-outside',
              `"${entry.name}" wskazuje poza wybrany katalog i nie jest śledzone.`,
            );
          } else if (target.type === 'directory') {
            await scanSkillDirectory(ctx, options, entry.name, target.relPath);
          } else if (target.type === 'file') {
            await scanFlatFile(ctx, options, entry.name, target.relPath);
          } else {
            ctx.skip(
              entry.name,
              'unsupported',
              `"${entry.name}" to dowiązanie do czegoś, co nie jest plikiem ani katalogiem.`,
            );
          }
          break;
        }
        default:
          ctx.skip(
            entry.name,
            'unsupported',
            `"${entry.name}" to plik specjalny i nie jest importowany.`,
          );
      }
    } catch (error) {
      ctx.skipFromError(error, entry.name);
    }
  }
}

async function scanFlatFile(
  ctx: ScanContext,
  options: SkillScanOptions,
  display: string,
  readPath: string,
): Promise<void> {
  if (!options.flatFiles || !MD_EXTENSION.test(display)) {
    ctx.skip(
      display,
      'not-an-element',
      options.flatFiles
        ? `"${display}" nie ma rozszerzenia .md, więc nie jest skillem.`
        : `"${display}" leży luzem w katalogu skilli. Codex czyta tylko katalogi ze SKILL.md.`,
    );
    return;
  }
  const bytes = await ctx.read(readPath);
  const mode = await ctx.mode(readPath);
  const text = decode(ctx, display, bytes);
  if (text === null) return;
  const file: LoadedFile = { relPath: display, bytes, mode };
  const item = buildMarkdownItem({
    tool: ctx.tool,
    kind: 'skill',
    sourceName: display.replace(MD_EXTENSION, ''),
    text,
    files: [file],
    assets: [],
    checkDeclaredName: true,
  });
  emit(ctx, options, display, item, [], ctx.aliasKey(readPath));
}

async function scanSkillDirectory(
  ctx: ScanContext,
  options: SkillScanOptions,
  display: string,
  physical: string,
): Promise<void> {
  const top = await ctx.list(physical);
  if (!top.some((e) => e.name === SKILL_FILE)) {
    ctx.skip(
      display,
      'not-an-element',
      `Katalog "${display}" nie ma pliku ${SKILL_FILE}, więc nie jest skillem.`,
    );
    return;
  }

  const pending: Pending[] = [];
  const notes: ImportWarning[] = [];
  await gather(ctx, display, physical, '', 0, pending, notes);

  if (pending.length > MAX_SNAPSHOT_FILES_PER_TOOL) {
    ctx.skip(
      display,
      'too-large',
      `Skill "${display}" ma ${pending.length} plików, a limit to ${MAX_SNAPSHOT_FILES_PER_TOOL}.`,
    );
    return;
  }
  const main = pending.find((p) => p.rel === SKILL_FILE);
  if (main === undefined) {
    ctx.skip(display, 'not-an-element', `${SKILL_FILE} w "${display}" nie jest zwykłym plikiem.`);
    return;
  }

  // Jeden nieczytelny plik wyklucza caly element: import bez niego gubilby dane po cichu.
  const files: LoadedFile[] = [];
  let total = 0;
  for (const p of pending) {
    const shown = `${display}/${p.rel}`;
    try {
      const bytes = await ctx.read(p.readPath);
      total += bytes.byteLength;
      files.push({ relPath: p.rel, bytes, mode: await ctx.mode(p.readPath) });
    } catch (error) {
      if (!(error instanceof SourceReadError)) throw error;
      ctx.skipFromError(error, shown);
      return;
    }
  }
  if (total > MAX_ITEM_BYTES) {
    ctx.skip(display, 'too-large', `Skill "${display}" zajmuje więcej niż limit elementu.`);
    return;
  }

  const mainFile = files.find((f) => f.relPath === SKILL_FILE);
  if (mainFile === undefined) return;
  const text = decode(ctx, `${display}/${SKILL_FILE}`, mainFile.bytes);
  if (text === null) return;

  const assets: AssetInput[] = [];
  for (const f of files) {
    if (f.relPath === SKILL_FILE) continue;
    const relPath = normalizeAssetPath(f.relPath);
    const problem = checkAssetPath(relPath);
    if (problem !== null) {
      notes.push({
        code: 'asset-not-importable',
        message: `Plik pomocniczy "${f.relPath}" pominięto jako asset: ${problem.message} Zostaje w zapisie źródła.`,
      });
      continue;
    }
    assets.push({ relPath, bytes: f.bytes });
  }
  if (assets.length > MAX_ASSETS_PER_ITEM) {
    ctx.skip(
      display,
      'too-large',
      `Skill "${display}" ma ${assets.length} plików pomocniczych, a limit to ${MAX_ASSETS_PER_ITEM}.`,
    );
    return;
  }

  // SKILL.md pierwszy w snapshocie, reszta w stalej kolejnosci.
  const ordered = [mainFile, ...files.filter((f) => f !== mainFile)];
  const item = buildMarkdownItem({
    tool: ctx.tool,
    kind: 'skill',
    sourceName: display,
    text,
    files: ordered,
    assets,
    checkDeclaredName: true,
  });
  emit(ctx, options, display, item, notes, ctx.aliasKey(main.readPath));
}

function emit(
  ctx: ScanContext,
  options: SkillScanOptions,
  relPath: string,
  item: MarkdownItem,
  notes: readonly ImportWarning[],
  aliasKey: string | null,
): void {
  ctx.add({
    relPath,
    kind: 'skill',
    draft: item.draft,
    warnings: [
      ...options.baseWarnings,
      ...item.warnings,
      ...notes,
      ...(options.extraWarnings?.(item) ?? []),
    ],
    aliasKey,
  });
}

function decode(ctx: ScanContext, shown: string, bytes: Uint8Array): string | null {
  try {
    return toParsableText(bytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    ctx.skip(shown, 'malformed', `Plik "${shown}" nie jest poprawnym tekstem UTF-8.`);
    return null;
  }
}

/**
 * Zbiera pliki skilla rekurencyjnie. Dowiazanie do pliku w obrebie roota jest czytane przez cel,
 * dowiazanie poza root albo do katalogu nie jest sledzone (kryterium 4), ale zostaje widoczne
 * zarowno jako `ImportSkip`, jak i jako ostrzezenie przy elemencie.
 */
async function gather(
  ctx: ScanContext,
  display: string,
  dir: string,
  prefix: string,
  depth: number,
  out: Pending[],
  notes: ImportWarning[],
): Promise<void> {
  const entries = await ctx.list(dir);
  for (const entry of entries) {
    if (isIgnoredPath(entry.name)) continue;
    const rel = `${prefix}${entry.name}`;
    const phys = `${dir}/${entry.name}`;
    const shown = `${display}/${rel}`;
    if (entry.type === 'file') {
      out.push({ rel, readPath: phys });
    } else if (entry.type === 'directory') {
      if (depth + 1 >= MAX_ASSET_PATH_SEGMENTS) {
        note(ctx, notes, shown, 'unsupported', 'zagnieżdżony zbyt głęboko');
      } else {
        await gather(ctx, display, phys, `${rel}/`, depth + 1, out, notes);
      }
    } else if (entry.type === 'symlink') {
      try {
        const target = await ctx.follow(phys);
        if (target.outside) {
          note(ctx, notes, shown, 'symlink-outside', 'dowiązanie wskazuje poza wybrany katalog');
        } else if (target.type === 'file') {
          out.push({ rel, readPath: target.relPath });
        } else {
          note(
            ctx,
            notes,
            shown,
            'unsupported',
            'dowiązanie do katalogu wewnątrz skilla nie jest śledzone',
          );
        }
      } catch (error) {
        if (!(error instanceof SourceReadError)) throw error;
        note(ctx, notes, shown, 'unreadable', 'nie udało się rozwiązać dowiązania');
      }
    } else {
      note(ctx, notes, shown, 'unsupported', 'plik specjalny');
    }
  }
}

function note(
  ctx: ScanContext,
  notes: ImportWarning[],
  shown: string,
  reason: 'unsupported' | 'symlink-outside' | 'unreadable',
  why: string,
): void {
  const message = `"${shown}" nie został zaimportowany: ${why}.`;
  ctx.skip(shown, reason, message);
  notes.push({ code: 'file-not-imported', message });
}
