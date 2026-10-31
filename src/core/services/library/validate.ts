import {
  ITEM_KINDS,
  TOOL_IDS,
  type Asset,
  type ImportOrigin,
  type ItemAttributes,
  type ItemContent,
  type ItemId,
  type ItemKind,
  type JsonValue,
  type LibraryItem,
  type LineEnding,
  type SecretFinding,
  type Sha256,
  type SourceSnapshot,
  type ToolId,
} from '../../model/item';
import {
  MAX_ASSETS_PER_ITEM,
  MAX_ASSET_PATH_LENGTH,
  MAX_ASSET_PATH_SEGMENTS,
  MAX_FILE_BYTES,
  MAX_ITEM_BYTES,
  MAX_ITEM_JSON_BYTES,
  MAX_SNAPSHOT_FILES_PER_TOOL,
} from '../../model/library-limits';
import { baseName, isAtomicTempName, isJunkFileName } from '../../model/library-file-names';
import {
  LibraryValidationError,
  issue,
  type LibraryWarning,
  type ValidationIssue,
  type ValidationReason,
} from '../../model/library-errors';

export const ITEM_FORMAT_VERSION = 1;

// --- slug (ADR 0017, 0026) ---

const SLUG_MAX_LENGTH = 64;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Nazwy zarezerwowane Windowsa licza sie takze z rozszerzeniem ("aux.txt") i ze spacjami
 * przed kropka. Cyfry w indeksie gornym (COM¹) sa zarezerwowane od Windows 10.
 */
const WINDOWS_RESERVED =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\..*)?$/i;

export function isWindowsReservedName(segment: string): boolean {
  return WINDOWS_RESERVED.test(segment);
}

/** Slug jest ASCII, bo `lower()` na Unicode zalezy od ustawien regionalnych, a NFD/NFC rozjezdza macOS. */
export function validateSlug(slug: unknown): ValidationIssue | null {
  if (typeof slug !== 'string' || slug.length === 0) {
    return issue('slug-invalid', 'Nazwa elementu nie może być pusta.', { field: 'identity.slug' });
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    return issue('slug-invalid', `Nazwa elementu może mieć najwyżej ${SLUG_MAX_LENGTH} znaków.`, {
      field: 'identity.slug',
    });
  }
  if (!SLUG_PATTERN.test(slug) || slug.endsWith('.')) {
    return issue(
      'slug-invalid',
      `Nazwa "${slug}" jest niedozwolona. Użyj liter ASCII, cyfr oraz znaków - _ . ` +
        `(zaczynając od litery lub cyfry, bez kropki na końcu), żeby nazwa działała na każdym systemie.`,
      { field: 'identity.slug' },
    );
  }
  if (isWindowsReservedName(slug)) {
    return issue(
      'slug-reserved',
      `Nazwa "${slug}" jest zarezerwowana przez Windows i nie może być nazwą pliku. Wybierz inną.`,
      { field: 'identity.slug' },
    );
  }
  return null;
}

export interface SlugEntry {
  readonly id: ItemId;
  readonly kind: ItemKind;
  readonly slug: string;
}

/** Klucz unikalnosci z ADR 0017: `lower(slug)` plus typ. `self` wylacza element z porownania (edycja). */
export function findSlugCollision(
  candidate: { readonly kind: ItemKind; readonly slug: string; readonly self?: ItemId },
  existing: readonly SlugEntry[],
): ValidationIssue | null {
  const key = candidate.slug.toLowerCase();
  const clash = existing.find(
    (entry) =>
      entry.id !== candidate.self &&
      entry.kind === candidate.kind &&
      entry.slug.toLowerCase() === key,
  );
  if (clash === undefined) return null;

  const message =
    clash.slug === candidate.slug
      ? `Element tego typu o nazwie "${clash.slug}" już istnieje. Wybierz inną nazwę.`
      : `Element tego typu o nazwie "${clash.slug}" już istnieje, a "${candidate.slug}" różni się od niego ` +
        `tylko wielkością liter. Na macOS i Windowsie to ta sama nazwa pliku. Wybierz inną nazwę.`;
  return issue('slug-collision', message, {
    field: 'identity.slug',
    conflictsWith: clash.id,
  });
}

