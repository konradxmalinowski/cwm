import type {
  AssetFile,
  ItemAttributes,
  ItemId,
  LibraryItem,
  LoadedItem,
  Sha256,
  SnapshotFile,
} from '../../model/item';
import { LibraryValidationError, issue, validationError } from '../../model/library-errors';
import type { SalvageResult, StoredItemFiles } from '../../ports/library-store';
import { MAX_ITEM_JSON_BYTES } from '../../model/library-limits';
import { isIgnoredPath } from '../../model/library-file-names';
import { sha256Bytes, sha256Text } from '../normalization/hash';
import { normalizeToLf } from '../normalization/line-endings';
import { ITEM_FORMAT_VERSION, parseItemMeta, type ItemMeta } from './validate';

/**
 * Format `item.json`: wszystko z `LibraryItem` oprocz `content.body` (ten jest w `body.md`),
 * plus `formatVersion`. Klucze w stalej kolejnosci, zeby ten sam element dawal te same bajty.
 *
 * Wykrywanie przerwanego zapisu (ADR 0031): `item.json` jest zapisywany jako ostatni i niesie
 * hashe pozostalych plikow. Odczyt porownuje je z tym, co lezy na dysku, wiec mieszanka starych
 * i nowych plikow konczy sie `integrity-mismatch`, a nie elementem czytanym jako poprawny.
 * Reczna edycja `body.md` z zewnatrz wywola ten sam blad: pliki sa prawda, ale `item.json` ich pilnuje.
 */

function attributesToJson(a: ItemAttributes): ItemAttributes {
  return {
    ...(a.reasoningDepth === undefined ? {} : { reasoningDepth: a.reasoningDepth }),
    ...(a.presentation === undefined
      ? {}
      : {
          presentation:
            a.presentation.accentColor === undefined
              ? {}
              : { accentColor: a.presentation.accentColor },
        }),
    ...(a.memoryScope === undefined ? {} : { memoryScope: a.memoryScope }),
    ...(a.hook === undefined
      ? {}
      : {
          hook: {
            event: a.hook.event,
            matcher: a.hook.matcher,
            command: a.hook.command,
            pathStyle: a.hook.pathStyle,
            timeoutSeconds: a.hook.timeoutSeconds,
          },
        }),
    ...(a.toolSetting === undefined
      ? {}
      : {
          toolSetting: {
            tool: a.toolSetting.tool,
            key: a.toolSetting.key,
            value: a.toolSetting.value,
          },
        }),
  };
}

function metaObject(item: LibraryItem): object {
  return {
    formatVersion: ITEM_FORMAT_VERSION,
    id: item.id,
    kind: item.kind,
    identity: {
      slug: item.identity.slug,
      declaredName: item.identity.declaredName,
      aliases: item.identity.aliases,
    },
    content: {
      title: item.content.title,
      description: item.content.description,
      descriptionOrigin: item.content.descriptionOrigin,
    },
    attributes: attributesToJson(item.attributes),
    assets: item.assets.map((a) => ({
      relPath: a.relPath,
      bytesHash: a.bytesHash,
      sizeBytes: a.sizeBytes,
    })),
    source: {
      snapshots: item.source.snapshots.map((s) => ({
        tool: s.tool,
        files: s.files.map((f) => ({
          relPath: f.relPath,
          bytesHash: f.bytesHash,
          mode: f.mode,
          lineEnding: f.lineEnding,
        })),
        unmappedKeys: s.unmappedKeys.map((k) => ({ path: k.path, value: k.value })),
      })),
      importedFrom:
        item.source.importedFrom === null
          ? null
          : {
              tool: item.source.importedFrom.tool,
              rootId: item.source.importedFrom.rootId,
              path: item.source.importedFrom.path,
              at: item.source.importedFrom.at,
            },
    },
    classification: {
      scope: item.classification.scope,
      secretFindings: item.classification.secretFindings.map((f) => ({
        rule: f.rule,
        relPath: f.relPath,
        line: f.line,
      })),
    },
    version: {
      revision: item.version.revision,
      contentHash: item.version.contentHash,
      updatedAt: item.version.updatedAt,
    },
  };
}

/** `versionRecordHash` wskazuje rekord tej wersji w `ObjectStore`; to on umozliwia przywrocenie. */
export function encodeItemJson(
  item: LibraryItem,
  versionRecordHash: Sha256 = sha256Bytes(encodeVersionRecord(item)),
): string {
  return `${JSON.stringify({ ...metaObject(item), versionRecordHash }, null, 2)}\n`;
}

