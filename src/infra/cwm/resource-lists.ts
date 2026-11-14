import { parseDocument, isSeq, isScalar } from 'yaml';

import {
  RESOURCE_SET_KEYS,
  validateCompanyManifest,
  validateGlobalConfig,
  type ResourceKind,
} from '../../core/cwm';
import { companyManifestFile, type CwmLayout } from './layout';
import { readTextWithin } from './read';
import { homeScope, WriteDeniedError, writeScopedFile } from './writer';
import { parseManifestYaml } from './yaml-manifest';

/** Zasob do wyciecia z list: rodzaj i id (klucz `rodzaj:id` rozbity). */
export interface ResourceListRef {
  readonly kind: ResourceKind;
  readonly id: string;
}

/** Listy, w ktorych id zasobu moze wystapic: sciezka do sekwencji bez ostatniego segmentu (klucza rodzaju). */
const CONFIG_BLOCKS: readonly (readonly string[])[] = [
  ['resources', 'mandatory'],
  ['resources', 'optional'],
];
const COMPANY_BLOCKS: readonly (readonly string[])[] = [
  ['resources', 'enable'],
  ['resources', 'disableOptional'],
  ['exports'],
];

export interface ListEdit {
  /** Plik (`config.yaml` albo `<firma>/company.yaml`) i wyciete wpisy w postaci `blok.rodzaj: id`. */
  readonly file: string;
  readonly label: string;
  readonly removed: readonly string[];
}

/** Wycina id z list tekstu YAML, zachowujac reszte dokumentu (takze komentarze). Zwraca nowy tekst albo null. */
function cutFromDocument(
  text: string,
  blocks: readonly (readonly string[])[],
  refs: readonly ResourceListRef[],
): { readonly text: string; readonly removed: readonly string[] } | null {
  const doc = parseDocument(text, {
    schema: 'core',
    version: '1.2',
    merge: false,
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length > 0) return null;
  const removed: string[] = [];
  for (const block of blocks) {
    for (const ref of refs) {
      const seq = doc.getIn([...block, RESOURCE_SET_KEYS[ref.kind]], true);
      if (!isSeq(seq)) continue;
      for (let index = seq.items.length - 1; index >= 0; index -= 1) {
        const item = seq.items[index];
        if (isScalar(item) && item.value === ref.id) {
          seq.items.splice(index, 1);
          removed.push(`${block.join('.')}.${RESOURCE_SET_KEYS[ref.kind]}: ${ref.id}`);
        }
      }
    }
  }
  if (removed.length === 0) return { text, removed };
  return { text: doc.toString({ lineWidth: 0 }), removed };
}

type Validator = (value: unknown) => { readonly ok: boolean };

async function editFile(
  layout: CwmLayout,
  file: string,
  label: string,
  blocks: readonly (readonly string[])[],
  refs: readonly ResourceListRef[],
  validate: Validator,
): Promise<ListEdit | null> {
  const read = await readTextWithin(layout.home, file);
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new WriteDeniedError(`${label}: nie da sie odczytac (${read.message}).`);
  }
  const cut = cutFromDocument(read.text, blocks, refs);
  if (cut === null) throw new WriteDeniedError(`${label} nie jest poprawnym YAML.`);
  if (cut.removed.length === 0) return null;
  const parsed = parseManifestYaml(cut.text);
  if (!parsed.ok || !validate(parsed.value).ok) {
    throw new WriteDeniedError(`Zmieniony ${label} nie przechodzi walidacji; zapis odrzucony.`);
  }
  await writeScopedFile(homeScope(layout.home), file, cut.text);
  return { file, label, removed: cut.removed };
}

/**
 * Usuwa zasoby z `resources.mandatory/optional` w `config.yaml` oraz z `resources.enable`,
 * `resources.disableOptional` i `exports` w kazdym `company.yaml`. Edycja zachowuje komentarze
 * i reszte dokumentu (jak `editMarketplaces`), a wynik przechodzi ten sam walidator co odczyt.
 * Plik jest czytany tuz przed zapisem. Zwraca tylko pliki, w ktorych cos wycieto.
 */
export async function removeFromResourceLists(
  layout: CwmLayout,
  companyIds: readonly string[],
  refs: readonly ResourceListRef[],
): Promise<ListEdit[]> {
  if (refs.length === 0) return [];
  const edits: ListEdit[] = [];
  const config = await editFile(
    layout,
    layout.configFile,
    'config.yaml',
    CONFIG_BLOCKS,
    refs,
    validateGlobalConfig,
  );
  if (config !== null) edits.push(config);
  for (const company of companyIds) {
    const edit = await editFile(
      layout,
      companyManifestFile(layout, company),
      `companies/${company}/company.yaml`,
      COMPANY_BLOCKS,
      refs,
      validateCompanyManifest,
    );
    if (edit !== null) edits.push(edit);
  }
  return edits;
}