/** Rozjechanie nazw jest poprawnym stanem w narzedziu zrodlowym, wiec tylko ostrzega (ADR 0026). */
export function slugDeclaredNameWarning(identity: {
  readonly slug: string;
  readonly declaredName: string | null;
}): LibraryWarning | null {
  if (identity.declaredName === null || identity.declaredName === identity.slug) return null;
  return {
    code: 'slug-differs-from-declared-name',
    message:
      `Nazwa elementu ("${identity.slug}") różni się od nazwy zadeklarowanej w pliku ` +
      `("${identity.declaredName}"). Claude Code użyje pierwszej, Codex drugiej.`,
  };
}

// --- sciezki assetow (ARCHITECTURE 12.5) ---

const SEGMENT_MAX_BYTES = 255;
// eslint-disable-next-line no-control-regex -- sprawdzamy dokladnie znaki sterujace
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;

/** NFC przed kontrola i zapisem: macOS oddaje nazwy w NFD, wiec ta sama nazwa wracalaby w dwoch postaciach. */
export function normalizeAssetPath(raw: string): string {
  return raw.normalize('NFC');
}

/** Sprawdza jedna sciezke juz w NFC. Zwraca pierwszy problem albo `null`. */
export function checkAssetPath(path: string): ValidationIssue | null {
  const at = { path };
  if (path.length === 0) {
    return issue('asset-path-empty', 'Ścieżka pliku pomocniczego nie może być pusta.', at);
  }
  if (path.length > MAX_ASSET_PATH_LENGTH) {
    return issue(
      'asset-path-too-long',
      `Ścieżka pliku pomocniczego może mieć najwyżej ${MAX_ASSET_PATH_LENGTH} znaków (dłuższe ścieżki nie otworzą się w narzędziach na Windowsie).`,
      at,
    );
  }
  if (path.split('/').length > MAX_ASSET_PATH_SEGMENTS) {
    return issue(
      'asset-path-too-long',
      `Ścieżka pliku pomocniczego może mieć najwyżej ${MAX_ASSET_PATH_SEGMENTS} poziomów katalogów.`,
      at,
    );
  }
  if (CONTROL_CHARS.test(path)) {
    return issue(
      'asset-path-control-char',
      'Ścieżka pliku pomocniczego zawiera znak sterujący (w tym NUL).',
      at,
    );
  }
  if (path.includes('\\')) {
    return issue(
      'asset-path-backslash',
      `Ścieżka "${path}" zawiera znak \\. Rozdzielaj katalogi znakiem /.`,
      at,
    );
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return issue(
      'asset-path-absolute',
      `Ścieżka "${path}" jest bezwzględna. Plik pomocniczy musi leżeć wewnątrz elementu.`,
      at,
    );
  }

  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      return issue(
        'asset-path-empty-segment',
        `Ścieżka "${path}" ma pustą część (podwójny lub końcowy ukośnik).`,
        at,
      );
    }
    if (segment === '.' || segment === '..') {
      return issue(
        'asset-path-traversal',
        `Ścieżka "${path}" wychodzi poza katalog elementu albo go nie wskazuje (. lub ..).`,
        at,
      );
    }
    if (new TextEncoder().encode(segment).length > SEGMENT_MAX_BYTES) {
      return issue(
        'asset-path-too-long',
        `Nazwa "${segment}" jest za długa dla systemu plików.`,
        at,
      );
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return issue(
        'asset-path-trailing-dot-or-space',
        `Nazwa "${segment}" kończy się kropką lub spacją. Windows usuwa ten znak po cichu.`,
        at,
      );
    }
    if (WINDOWS_FORBIDDEN.test(segment)) {
      return issue(
        'asset-path-forbidden-char',
        `Nazwa "${segment}" zawiera znak niedozwolony w Windows (< > : " | ? *).`,
        at,
      );
    }
    if (isWindowsReservedName(segment)) {
      return issue(
        'asset-path-reserved-name',
        `Nazwa "${segment}" jest zarezerwowana przez Windows, także z rozszerzeniem.`,
        at,
      );
    }
    if (isAtomicTempName(segment)) {
      return issue(
        'asset-path-temp-name',
        `Nazwa "${segment}" wygląda jak plik tymczasowy zapisu aplikacji i zostałaby pominięta przy odczycie. Zmień nazwę pliku.`,
        at,
      );
    }
  }
  if (isJunkFileName(baseName(path))) {
    return issue(
      'asset-path-junk-name',
      `Plik "${baseName(path)}" tworzy system przy otwieraniu folderu i nie jest treścią elementu.`,
      at,
    );
  }
  return null;
}

