import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import { Checker, childPath, field, isPlainObject, type PlainObject } from './check';
import { fail, ok, type Result } from './errors';
import { API_VERSION, ID_SPACE_PATTERN } from './kinds';
import { HASH64 } from './patterns';
import type { PluginExecutables } from './plugin-scan';
import type { Resource } from './resource';
import { hasForbiddenKey } from './safe-keys';

/** Zmiana wersji dokumentu skrotu uniewaznia wszystkie zatwierdzenia (APR-02). */
export const APPROVAL_DOC_VERSION = 1;
export const APPROVAL_DOMAIN = 'cwm-approval-v1\n';
export const APPROVAL_ENGINE = 'claude-code';

export type ApprovalKind =
  'mcp' | 'plugin' | 'settings' | 'skill' | 'agent' | 'command' | 'files' | 'project' | 'company';

export interface ApprovalDocumentInput {
  readonly company: string;
  readonly kind: ApprovalKind;
  readonly id: string;
  readonly fields: unknown;
}

/**
 * Skrot zatwierdzenia (APR-02): SHA-256 z przedrostkiem domeny i kanonicznego dokumentu
 * `{v, engine, company, kind, id, fields}`. Wersja zasobu nie wchodzi do skrotu.
 */
export function approvalHash(input: ApprovalDocumentInput): string {
  const document = {
    v: APPROVAL_DOC_VERSION,
    engine: APPROVAL_ENGINE,
    company: input.company,
    kind: input.kind,
    id: input.id,
    fields: input.fields,
  };
  return createHash('sha256')
    .update(APPROVAL_DOMAIN, 'utf8')
    .update(canonicalJson(document), 'utf8')
    .digest('hex');
}

export const approvalKey = (kind: ApprovalKind, id: string): string => `${kind}:${id}`;

/**
 * Para projekt-firma (APR-09). Klucz to skrot sciezki projektu po `realpath` (SEC-09): sciezka z
 * dysku moze miec dowolne znaki i dowolna dlugosc, a w kluczu musi miescic sie w limitach odczytu.
 * Sama sciezka jest w polach zatwierdzenia.
 */
export const projectApprovalKey = (realPath: string): string =>
  approvalKey('project', createHash('sha256').update(realPath, 'utf8').digest('hex'));

export const companyApprovalKey = (company: string): string => approvalKey('company', company);

/** Polecenie MCP z `/` jest sciezka do pliku, ktory trzeba przypiac (SEC-01); goly `npx` idzie przez PATH. */
export const mcpCommandIsPath = (command: string | undefined): boolean =>
  command !== undefined && command.includes('/');

