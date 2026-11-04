import type { ItemDraft, LoadedItem, ToolId } from '../../../core/model/item';
import type { FrontmatterResult } from '../frontmatter';
import { buildMarkdownItem, type MappedAttributes } from '../markdown-item';
import { jsonEqual } from './json-key';
import { snapshotBytes } from './plan-support';
import { TextDecodeError, toParsableText } from '../text';
import type { ItemKind } from '../../../core/model/item';

/**
 * Wiernosc formatu (ARCHITECTURE 4, ADR 0023): gdy element ma snapshot zrodla z tego samego
 * narzedzia i semantyka sie nie zmienila, eksport odtwarza oryginalne bajty. Semantyke
 * porownujemy ponownym przejsciem przez importer, a nie hashami tresci.
 */

export interface MarkdownSource {
  readonly bytes: Uint8Array;
  readonly frontmatter: FrontmatterResult;
  readonly draft: ItemDraft;
}

export interface MarkdownSourceOptions {
  readonly tool: ToolId;
  readonly kind: ItemKind;
  readonly relPath: string;
  readonly mapAttributes?: (fm: FrontmatterResult) => MappedAttributes;
}

export function loadMarkdownSource(
  loaded: LoadedItem,
  options: MarkdownSourceOptions,
): MarkdownSource | null {
  const bytes = snapshotBytes(loaded, options.tool, options.relPath);
  if (bytes === undefined) return null;
  let text: string;
  try {
    text = toParsableText(bytes);
  } catch (error) {
    if (error instanceof TextDecodeError) return null;
    throw error;
  }
  const built = buildMarkdownItem({
    tool: options.tool,
    kind: options.kind,
    sourceName: loaded.item.identity.slug,
    text,
    files: [],
    assets: [],
    checkDeclaredName: false,
    ...(options.mapAttributes !== undefined ? { mapAttributes: options.mapAttributes } : {}),
  });
  return { bytes, frontmatter: built.frontmatter, draft: built.draft };
}

/** Czy element ma te same dane znaczeniowe co swoj snapshot (tresc, opis, nazwa, atrybuty). */
export function sameSemantics(loaded: LoadedItem, draft: ItemDraft): boolean {
  const { item } = loaded;
  return (
    item.content.body === draft.content.body &&
    item.content.description === draft.content.description &&
    item.content.descriptionOrigin === draft.content.descriptionOrigin &&
    item.identity.declaredName === draft.identity.declaredName &&
    jsonEqual(item.attributes, draft.attributes ?? {})
  );
}

/** Konce linii zrodla: CRLF zostaje CRLF, gdy przepisujemy zmieniony plik. */
export function withSourceEol(text: string, source: Uint8Array | null): string {
  if (source === null) return text;
  const sample = new TextDecoder().decode(source.subarray(0, 4096));
  const crlf = (sample.match(/\r\n/g) ?? []).length;
  const lf = (sample.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? text.replace(/\n/g, '\r\n') : text;
}
