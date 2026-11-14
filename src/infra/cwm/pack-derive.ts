import {
  approvalWarnings,
  canonicalJson,
  executionFields,
  foldName,
  listFiles,
  mapStrings,
  memberKey,
  needsApproval,
  PACK_PROFILE_PLACEHOLDER,
  type HookGroup,
  type MemberFields,
  type PackBinding,
  type PackDep,
  type PackKind,
  type PackMemberFacts,
  type Resource,
  type ResourceFacts,
} from '../../core/cwm';
import { pinHookCommands, pinInfos } from './hook-pins';
import { parseContent, parseFilesMarkdown } from './import-source';
import { resourceFileName } from './layout';
import { createNativeRewriter } from './native-rewrite';
import { sha256Hex, treeSha256, type TreeFile } from './runtime-sources';

/** Rodzaje zasobow, ktore moga nalezec do pakietu. */
export type PackResource = Extract<
  Resource,
  { kind: 'skill' | 'agent' | 'command' | 'files' | 'settings' }
>;

export const isPackResource = (resource: Resource): resource is PackResource =>
  resource.kind === 'skill' ||
  resource.kind === 'agent' ||
  resource.kind === 'command' ||
  resource.kind === 'files' ||
  resource.kind === 'settings';

const stripDot = (p: string): string => (p.startsWith('./') ? p.slice(2) : p);
const nameOf = (id: string): string => id.slice(id.indexOf('/') + 1);

/**
 * Pliki zasobu, ktore `cwm start` czyta z rejestru (bez manifestu i `.DS_Store`): to one wchodza
 * do skrotu drzewa. Agent i komenda to jeden plik zrodlowy, `Files` nigdy nie ma bitu wykonywania
 * (tak samo jak w planie generowania).
 */
export function memberFiles(resource: PackResource, files: readonly TreeFile[]): TreeFile[] {
  const manifest = resourceFileName(resource.kind);
  const data = files.filter((f) => f.rel !== manifest && f.rel !== '.DS_Store');
  switch (resource.kind) {
    case 'skill':
      return data;
    case 'files':
      return data.map((f) => ({ ...f, executable: false }));
    case 'agent':
    case 'command':
      return data
        .filter((f) => f.rel === stripDot(resource.source))
        .map((f) => ({ ...f, executable: false }));
    case 'settings':
      return [];
  }
}

/** Fakty o tresci zasobu, od ktorych zalezy zatwierdzenie (te same pola, co w `ResourceFacts.content`). */
export type DerivedContent = NonNullable<ResourceFacts['content']>;

/** Podpis tresci do porownania wyprowadzenia z planem: ten sam ksztalt niezaleznie od rodzaju. */
export function contentSignature(content: DerivedContent | undefined): string {
  return canonicalJson({
    allowedTools: content?.allowedTools ?? false,
    allowedToolsValue: [...(content?.allowedToolsValue ?? [])],
    inlineCommands: content?.inlineCommands ?? false,
    inlineSnippets: [...(content?.inlineSnippets ?? [])],
    tools: [...(content?.tools ?? [])],
    model: content?.model ?? null,
    hooks: content?.hooks ?? {},
  });
}

/** Podpis tresci z planu sprowadzony do postaci ze znacznikiem profilu zamiast prawdziwej sciezki. */
export function normalizedSignature(
  content: DerivedContent | undefined,
  profileDir: string,
): string {
  const raw = JSON.parse(contentSignature(content)) as unknown;
  return canonicalJson(
    mapStrings(raw, (text) => text.split(profileDir).join(PACK_PROFILE_PLACEHOLDER)),
  );
}

export interface DerivedMember {
  readonly resource: PackResource;
  readonly facts: PackMemberFacts;
  /** Tresc po przepisaniu odwolan na znacznik profilu; null dla `Settings`. */
  readonly content: DerivedContent | null;
  /** Skrypty z polecen hookow lezace w profilu (`<profil>/<rel>`), do sprawdzenia przy starcie. */
  readonly profileRels: readonly string[];
}

export interface DeriveInput {
  readonly pack: string;
  readonly resource: PackResource;
  /** Wynik `memberFiles`: bajty z rejestru sprzed przepisywania odwolan. */
  readonly files: readonly TreeFile[];
  readonly homeDir: string;
}

function hookCommandsOf(hooks: Readonly<Record<string, readonly HookGroup[]>>): string[] {
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
}

/**
 * Wyprowadza z bajtow rejestru pola czlonka pakietu niezalezne od firmy i profilu (ADR 0044): skrot
 * definicji, skrot drzewa, pola wykonawcze liczone z tekstu z odwolaniami przepisanymi na znacznik
 * profilu oraz piny skryptow spoza profilu. Ta sama funkcja liczy zaufany skrot przy imporcie i
 * sprawdzany skrot przy `cwm start`, wiec zgoda obejmuje dokladnie to, co potem trafia do profilu.
 */
