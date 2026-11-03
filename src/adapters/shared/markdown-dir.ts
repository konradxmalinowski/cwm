import type { ItemKind } from '../../core/model/item';
import { isIgnoredPath } from '../../core/model/library-file-names';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import {
  buildMarkdownItem,
  type LoadedFile,
  type MarkdownItem,
  type MappedAttributes,
} from './markdown-item';
import type { FrontmatterResult } from './frontmatter';
import type { ScanContext } from './scan-context';
import { TextDecodeError, toParsableText } from './text';

export interface MarkdownDirOptions {
  readonly kind: ItemKind;
  readonly noun: string;
  readonly mapAttributes?: (fm: FrontmatterResult) => MappedAttributes;
  /** Agent bez frontmattera jest poprawnym plikiem, ale narzedzie nie dostanie z niego nazwy ani opisu. */
  readonly warnWithoutFrontmatter: boolean;
}

const MD_EXTENSION = /\.md$/i;

/** Plaski katalog plikow `.md` (agenci i komendy Claude'a): jeden plik to jeden element. */
export async function scanMarkdownDirectory(
  ctx: ScanContext,
  options: MarkdownDirOptions,
): Promise<void> {
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
      let readPath = entry.name;
      if (entry.type === 'symlink') {
        const target = await ctx.follow(entry.name);
        if (target.outside) {
          ctx.skip(
            entry.name,
            'symlink-outside',
            `"${entry.name}" wskazuje poza wybrany katalog i nie jest śledzone.`,
          );
          continue;
        }
        if (target.type !== 'file') {
          ctx.skip(
            entry.name,
            'unsupported',
            `"${entry.name}" jest dowiązaniem do czegoś, co nie jest plikiem.`,
          );
          continue;
        }
        readPath = target.relPath;
      } else if (entry.type === 'directory') {
        ctx.skip(
          entry.name,
          'unsupported',
          `Podkatalog "${entry.name}" nie jest importowany: ${options.noun} to pojedyncze pliki .md.`,
        );
        continue;
      } else if (entry.type !== 'file') {
        ctx.skip(
          entry.name,
          'unsupported',
          `"${entry.name}" to plik specjalny i nie jest importowany.`,
        );
        continue;
      }
      if (!MD_EXTENSION.test(entry.name)) {
        ctx.skip(
          entry.name,
          'not-an-element',
          `"${entry.name}" nie ma rozszerzenia .md, więc nie jest elementem.`,
        );
        continue;
      }

      const bytes = await ctx.read(readPath);
      const mode = await ctx.mode(readPath);
      let text: string;
      try {
        text = toParsableText(bytes);
      } catch (error) {
        if (!(error instanceof TextDecodeError)) throw error;
        ctx.skip(entry.name, 'malformed', `Plik "${entry.name}" nie jest poprawnym tekstem UTF-8.`);
        continue;
      }
      const file: LoadedFile = { relPath: entry.name, bytes, mode };
      const item: MarkdownItem = buildMarkdownItem({
        tool: ctx.tool,
        kind: options.kind,
        sourceName: entry.name.replace(MD_EXTENSION, ''),
        text,
        files: [file],
        assets: [],
        checkDeclaredName: false,
        ...(options.mapAttributes !== undefined ? { mapAttributes: options.mapAttributes } : {}),
      });
      const warnings: ImportWarning[] = [...item.warnings];
      if (options.warnWithoutFrontmatter && !item.frontmatter.present) {
        warnings.push({
          code: 'frontmatter-missing',
          message: `Plik nie ma frontmattera, więc nie ma nazwy ani opisu zadeklarowanych przez autora.`,
        });
      }
      ctx.add({
        relPath: entry.name,
        kind: options.kind,
        draft: item.draft,
        warnings,
        aliasKey: ctx.aliasKey(readPath),
      });
    } catch (error) {
      ctx.skipFromError(error, entry.name);
    }
  }
}