/**
 * Rekord wersji dla `ObjectStore`: caly element razem z trescia, wiec przywrocenie wersji
 * to odczyt jednego obiektu (ADR 0027). Bajty assetow i snapshotow leza w store osobno,
 * pod hashami z tego rekordu.
 */
export function encodeVersionRecord(item: LibraryItem): Uint8Array {
  const meta = metaObject(item) as { content: object };
  const record = { ...meta, content: { ...meta.content, body: item.content.body } };
  return new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
}

const malformed = (message: string): LibraryValidationError =>
  validationError('item-json-malformed', message);

/** Dekodowanie UTF-8 bez cichej podmiany na U+FFFD; `null`, gdy bajty nie sa poprawnym UTF-8. */
export function decodeUtf8(bytes: Uint8Array, keepBom = false): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: keepBom }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parsuje i waliduje sam `item.json` (bajty z dysku), bez sprawdzania innych plikow. */
export function decodeItemJson(bytes: Uint8Array, expectedId: string): ItemMeta {
  if (bytes.length > MAX_ITEM_JSON_BYTES) {
    throw malformed('Plik item.json jest za duży. Element nie może zostać wczytany.');
  }
  const text = decodeUtf8(bytes);
  if (text === null) throw malformed('Plik item.json nie jest poprawnym tekstem UTF-8.');
  return parseItemJsonText(text, expectedId);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw malformed('Plik item.json nie jest poprawnym JSON-em. Element nie może zostać wczytany.');
  }
}

function parseItemJsonText(text: string, expectedId: string): ItemMeta {
  return parseItemMeta(parseJsonText(text), expectedId, 'disk');
}

/** `ItemMeta` bez wskaznika na rekord wersji, z trescia; wskaznik jest sprawa pliku, nie modelu. */
export function metaToItem(meta: ItemMeta, body: string): LibraryItem {
  return {
    id: meta.id,
    kind: meta.kind,
    identity: meta.identity,
    content: { ...meta.content, body },
    attributes: meta.attributes,
    assets: meta.assets,
    source: meta.source,
    classification: meta.classification,
    version: meta.version,
  };
}

export interface FileMismatch {
  /** Sciezka wzgledem katalogu elementu, np. `body.md` albo `assets/refs/a.md`. */
  readonly path: string;
  readonly problem: 'hash-differs' | 'missing' | 'invalid-utf8';
}

export interface InspectedItem {
  readonly meta: ItemMeta;
  /** Body z dysku znormalizowane do LF (ADR 0016); `null`, gdy `body.md` nie jest poprawnym UTF-8. */
  readonly body: string | null;
  readonly mismatches: readonly FileMismatch[];
}

/** Waliduje `item.json` i wylicza, ktore pliki nie zgadzaja sie z jego hashami. Nie rzuca przy rozbieznosci. */
export function inspectStoredItem(files: StoredItemFiles, expectedId: string): InspectedItem {
  const meta = decodeItemJson(files.itemJson, expectedId);
  const mismatches: FileMismatch[] = [];
  const { assets, snapshots } = indexFiles(files);

  // Plik z CRLF (np. po checkoucie z autocrlf na Windowsie) czyta sie tak samo jak LF (ADR 0016).
  const decoded = decodeUtf8(files.body, true);
  const body = decoded === null ? null : normalizeToLf(decoded);
  if (body === null) {
    mismatches.push({ path: 'body.md', problem: 'invalid-utf8' });
  } else if (sha256Text(body) !== meta.version.contentHash) {
    mismatches.push({ path: 'body.md', problem: 'hash-differs' });
  }
  for (const asset of meta.assets) {
    const file = assets.get(asset.relPath);
    const path = `assets/${asset.relPath}`;
    if (file === undefined) mismatches.push({ path, problem: 'missing' });
    else if (sha256Bytes(file.bytes) !== asset.bytesHash) {
      mismatches.push({ path, problem: 'hash-differs' });
    }
  }
  for (const snapshot of meta.source.snapshots) {
    for (const entry of snapshot.files) {
      const file = snapshots.get(`${snapshot.tool}/${entry.relPath}`);
      const path = `snapshots/${snapshot.tool}/${entry.relPath}`;
      if (file === undefined) mismatches.push({ path, problem: 'missing' });
      else if (sha256Bytes(file.bytes) !== entry.bytesHash) {
        mismatches.push({ path, problem: 'hash-differs' });
      }
    }
  }
  return { meta, body, mismatches };
}