export interface ApprovalSubject {
  readonly key: string;
  readonly kind: ApprovalKind;
  readonly id: string;
  readonly version: string | null;
  readonly hash: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

export function makeSubject(input: {
  /** Nadpisuje klucz `rodzaj:id` (para projekt-firma ma klucz ze skrotu sciezki). */
  readonly key?: string;
  readonly company: string;
  readonly kind: ApprovalKind;
  readonly id: string;
  readonly version: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly string[];
}): ApprovalSubject {
  return {
    key: input.key ?? approvalKey(input.kind, input.id),
    kind: input.kind,
    id: input.id,
    version: input.version,
    hash: approvalHash(input),
    fields: input.fields,
    warnings: input.warnings ?? [],
  };
}

/** Wynik przypiecia sciezki z polecenia hooka (IMP-08), przekazany z warstwy infra. */
export interface PinInfo {
  readonly raw: string;
  readonly sha256: string | null;
  /** Powod braku skrotu; null dla przypietej sciezki. */
  readonly unpinnedReason: string | null;
}

/** Fakty o tresci zasobu liczone z plikow zrodlowych, nie z flag w manifescie (APR-01). */
export interface ResourceFacts {
  readonly pins?: readonly PinInfo[];
  /** Skrot pliku `command` serwera MCP, gdy `command` jest sciezka (SEC-01: nigdy null dla sciezki). */
  readonly commandSha256?: string | null;
  /** Plik polecenia po `realpath` (dowiazanie rozwiniete) i katalog projektu, wzgledem ktorego go rozwiazano. */
  readonly commandPath?: string | null;
  readonly projectDir?: string;
  /** Skrot drzewa pluginu (APR-03), lista jego plikow i deklaracje wykonywalne (SEC-04). */
  readonly treeSha256?: string;
  readonly files?: readonly { readonly path: string; readonly sha256: string }[];
  readonly pluginExec?: PluginExecutables;
  /** Skrot tresci zrodla skilla, agenta lub komendy. */
  readonly sourceSha256?: string;
  readonly content?: {
    readonly allowedTools: boolean;
    /** Pelna wartosc `allowed-tools` (skill, komenda); dla agenta pusta, liczy sie `tools`. */
    readonly allowedToolsValue: readonly string[];
    readonly inlineCommands: boolean;
    /** Wstawki `!` w calosci: to polecenia wykonywane przy wczytaniu. */
    readonly inlineSnippets: readonly string[];
    readonly tools: readonly string[];
    readonly model: string | null;
  };
}

/** Czy zasob w ogole wymaga zatwierdzenia. Skill, agent i komenda tylko z cechami z IMP-05. */
export function needsApproval(resource: Resource, facts: ResourceFacts): boolean {
  switch (resource.kind) {
    case 'mcp':
    case 'plugin':
    case 'settings':
      return true;
    case 'skill':
    case 'agent':
    case 'command':
    case 'files': {
      const content = facts.content;
      return (
        content !== undefined &&
        (content.allowedTools || content.inlineCommands || content.tools.length > 0)
      );
    }
    case 'workflow':
      return false;
  }
}

/** Pola wykonawcze zasobu (APR-01). `null` dla rodzajow, ktore nie podlegaja zatwierdzeniu. */
export function executionFields(
  resource: Resource,
  facts: ResourceFacts,
): Record<string, unknown> | null {
  switch (resource.kind) {
    case 'mcp':
      return {
        transport: resource.transport,
        command: resource.command ?? null,
        args: [...resource.args],
        url: resource.url ?? null,
        env: Object.fromEntries(
          Object.entries(resource.env).map(([name, entry]) => [
            name,
            'envRef' in entry ? { envRef: entry.envRef } : { literal: true },
          ]),
        ),
        projectDir: facts.projectDir ?? null,
        commandPath: facts.commandPath ?? null,
        commandSha256: facts.commandSha256 ?? null,
      };
    case 'plugin':
      return {
        source: { ...resource.source },
        treeSha256: facts.treeSha256 ?? null,
        files: [...(facts.files ?? [])],
        hookCommands: [...(facts.pluginExec?.hookCommands ?? [])],
        hookOther: [...(facts.pluginExec?.hookOther ?? [])],
        mcpServers: facts.pluginExec?.mcpServers ?? {},
        lspServers: facts.pluginExec?.lspServers ?? {},
        manifestRefs: facts.pluginExec?.manifestRefs ?? {},
        unparsed: [...(facts.pluginExec?.unparsed ?? [])],
        pins: (facts.pins ?? []).map((pin) => ({ path: pin.raw, sha256: pin.sha256 })),
      };
    case 'settings':
      return {
        hooks: resource.hooks,
        permissions: resource.permissions,
        env: resource.env,
        enforce: resource.enforce,
        // Dodawane tylko gdy sa, zeby skrot zatwierdzonych Settings bez tych pol sie nie zmienil.
        ...(resource.attribution === undefined ? {} : { attribution: resource.attribution }),
        ...(resource.preferences === undefined ? {} : { preferences: resource.preferences }),
        pins: (facts.pins ?? []).map((pin) => ({ path: pin.raw, sha256: pin.sha256 })),
      };
    case 'skill':
    case 'agent':
    case 'command':
    case 'files': {
      if (!needsApproval(resource, facts)) return null;
      const content = facts.content;
      return {
        allowedTools: content?.allowedTools ?? false,
        allowedToolsValue: [...(content?.allowedToolsValue ?? [])],
        inlineCommands: content?.inlineCommands ?? false,
        inlineSnippets: [...(content?.inlineSnippets ?? [])],
        tools: [...(content?.tools ?? [])],
        model: content?.model ?? null,
        sourceSha256: facts.sourceSha256 ?? null,
      };
    }
    case 'workflow':
      return null;
  }
}

const NPX_LIKE = new Set(['npx', 'uvx', 'bunx', 'pnpx']);

function isUnversionedPackage(spec: string): boolean {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return true;
  return spec.slice(at + 1) === 'latest';
}

/** Ostrzezenia bez blokady na ekranie zatwierdzania (APR-06). */
export function approvalWarnings(resource: Resource, facts: ResourceFacts): string[] {
  const warnings: string[] = [];
  if (resource.kind === 'mcp' && resource.command !== undefined) {
    const base = resource.command.split('/').pop() ?? '';
    const pkg = resource.args.find((arg) => !arg.startsWith('-'));
    if (NPX_LIKE.has(base) && pkg !== undefined && isUnversionedPackage(pkg)) {
      warnings.push(
        'pakiet uruchamiany bez przypietej wersji (npx/uvx/bunx, brak wersji lub @latest)',
      );
    }
  }
  if (resource.kind === 'plugin') {
    for (const pin of facts.pins ?? []) {
      if (pin.unpinnedReason !== null) {
        warnings.push(`${pin.raw}: ${pin.unpinnedReason}`);
      }
    }
    if ((facts.pluginExec?.unparsed.length ?? 0) > 0) {
      warnings.push(
        'deklaracje pluginu w nieczytelnym JSON: silnik moze je zinterpretowac inaczej',
      );
    }
  }
  if (resource.kind === 'settings') {
    if (resource.permissions.defaultMode === 'bypassPermissions') {
      warnings.push('defaultMode bypassPermissions wylacza pytania o uprawnienia');
    }
    if (resource.permissions.allow.some((rule) => rule.includes('*'))) {
      warnings.push('regula allow z gwiazdka daje szerokie uprawnienia');
    }
    if (resource.enforce && Object.keys(resource.hooks).length > 0) {
      warnings.push(
        'enforce z hookami ustawia disableAllHooks=false: wlacza tez hooki projektu, ktore projekt wylaczyl',
      );
    }
    for (const pin of facts.pins ?? []) {
      if (pin.unpinnedReason !== null) {
        warnings.push(`${pin.raw}: ${pin.unpinnedReason}`);
      }
    }
  }
  return warnings;
}

export interface FieldChange {
  readonly name: string;
  /** Dla pola `files` pluginu: zmienione pliki (dodany, usuniety, zmieniony), bez wartosci sekretow. */
  readonly detail?: readonly string[];
  /** Kanoniczny JSON poprzedniej wartosci; brak pola w poprzednim zatwierdzeniu to null. */
  readonly before: string | null;
  readonly after: string | null;
}

/** Roznice na poziomie pol wykonawczych: pelne wartosci, bez przycinania (APR-06). */
export function diffFields(
  previous: unknown,
  current: Readonly<Record<string, unknown>>,
): FieldChange[] {
  const before = isPlainObject(previous) ? previous : {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(current)])].sort();
  const changes: FieldChange[] = [];
  for (const name of names) {
    const a = Object.hasOwn(before, name) ? canonicalJson(before[name]) : null;
    const b = Object.hasOwn(current, name) ? canonicalJson(current[name]) : null;
    if (a === b) continue;
    const detail = name === 'files' ? fileChanges(before[name], current[name]) : null;
    changes.push({ name, before: a, after: b, ...(detail === null ? {} : { detail }) });
  }
  return changes;
}