/** Klucz kolizji nazw na systemach nieczulych na wielkosc liter i na NFD/NFC (APFS, NTFS). */
export function collisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase().normalize('NFC');
}

/**
 * Sprawdza zbior sciezek jednego elementu: kazda z osobna, potem kolizje wielkosci liter
 * i plik-katalog. Zwraca sciezki w NFC w kolejnosci wejscia.
 */
export function validateAssetPaths(rawPaths: readonly string[]): {
  readonly paths: readonly string[];
  readonly issues: readonly ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const paths = rawPaths.map((raw) => normalizeAssetPath(typeof raw === 'string' ? raw : ''));

  paths.forEach((path, index) => {
    const raw = rawPaths[index];
    const problem =
      typeof raw === 'string'
        ? checkAssetPath(path)
        : issue('asset-path-empty', 'Ścieżka pliku pomocniczego musi być tekstem.');
    if (problem !== null) issues.push(problem);
  });
  if (issues.length > 0) return { paths, issues };

  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = collisionKey(path);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      issues.push(
        issue(
          'asset-path-collision',
          earlier === path
            ? `Plik "${path}" występuje dwa razy.`
            : `Pliki "${earlier}" i "${path}" różnią się tylko wielkością liter albo zapisem znaków ` +
                `diakrytycznych. Na macOS i Windowsie to jeden plik.`,
          { path, conflictsWith: earlier },
        ),
      );
    } else {
      seen.set(key, path);
    }
  }

  for (const path of paths) {
    const parts = collisionKey(path).split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      const file = seen.get(ancestor);
      if (file !== undefined) {
        issues.push(
          issue(
            'asset-path-file-dir-conflict',
            `"${file}" jest plikiem, a "${path}" wymaga, żeby był katalogiem.`,
            { path, conflictsWith: file },
          ),
        );
      }
    }
  }
  return { paths, issues };
}

// --- limity rozmiaru (SEC-005) ---

const MIB = 1024 * 1024;

export interface SizeCheckInput {
  readonly bodyBytes: number;
  /** Rozmiar zakodowanego `item.json`; brak przy sprawdzeniu przed zbudowaniem elementu. */
  readonly itemJsonBytes?: number;
  readonly assets: readonly { readonly relPath: string; readonly size: number }[];
  readonly snapshots: readonly {
    readonly tool: string;
    readonly files: readonly { readonly relPath: string; readonly size: number }[];
  }[];
}

/** Sprawdza liczby i rozmiary przed hashowaniem i zapisem. Zwraca wszystkie przekroczenia. */
export function checkSizeLimits(input: SizeCheckInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tooBig = (relPath: string, size: number): void => {
    if (size > MAX_FILE_BYTES) {
      issues.push(
        issue(
          'limit-exceeded',
          `Plik "${relPath}" ma ${(size / MIB).toFixed(1)} MiB, a limit to ${MAX_FILE_BYTES / MIB} MiB.`,
          { path: relPath },
        ),
      );
    }
  };

  if (input.assets.length > MAX_ASSETS_PER_ITEM) {
    issues.push(
      issue(
        'limit-exceeded',
        `Element ma ${input.assets.length} plików pomocniczych, a limit to ${MAX_ASSETS_PER_ITEM}.`,
        { field: 'assets' },
      ),
    );
  }
  tooBig('body.md', input.bodyBytes);
  if (input.itemJsonBytes !== undefined && input.itemJsonBytes > MAX_ITEM_JSON_BYTES) {
    issues.push(
      issue(
        'limit-exceeded',
        `Metadane elementu (item.json) zajmują ${(input.itemJsonBytes / MIB).toFixed(1)} MiB, a limit to ${MAX_ITEM_JSON_BYTES / MIB} MiB.`,
        { field: 'item.json' },
      ),
    );
  }
  // Suma liczona jak budzet odczytu w magazynie: item.json, body, assety i snapshoty.
  let total = input.bodyBytes + (input.itemJsonBytes ?? 0);
  for (const asset of input.assets) {
    tooBig(asset.relPath, asset.size);
    total += asset.size;
  }
  for (const snapshot of input.snapshots) {
    if (snapshot.files.length > MAX_SNAPSHOT_FILES_PER_TOOL) {
      issues.push(
        issue(
          'limit-exceeded',
          `Zapis źródła (${snapshot.tool}) ma ${snapshot.files.length} plików, a limit to ${MAX_SNAPSHOT_FILES_PER_TOOL}.`,
          { field: 'source.snapshots' },
        ),
      );
    }
    for (const file of snapshot.files) {
      tooBig(file.relPath, file.size);
      total += file.size;
    }
  }
  if (total > MAX_ITEM_BYTES) {
    issues.push(
      issue(
        'limit-exceeded',
        `Element zajmuje ${(total / MIB).toFixed(1)} MiB, a limit to ${MAX_ITEM_BYTES / MIB} MiB.`,
      ),
    );
  }
  return issues;
}