/** Mapy plikow po `relPath` (snapshoty po `tool/relPath`), zeby szukanie nie bylo O(n*m). */
function indexFiles(files: StoredItemFiles): {
  assets: Map<string, AssetFile>;
  snapshots: Map<string, SnapshotFile>;
} {
  return {
    assets: new Map(files.assets.map((f) => [f.relPath, f])),
    snapshots: new Map(files.snapshotFiles.map((f) => [`${f.tool}/${f.relPath}`, f])),
  };
}

function mismatchError(first: FileMismatch): LibraryValidationError {
  const what =
    first.problem === 'missing'
      ? `brak pliku ${first.path}`
      : first.problem === 'invalid-utf8'
        ? `${first.path} nie jest poprawnym tekstem UTF-8`
        : first.path;
  return new LibraryValidationError([
    issue(
      'integrity-mismatch',
      `Pliki elementu nie zgadzają się z item.json (${what}). Zapis mógł zostać przerwany ` +
        `albo plik został zmieniony poza aplikacją.`,
    ),
  ]);
}

/** Element z juz sprawdzonego `InspectedItem`: bez drugiego hashowania plikow. Wymaga braku niezgodnosci. */
export function loadedFromInspected(inspected: InspectedItem, files: StoredItemFiles): LoadedItem {
  const { meta, body } = inspected;
  const { assets: assetIndex, snapshots: snapshotIndex } = indexFiles(files);
  const assets: AssetFile[] = meta.assets.map((asset) => assetIndex.get(asset.relPath)!);
  const snapshotFiles: SnapshotFile[] = meta.source.snapshots.flatMap((snapshot) =>
    snapshot.files.map((entry) => snapshotIndex.get(`${snapshot.tool}/${entry.relPath}`)!),
  );
  return { item: metaToItem(meta, body ?? ''), assets, snapshotFiles };
}

/** Odczyt elementu z dysku: rzuca `integrity-mismatch`, gdy pliki nie sa tym, co opisuje `item.json`. */
export function decodeStoredItem(files: StoredItemFiles, expectedId: ItemId | string): LoadedItem {
  const inspected = inspectStoredItem(files, expectedId);
  const [first] = inspected.mismatches;
  if (first !== undefined) throw mismatchError(first);
  return loadedFromInspected(inspected, files);
}

/** Rekord wersji z `ObjectStore`: ten sam kontrakt co `item.json`, plus `content.body`. */
export function decodeVersionRecord(
  bytes: Uint8Array,
  expectedId: string,
): { readonly meta: ItemMeta; readonly body: string } {
  const text = decodeUtf8(bytes);
  if (text === null) throw malformed('Rekord wersji nie jest poprawnym tekstem UTF-8.');
  const raw = parseJsonText(text);
  const meta = parseItemMeta(raw, expectedId, 'disk');
  const rawBody = (raw as { content?: { body?: unknown } }).content?.body;
  const body = typeof rawBody === 'string' ? normalizeToLf(rawBody) : null;
  if (body === null || sha256Text(body) !== meta.version.contentHash) {
    throw mismatchError({ path: 'body.md', problem: 'hash-differs' });
  }
  return { meta, body };
}

/**
 * Manifest stanu, z ktorego da sie odczytac tylko czesc plikow: odczytane wpisy z hashami
 * oraz lista nieczytelnych. Zmiana w jednym i drugim przeterminowuje plan usuniecia.
 */
export function salvageManifest(
  result: SalvageResult,
  options: { includeJunk: boolean },
): Uint8Array {
  const byPath = (x: { relPath: string }, y: { relPath: string }): number =>
    x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0;
  const keep = (e: { relPath: string }): boolean =>
    options.includeJunk || !isIgnoredPath(e.relPath);
  return new TextEncoder().encode(
    JSON.stringify({
      salvaged: result.entries
        .filter(keep)
        .sort(byPath)
        .map((e) => ({ relPath: e.relPath, hash: sha256Bytes(e.bytes) })),
      unreadable: result.unreadable
        .filter(keep)
        .sort(byPath)
        .map((e) => ({ relPath: e.relPath, failure: e.failure })),
    }),
  );
}