function fileMap(value: unknown): Map<string, string> | null {
  if (!Array.isArray(value)) return null;
  const map = new Map<string, string>();
  for (const item of value as unknown[]) {
    if (!isPlainObject(item)) return null;
    const { path, sha256 } = item;
    if (typeof path !== 'string' || typeof sha256 !== 'string') return null;
    map.set(path, sha256);
  }
  return map;
}

function fileChanges(before: unknown, after: unknown): string[] | null {
  const a = fileMap(before);
  const b = fileMap(after);
  if (a === null || b === null) return null;
  const out: string[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    if (x === undefined) out.push(`dodany plik: ${path}`);
    else if (y === undefined) out.push(`usuniety plik: ${path}`);
    else if (x !== y) out.push(`zmieniony plik: ${path}`);
  }
  return out;
}

export interface ApprovalRecord {
  readonly key: string;
  readonly hash: string;
  readonly approvedAt: string;
  readonly version: string | null;
  /** Zatwierdzone pola, do pokazania roznicy przy zmianie. Bez wartosci sekretow (te nie wchodza do pol). */
  readonly fields: unknown;
}

export interface ApprovalsFile {
  readonly company: string;
  readonly entries: readonly ApprovalRecord[];
}

export type ApprovalStatus =
  | { readonly state: 'approved' }
  | { readonly state: 'new' }
  | { readonly state: 'changed'; readonly previous: ApprovalRecord };