export async function deriveMember(input: DeriveInput): Promise<DerivedMember> {
  const { resource, files, homeDir } = input;
  const blockers: string[] = [];
  const rewriter = await createNativeRewriter(homeDir, PACK_PROFILE_PLACEHOLDER);
  const nativeDir = resource.kind === 'settings' ? undefined : resource.nativeDir;
  const name = nameOf(resource.id);
  let content: DerivedContent | null = null;
  let commands: string[] = [];

  switch (resource.kind) {
    case 'skill':
    case 'agent':
    case 'command': {
      const wanted = stripDot(resource.source);
      const main = files.find((f) => f.rel === wanted);
      if (main === undefined) {
        blockers.push(`brak pliku zrodlowego ${wanted}`);
        break;
      }
      const rewritten = rewriter.apply(main, nativeDir).file;
      const parsed = parseContent(resource.kind, rewritten.bytes, name);
      if (!parsed.ok) {
        blockers.push(`plik zrodlowy nie przechodzi analizy (${parsed.reason})`);
        break;
      }
      content = {
        allowedTools: parsed.flags.allowedTools,
        allowedToolsValue: parsed.allowedToolsValue,
        inlineCommands: parsed.flags.inlineCommands,
        inlineSnippets: parsed.inlineSnippets,
        tools: parsed.tools,
        model: parsed.model,
        hooks: parsed.hooks,
      };
      commands = hookCommandsOf(parsed.hooks);
      break;
    }
    case 'files': {
      const snippets: string[] = [];
      let inline = false;
      for (const file of files) {
        if (!foldName(file.rel).endsWith('.md')) continue;
        const parsed = parseFilesMarkdown(
          resource.root,
          rewriter.apply(file, nativeDir).file.bytes,
        );
        if (!parsed.ok) {
          blockers.push(`${file.rel}: ${parsed.reason}`);
          continue;
        }
        inline ||= parsed.flags.inlineCommands;
        snippets.push(...parsed.inlineSnippets);
      }
      content = {
        allowedTools: false,
        allowedToolsValue: [],
        inlineCommands: inline,
        inlineSnippets: snippets,
        tools: [],
        model: null,
      };
      break;
    }
    case 'settings':
      commands = hookCommandsOf(resource.hooks);
      break;
  }

  // Dosłowny znacznik profilu w tekscie czlonka udawalby sciezke profilu (F3): nie da sie go wyprowadzic.
  const marked =
    resource.kind === 'settings'
      ? canonicalJson(resource).includes(PACK_PROFILE_PLACEHOLDER)
      : files.some((f) => Buffer.from(f.bytes).includes(PACK_PROFILE_PLACEHOLDER));
  if (marked)
    blockers.push(`tekst zasobu zawiera zarezerwowany znacznik ${PACK_PROFILE_PLACEHOLDER}`);

  const pinned = await pinHookCommands(commands, homeDir);
  const infos = pinInfos(pinned.pins, pinned.dropped);
  const marker = `${PACK_PROFILE_PLACEHOLDER}/`;
  const profileRels = infos
    .filter((i) => i.raw.startsWith(marker))
    .map((i) => i.raw.slice(marker.length));
  const hostPins = infos.filter((i) => !i.raw.startsWith(marker));

  const tree = treeSha256(files);
  const resourceFacts: ResourceFacts = {
    ...(content === null ? {} : { content, sourceSha256: tree }),
    pins: hostPins,
  };
  const required = needsApproval(resource, resourceFacts);
  const exec = required ? executionFields(resource, resourceFacts) : null;
  const listing = listFiles(files.map((f) => ({ path: f.rel, sha256: sha256Hex(f.bytes) })));
  const fields: MemberFields = {
    // Definicja liczy sie zawsze: zmiana `root` albo `path` zasobu Files przenosi pliki w profilu.
    def: sha256Hex(canonicalJson(resource)),
    tree,
    files: listing.files,
    filesMore: listing.filesMore,
    exec,
    bindings: [],
  };
  const kind: PackKind = resource.kind;
  return {
    resource,
    content,
    profileRels,
    facts: {
      pack: input.pack,
      key: memberKey(kind, resource.id),
      kind,
      id: resource.id,
      fields,
      required,
      warnings: required ? approvalWarnings(resource, resourceFacts) : [],
      deps: [],
      blockers,
    },
  };
}

/**
 * Uzupelnia czlonka o zaleznosci i powiazania skryptow hookow z profilu. `ownerOf` zwraca klucz
 * zasobu, ktory zapisze plik profilu (null: nikt), `treeOf` skrot drzewa wlasciciela (null: nieznany).
 * Skrypt z drzewa samego czlonka nie wymaga powiazania: pokrywa go `tree`.
 */
export function bindMember(
  derived: DerivedMember,
  ownerOf: (rel: string) => string | null,
  treeOf: (key: string) => string | null,
): PackMemberFacts {
  const deps: PackDep[] = derived.profileRels.map((rel) => ({ rel, owner: ownerOf(rel) }));
  const bindings: PackBinding[] = deps
    .filter((dep) => dep.owner !== derived.facts.key)
    .map((dep) => ({
      rel: dep.rel,
      owner: dep.owner,
      ownerTree: dep.owner === null ? null : treeOf(dep.owner),
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { ...derived.facts, deps, fields: { ...derived.facts.fields, bindings } };
}