// --- niezaufany item.json (ADR 0014: pliki sa prawda, ale moga byc zepsute lub edytowane recznie) ---

export type ItemMeta = Omit<LibraryItem, 'content'> & {
  readonly content: Omit<ItemContent, 'body'>;
  /** Hash rekordu tej wersji w `ObjectStore`; `null` w elementach zapisanych bez wskaznika. */
  readonly versionRecordHash: Sha256 | null;
};

/** `draft` = obiekt zbudowany przez serwis, `disk` = wczytany z `item.json`. Rozni sie tylko kod bledu. */
export type ShapeContext = 'draft' | 'disk';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_JSON_DEPTH = 32;

class ShapeReader {
  constructor(private readonly context: ShapeContext) {}

  fail(path: string, expected: string, reason?: ValidationReason): never {
    const where =
      this.context === 'disk' ? 'Plik item.json jest uszkodzony' : 'Dane elementu są niepoprawne';
    throw new LibraryValidationError([
      issue(
        reason ?? (this.context === 'disk' ? 'item-shape-invalid' : 'field-invalid'),
        `${where}: pole "${path}" ${expected}.`,
        { field: path },
      ),
    ]);
  }

  object(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return this.fail(path, 'musi być obiektem');
    }
    return value as Record<string, unknown>;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string') return this.fail(path, 'musi być tekstem');
    return value;
  }

  nonEmptyString(value: unknown, path: string): string {
    const text = this.string(value, path);
    if (text.trim().length === 0) return this.fail(path, 'nie może być puste');
    return text;
  }

  stringOrNull(value: unknown, path: string): string | null {
    return value === null ? null : this.string(value, path);
  }

  int(value: unknown, path: string, min: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      return this.fail(path, `musi być liczbą całkowitą nie mniejszą niż ${min}`);
    }
    return value;
  }

  array(value: unknown, path: string): readonly unknown[] {
    if (!Array.isArray(value)) return this.fail(path, 'musi być listą');
    return value as unknown[];
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      return this.fail(path, `musi być jedną z wartości: ${allowed.join(', ')}`);
    }
    return value as T;
  }

  sha(value: unknown, path: string): Sha256 {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
      return this.fail(path, 'musi być skrótem SHA-256 (64 znaki szesnastkowe)');
    }
    return value as Sha256;
  }

  json(value: unknown, path: string, depth = 0): JsonValue {
    if (depth > MAX_JSON_DEPTH) return this.fail(path, 'jest zagnieżdżone zbyt głęboko');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : this.fail(path, 'musi być liczbą skończoną');
    }
    if (Array.isArray(value)) {
      return (value as unknown[]).map((entry, i) => this.json(entry, `${path}[${i}]`, depth + 1));
    }
    if (typeof value === 'object') {
      // fromEntries tworzy wlasne wlasciwosci, wiec klucz "__proto__" nie zmienia prototypu.
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.json(v, `${path}.${k}`, depth + 1)]),
      );
    }
    return this.fail(path, 'musi być wartością JSON');
  }

  paths(values: readonly string[], path: string): readonly string[] {
    const { paths, issues } = validateAssetPaths(values);
    const [first, ...rest] = issues;
    if (first !== undefined) throw new LibraryValidationError([first, ...rest]);
    for (const [i, p] of paths.entries()) {
      if (p !== values[i]) {
        this.fail(`${path}[${i}]`, 'musi być zapisane w postaci NFC');
      }
    }
    return paths;
  }
}