export function statusOf(subject: ApprovalSubject, file: ApprovalsFile): ApprovalStatus {
  const record = file.entries.find((entry) => entry.key === subject.key);
  if (record === undefined) return { state: 'new' };
  return record.hash === subject.hash
    ? { state: 'approved' }
    : { state: 'changed', previous: record };
}

const KEY =
  /^(?:mcp|plugin|settings|skill|agent|command|files|project|company):[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,512}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_ENTRIES = 500;

/** Plik `~/.cwm/approvals/<firma>.yaml` jest danymi z dysku: ostry walidator, nieznane pole to blad (APR-05). */
export function validateApprovalsFile(input: unknown): Result<ApprovalsFile> {
  const c = new Checker();
  const root = c.object(
    input,
    '$',
    ['apiVersion', 'kind', 'company', 'entries'],
    ['apiVersion', 'kind', 'company'],
  );
  if (!root) return fail(c.errors);
  c.literal(field(root, 'apiVersion'), 'apiVersion', API_VERSION);
  c.literal(field(root, 'kind'), 'kind', 'Approvals');
  const company = c.string(field(root, 'company'), 'company', ID_SPACE_PATTERN, 'id firmy');
  const entries = c.list(
    field(root, 'entries'),
    'entries',
    (element, path): ApprovalRecord | null => {
      const obj: PlainObject | null = c.object(
        element,
        path,
        ['key', 'hash', 'approvedAt', 'version', 'fields'],
        ['key', 'hash', 'approvedAt', 'fields'],
      );
      if (!obj) return null;
      const key = c.string(field(obj, 'key'), childPath(path, 'key'), KEY, 'rodzaj:id');
      const hash = c.string(field(obj, 'hash'), childPath(path, 'hash'), HASH64, '64 znaki hex');
      const approvedAt = c.string(
        field(obj, 'approvedAt'),
        childPath(path, 'approvedAt'),
        TIMESTAMP,
        'czas UTC ISO 8601',
      );
      const versionValue = field(obj, 'version');
      const version =
        versionValue === undefined || versionValue === null
          ? null
          : c.string(versionValue, childPath(path, 'version'));
      const fields = field(obj, 'fields');
      if (!isPlainObject(fields) || hasForbiddenKey(fields)) {
        c.add(childPath(path, 'fields'), 'Oczekiwano obiektu bez zabronionych kluczy.');
        return null;
      }
      return key && hash && approvedAt ? { key, hash, approvedAt, version, fields } : null;
    },
    (entry) => entry.key,
  );
  if (entries.length > MAX_ENTRIES) c.add('entries', `Najwyzej ${MAX_ENTRIES} wpisow.`);
  return c.errors.length > 0 || company === null ? fail(c.errors) : ok({ company, entries });
}
