/**
 * Element biblioteki w postaci utrwalanej (ARCHITECTURE 4.2, ADR 0023).
 *
 * `compatibility` i `syncState` celowo nie ma w tym typie: pierwsze wylicza adapter
 * (ARCHITECTURE 4.3), drugie nalezy do indeksu (ADR 0014). Widok laczacy je z elementem
 * powstanie tam, gdzie te dane sa dostepne, a nie w warstwie plikow.
 */

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** ULID, stabilne na zawsze (ADR 0023). Tworzone przez `IdGenerator`, sprawdzane przez `isItemId`. */
export type ItemId = Brand<string, 'ItemId'>;

/** Szesnastkowy SHA-256, 64 znaki, male litery. */
export type Sha256 = Brand<string, 'Sha256'>;

/** ISO 8601 w UTC. */
export type Timestamp = string;

/** Nieprzezroczysty identyfikator lokalizacji (renderer nigdy nie dostaje sciezki). */
export type RootId = string;

export const TOOL_IDS = ['claude-code', 'codex'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const ITEM_KINDS = [
  'skill',
  'agent',
  'command',
  'global-instruction',
  'project-instruction',
  'rule',
  'hook',
  'tool-setting',
  'reference-asset',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type LineEnding = 'lf' | 'crlf' | 'mixed';
export type DescriptionOrigin = 'source' | 'derived';
export type ReasoningDepth = 'routine' | 'deep' | 'deepest';
export type ItemScope = 'public' | 'private' | 'project';

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface HookDefinition {
  readonly event: string;
  readonly matcher: string | null;
  readonly command: string;
  readonly pathStyle: 'absolute' | 'home-relative';
  readonly timeoutSeconds: number | null;
}

export interface ToolSettingDefinition {
  readonly tool: ToolId;
  readonly key: string;
  readonly value: JsonValue;
}

/** Wynik klasyfikatora sekretow. Nigdy nie niesie wartosci sekretu, tylko miejsce. */
export interface SecretFinding {
  readonly rule: string;
  readonly relPath: string;
  readonly line: number | null;
}

/** Plik pomocniczy elementu. Bajty leza w `assets/<relPath>`, tu tylko ich opis. */
export interface Asset {
  /** Sciezka wzgledna z `/`, w NFC, po walidacji (ARCHITECTURE 12.5). */
  readonly relPath: string;
  /** Hash bajtow pliku, nie tresci znormalizowanej (ADR 0016). */
  readonly bytesHash: Sha256;
  readonly sizeBytes: number;
}

export interface SourceSnapshotFile {
  readonly relPath: string;
  /** Hash bajtow zrodla, pozwala odtworzyc oryginal. Nie mylic z `version.contentHash` (ADR 0016). */
  readonly bytesHash: Sha256;
  readonly mode: number | null;
  readonly lineEnding: LineEnding;
}

export interface SourceSnapshot {
  readonly tool: ToolId;
  readonly files: readonly SourceSnapshotFile[];
  readonly unmappedKeys: readonly { readonly path: string; readonly value: JsonValue }[];
}

export interface ImportOrigin {
  readonly tool: ToolId;
  readonly rootId: RootId;
  readonly path: string;
  readonly at: Timestamp;
}

export interface ItemIdentity {
  readonly slug: string;
  readonly declaredName: string | null;
  readonly aliases: readonly string[];
}

export interface ItemContent {
  readonly title: string;
  readonly description: string;
  readonly descriptionOrigin: DescriptionOrigin;
  /** Markdown, koniec linii wylacznie LF (ADR 0016). */
  readonly body: string;
}

export interface ItemAttributes {
  readonly reasoningDepth?: ReasoningDepth;
  readonly presentation?: { readonly accentColor?: string };
  readonly memoryScope?: string;
  readonly hook?: HookDefinition;
  readonly toolSetting?: ToolSettingDefinition;
}

export interface ItemVersion {
  /** Rosnie o 1 przy kazdym zapisie, zaczyna od 1. */
  readonly revision: number;
  /** SHA-256 `content.body` w postaci znormalizowanej do LF (ADR 0016). */
  readonly contentHash: Sha256;
  readonly updatedAt: Timestamp;
}

export interface LibraryItem {
  readonly id: ItemId;
  readonly kind: ItemKind;
  readonly identity: ItemIdentity;
  readonly content: ItemContent;
  readonly attributes: ItemAttributes;
  readonly assets: readonly Asset[];
  readonly source: {
    readonly snapshots: readonly SourceSnapshot[];
    /** `null` dla elementu utworzonego w aplikacji, a nie zaimportowanego. */
    readonly importedFrom: ImportOrigin | null;
  };
  readonly classification: {
    readonly scope: ItemScope;
    readonly secretFindings: readonly SecretFinding[];
  };
  readonly version: ItemVersion;
}

export interface AssetFile {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

export interface SnapshotFile {
  readonly tool: ToolId;
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/** Element razem z bajtami plikow, ktorych `LibraryItem` tylko dotyczy. */
export interface LoadedItem {
  readonly item: LibraryItem;
  readonly assets: readonly AssetFile[];
  readonly snapshotFiles: readonly SnapshotFile[];
}

/** Dane wejsciowe serwisu: bajty plikow bez hashy, hashe i wersje liczy serwis. */
export interface AssetInput {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

export interface SnapshotFileInput {
  readonly relPath: string;
  readonly bytes: Uint8Array;
  readonly mode: number | null;
}

export interface SnapshotInput {
  readonly tool: ToolId;
  readonly files: readonly SnapshotFileInput[];
  readonly unmappedKeys: SourceSnapshot['unmappedKeys'];
}

export interface ItemDraft {
  readonly kind: ItemKind;
  readonly identity: ItemIdentity;
  readonly content: ItemContent;
  readonly attributes?: ItemAttributes;
  /** Domyslnie `private`, czyli najwezszy zakres. */
  readonly classification?: LibraryItem['classification'];
  /** Przy `update` brak pola zachowuje dotychczasowe pliki pomocnicze. */
  readonly assets?: readonly AssetInput[];
  /** Przy `update` brak pola zachowuje dotychczasowe snapshoty zrodla. */
  readonly source?: {
    readonly snapshots: readonly SnapshotInput[];
    readonly importedFrom: ImportOrigin | null;
  };
}
