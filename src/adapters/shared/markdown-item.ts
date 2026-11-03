import type {
  AssetInput,
  ItemAttributes,
  ItemDraft,
  ItemKind,
  JsonValue,
  SnapshotFileInput,
  ToolId,
} from '../../core/model/item';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import { slugDeclaredNameWarning } from '../../core/services/library/validate';
import { asText, parseFrontmatter, yamlToJson, type FrontmatterResult } from './frontmatter';
import { deriveDescription, deriveSlug, firstHeading } from './slug';

/** Plik elementu: bajty zrodla plus nazwa wzgledem elementu, pod ktora trafia do snapshotu. */
export interface LoadedFile {
  readonly relPath: string;
  readonly bytes: Uint8Array;
  readonly mode: number | null;
}

export interface MappedAttributes {
  readonly attributes: ItemAttributes;
  /** Klucze frontmattera, ktore model objal, wiec nie trafiaja do `unmappedKeys`. */
  readonly consumed: readonly string[];
  readonly warnings: readonly ImportWarning[];
}

export interface MarkdownItemInput {
  readonly tool: ToolId;
  readonly kind: ItemKind;
  /** Nazwa katalogu albo pliku bez `.md`: z niej powstaje slug. */
  readonly sourceName: string;
  readonly text: string;
  readonly files: readonly LoadedFile[];
  readonly assets: readonly AssetInput[];
  readonly mapAttributes?: (fm: FrontmatterResult) => MappedAttributes;
  /** Skill zna ADR 0026 (slug kontra `name`); agent i komenda nie sa kluczowane katalogiem. */
  readonly checkDeclaredName: boolean;
  /** Klucze, ktore adapter rozumie bez mapowania na atrybut (np. `description`). */
  readonly knownKeys?: readonly string[];
}

export interface MarkdownItem {
  readonly draft: ItemDraft;
  readonly warnings: readonly ImportWarning[];
  readonly frontmatter: FrontmatterResult;
}

/**
 * Wspolny szkielet elementu opartego na Markdownie z frontmatterem (skill, agent Claude'a,
 * komenda). Nic tu nie prostuje: slug i `name` moga sie rozjechac, opis moze byc wyliczony,
 * a nieznane klucze ida do `unmappedKeys` (ADR 0023, 0026).
 */
export function buildMarkdownItem(input: MarkdownItemInput): MarkdownItem {
  const fm = parseFrontmatter(input.text);
  const unclosed = fm.issues.some((i) => i.code === 'frontmatter-unclosed');
  const warnings: ImportWarning[] = fm.issues.map((i) => ({ code: i.code, message: i.message }));
  const unmapped: { path: string; value: JsonValue }[] = [];

  const consumed = new Set<string>(['name', 'description', ...(input.knownKeys ?? [])]);
  const mapped = input.mapAttributes?.(fm);
  for (const key of mapped?.consumed ?? []) consumed.add(key);
  warnings.push(...(mapped?.warnings ?? []));

  const rawName = fm.data.get('name');
  const declaredName = asText(rawName);
  const rawDescription = fm.data.get('description');
  const sourceDescription = asText(rawDescription);
  for (const [key, raw] of [
    ['name', rawName],
    ['description', rawDescription],
  ] as const) {
    // Pole znane, ale o niepasujacej postaci (liczba, lista): nie gubimy go po cichu.
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      unmapped.push({ path: `frontmatter.${key}`, value: yamlToJson(raw) });
      warnings.push({
        code: 'frontmatter-field-not-text',
        message: `Pole "${key}" we frontmatterze nie jest tekstem, więc nie zostało użyte.`,
      });
    }
  }

  const slug = deriveSlug(input.sourceName);
  const aliases = slug.changed ? [input.sourceName] : [];
  if (slug.changed) {
    warnings.push({
      code: 'slug-derived',
      message:
        `Nazwa "${input.sourceName}" nie nadaje się na bezpieczną nazwę elementu ` +
        `(litery ASCII, cyfry, - _ .). Użyto "${slug.slug}"; oryginał zostaje jako alias.`,
    });
  }
  const identity = { slug: slug.slug, declaredName, aliases };
  if (input.checkDeclaredName) {
    const mismatch = slugDeclaredNameWarning(identity);
    if (mismatch !== null) warnings.push(mismatch);
  }

  let description: string;
  let descriptionOrigin: 'source' | 'derived';
  if (sourceDescription !== null) {
    description = sourceDescription;
    descriptionOrigin = 'source';
  } else {
    description = deriveDescription(fm.body);
    descriptionOrigin = 'derived';
    warnings.push({
      code: 'description-derived',
      message:
        description === ''
          ? 'Źródło nie ma opisu, a z treści nie dało się go wyliczyć.'
          : 'Źródło nie ma opisu. Opis wyliczono z pierwszego akapitu treści.',
    });
  }

  for (const [key, value] of fm.data) {
    if (!consumed.has(key)) {
      unmapped.push({ path: `frontmatter.${key}`, value: yamlToJson(value) });
    }
  }
  for (const entry of fm.unsupported) {
    unmapped.push({ path: `frontmatter.${entry.key}`, value: entry.raw });
  }
  if (fm.unsupported.length > 0) {
    warnings.push({
      code: 'frontmatter-unsupported',
      message: `Frontmatter zawiera konstrukcje, których importer nie rozumie (${fm.unsupported
        .map((u) => u.key)
        .join(', ')}). Zapisano je w surowej postaci.`,
    });
  }

  const files: SnapshotFileInput[] = input.files.map((f) => ({
    relPath: f.relPath,
    bytes: f.bytes,
    mode: f.mode,
  }));

  const draft: ItemDraft = {
    kind: input.kind,
    identity,
    content: {
      // Przy niedomknietym frontmatterze nagłówek z treści bywa przypadkowy, wiec tytul daje nazwa zrodla.
      title:
        declaredName ?? (unclosed ? input.sourceName : (firstHeading(fm.body) ?? input.sourceName)),
      description,
      descriptionOrigin,
      body: fm.body,
    },
    ...(mapped !== undefined && Object.keys(mapped.attributes).length > 0
      ? { attributes: mapped.attributes }
      : {}),
    assets: input.assets,
    source: {
      snapshots: [{ tool: input.tool, files, unmappedKeys: unmapped }],
      // Czas i pochodzenie dopisuje serwis importu: adapter nie ma zegara.
      importedFrom: null,
    },
  };
  return { draft, warnings, frontmatter: fm };
}