function readAttributes(r: ShapeReader, raw: unknown): ItemAttributes {
  const a = r.object(raw, 'attributes');
  const out: {
    -readonly [K in keyof ItemAttributes]: ItemAttributes[K];
  } = {};
  if (a['reasoningDepth'] !== undefined) {
    out.reasoningDepth = r.oneOf(
      a['reasoningDepth'],
      ['routine', 'deep', 'deepest'],
      'attributes.reasoningDepth',
    );
  }
  if (a['presentation'] !== undefined) {
    const p = r.object(a['presentation'], 'attributes.presentation');
    out.presentation =
      p['accentColor'] === undefined
        ? {}
        : { accentColor: r.string(p['accentColor'], 'attributes.presentation.accentColor') };
  }
  if (a['memoryScope'] !== undefined) {
    out.memoryScope = r.string(a['memoryScope'], 'attributes.memoryScope');
  }
  if (a['hook'] !== undefined) {
    const h = r.object(a['hook'], 'attributes.hook');
    out.hook = {
      event: r.nonEmptyString(h['event'], 'attributes.hook.event'),
      matcher: r.stringOrNull(h['matcher'], 'attributes.hook.matcher'),
      command: r.nonEmptyString(h['command'], 'attributes.hook.command'),
      pathStyle: r.oneOf(
        h['pathStyle'],
        ['absolute', 'home-relative'],
        'attributes.hook.pathStyle',
      ),
      timeoutSeconds:
        h['timeoutSeconds'] === null
          ? null
          : r.int(h['timeoutSeconds'], 'attributes.hook.timeoutSeconds', 1),
    };
  }
  if (a['toolSetting'] !== undefined) {
    const t = r.object(a['toolSetting'], 'attributes.toolSetting');
    out.toolSetting = {
      tool: r.oneOf(t['tool'], TOOL_IDS, 'attributes.toolSetting.tool'),
      key: r.nonEmptyString(t['key'], 'attributes.toolSetting.key'),
      value: r.json(t['value'], 'attributes.toolSetting.value'),
    };
  }
  return out;
}

function readSnapshots(r: ShapeReader, raw: unknown): readonly SourceSnapshot[] {
  const snapshots = r.array(raw, 'source.snapshots').map((entry, i): SourceSnapshot => {
    const at = `source.snapshots[${i}]`;
    const s = r.object(entry, at);
    const files = r.array(s['files'], `${at}.files`).map((file, j) => {
      const f = r.object(file, `${at}.files[${j}]`);
      const mode = f['mode'];
      return {
        relPath: r.string(f['relPath'], `${at}.files[${j}].relPath`),
        bytesHash: r.sha(f['bytesHash'], `${at}.files[${j}].bytesHash`),
        mode: mode === null ? null : r.int(mode, `${at}.files[${j}].mode`, 0),
        lineEnding: r.oneOf<LineEnding>(
          f['lineEnding'],
          ['lf', 'crlf', 'mixed'],
          `${at}.files[${j}].lineEnding`,
        ),
      };
    });
    r.paths(
      files.map((f) => f.relPath),
      `${at}.files`,
    );
    const unmappedKeys = r.array(s['unmappedKeys'], `${at}.unmappedKeys`).map((key, j) => {
      const k = r.object(key, `${at}.unmappedKeys[${j}]`);
      return {
        path: r.string(k['path'], `${at}.unmappedKeys[${j}].path`),
        value: r.json(k['value'], `${at}.unmappedKeys[${j}].value`),
      };
    });
    return { tool: r.oneOf<ToolId>(s['tool'], TOOL_IDS, `${at}.tool`), files, unmappedKeys };
  });
  const tools = snapshots.map((s) => s.tool);
  if (new Set(tools).size !== tools.length) {
    r.fail('source.snapshots', 'ma dwa snapshoty tego samego narzędzia');
  }
  return snapshots;
}

/**
 * Ksztalt i spojnosc `item.json`. Sluzy do odczytu z dysku i do sprawdzenia tego, co serwis
 * sam zaraz zapisze, wiec zapis nie wyprodukuje elementu, ktorego odczyt by odrzucil.
 */
export function parseItemMeta(raw: unknown, expectedId: string, context: ShapeContext): ItemMeta {
  const r = new ShapeReader(context);
  const root = r.object(raw, 'item');

  if (root['formatVersion'] !== ITEM_FORMAT_VERSION) {
    r.fail(
      'formatVersion',
      `ma wartość nieobsługiwaną przez tę wersję aplikacji (oczekiwano ${ITEM_FORMAT_VERSION})`,
      'unsupported-format',
    );
  }
  const id = r.string(root['id'], 'id');
  if (id !== expectedId) {
    r.fail('id', 'nie zgadza się z nazwą katalogu elementu', 'id-mismatch');
  }
  const kindValue = r.string(root['kind'], 'kind');
  if (!ITEM_KINDS.includes(kindValue as ItemKind)) {
    r.fail('kind', `ma nieznany typ elementu "${kindValue}"`, 'unknown-kind');
  }
  const kind = kindValue as ItemKind;

  const identity = r.object(root['identity'], 'identity');
  const slugProblem = validateSlug(identity['slug']);
  if (slugProblem !== null) throw new LibraryValidationError([slugProblem]);
  const aliases = r
    .array(identity['aliases'], 'identity.aliases')
    .map((alias, i) => r.string(alias, `identity.aliases[${i}]`));

  const content = r.object(root['content'], 'content');
  const assets = r.array(root['assets'], 'assets').map((entry, i): Asset => {
    const a = r.object(entry, `assets[${i}]`);
    return {
      relPath: r.string(a['relPath'], `assets[${i}].relPath`),
      bytesHash: r.sha(a['bytesHash'], `assets[${i}].bytesHash`),
      sizeBytes: r.int(a['sizeBytes'], `assets[${i}].sizeBytes`, 0),
    };
  });
  r.paths(
    assets.map((a) => a.relPath),
    'assets',
  );

  const source = r.object(root['source'], 'source');
  let importedFrom: ImportOrigin | null = null;
  if (source['importedFrom'] !== null) {
    const o = r.object(source['importedFrom'], 'source.importedFrom');
    importedFrom = {
      tool: r.oneOf(o['tool'], TOOL_IDS, 'source.importedFrom.tool'),
      rootId: r.string(o['rootId'], 'source.importedFrom.rootId'),
      path: r.string(o['path'], 'source.importedFrom.path'),
      at: r.string(o['at'], 'source.importedFrom.at'),
    };
  }

  const classification = r.object(root['classification'], 'classification');
  const secretFindings = r
    .array(classification['secretFindings'], 'classification.secretFindings')
    .map((entry, i): SecretFinding => {
      const f = r.object(entry, `classification.secretFindings[${i}]`);
      return {
        rule: r.string(f['rule'], `classification.secretFindings[${i}].rule`),
        relPath: r.string(f['relPath'], `classification.secretFindings[${i}].relPath`),
        line:
          f['line'] === null
            ? null
            : r.int(f['line'], `classification.secretFindings[${i}].line`, 1),
      };
    });

  const version = r.object(root['version'], 'version');
  const updatedAt = r.string(version['updatedAt'], 'version.updatedAt');
  if (Number.isNaN(Date.parse(updatedAt))) r.fail('version.updatedAt', 'musi być datą ISO 8601');

  return {
    id: id as ItemId,
    kind,
    identity: {
      slug: identity['slug'] as string,
      declaredName: r.stringOrNull(identity['declaredName'], 'identity.declaredName'),
      aliases,
    },
    content: {
      title: r.nonEmptyString(content['title'], 'content.title'),
      description: r.string(content['description'], 'content.description'),
      descriptionOrigin: r.oneOf(
        content['descriptionOrigin'],
        ['source', 'derived'],
        'content.descriptionOrigin',
      ),
    },
    attributes: readAttributes(r, root['attributes']),
    assets,
    source: { snapshots: readSnapshots(r, source['snapshots']), importedFrom },
    classification: {
      scope: r.oneOf(
        classification['scope'],
        ['public', 'private', 'project'],
        'classification.scope',
      ),
      secretFindings,
    },
    versionRecordHash:
      root['versionRecordHash'] === undefined
        ? null
        : r.sha(root['versionRecordHash'], 'versionRecordHash'),
    version: {
      revision: r.int(version['revision'], 'version.revision', 1),
      contentHash: r.sha(version['contentHash'], 'version.contentHash'),
      updatedAt,
    },
  };
}
