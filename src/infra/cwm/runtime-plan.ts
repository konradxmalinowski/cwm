import { join } from 'node:path';

import {
  approvalWarnings,
  buildMcpConfig,
  buildProfileSettings,
  buildRunSettings,
  canonicalJson,
  companyApprovalKey,
  cwmPluginName,
  executionFields,
  foldName,
  extractPluginExecutables,
  foreignEnvRefs,
  formatJson,
  makeSubject,
  mcpCommandIsPath,
  nativeDirPattern,
  mcpEnvRefs,
  needsApproval,
  projectApprovalKey,
  refKey,
  rewriteNativeConfigRefs,
  settingsEnvRefs,
  validateCleanupPath,
  type ApprovalSubject,
  type CompanyManifest,
  type EffectiveConfiguration,
  type McpServer,
  type PinInfo,
  type Resource,
  type ResourceFacts,
} from '../../core/cwm';
import { describeUnpinned, pinHookCommands } from './hook-pins';
import { parseContent, parseFilesMarkdown } from './import-source';
import { companyDir, resourceFileName, type CwmLayout } from './layout';
import { realpathLoose } from './paths';
import { readTextWithin } from './read';
import { runtimeCompanyDir } from './runtime-fs';
import {
  addDirsFromArgs,
  findShadowing,
  pinMcpCommand,
  readSourceFile,
  readTree,
  realInside,
  sha256Hex,
  treeSha256,
  type TreeFile,
} from './runtime-sources';
import type { Workspace } from './workspace';

export interface PlannedFile {
  /** Wzgledna wobec `runtime/<firma>`, separator `/`. */
  readonly rel: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
  readonly sha256: string;
}

export interface PlanInput {
  readonly layout: CwmLayout;
  readonly workspace: Workspace;
  readonly company: CompanyManifest;
  readonly effective: EffectiveConfiguration;
  /** Katalog projektu po `realpath`: ten sam ciag idzie do resolve i do `spawn` (SPN-04). */
  readonly projectDir: string;
  readonly projectStore: 'local' | 'home';
  readonly homeDir: string;
  readonly userArgs: readonly string[];
}

export interface PlanSummary {
  readonly profile: {
    skills: number;
    agents: number;
    commands: number;
    files: number;
    settings: boolean;
  };
  readonly plugin: { skills: number; agents: number; commands: number };
  readonly mcp: number;
  readonly pluginDirs: number;
  /** Odwolania do natywnego katalogu konfiguracji przepisane na sciezke profilu w kopiach zasobow. */
  readonly rewrittenReferences: number;
}

export interface RuntimePlan {
  readonly company: string;
  readonly projectDir: string;
  readonly projectHash: string;
  readonly baseDir: string;
  readonly configDir: string;
  readonly tmpDir: string;
  readonly files: readonly PlannedFile[];
  /** Skrot zawartosci `claude/`: dwie sesje firmy z roznym skrotem nie moga dzialac naraz (PRF-01). */
  readonly profileHash: string;
  /** Skrot plikow tego uruchomienia: `sessions/<projekt>/` oraz migawki pluginow (SEC-15). */
  readonly sessionHash: string;
  readonly settingsFile: string;
  readonly mcpConfigFile: string | null;
  readonly pluginDirs: readonly string[];
  /** Migawki pluginow `local` tego uruchomienia (`<slug>@<skrot>`). */
  readonly pluginSnapshots: readonly string[];
  readonly subjects: readonly ApprovalSubject[];
  readonly ownEnvRefs: readonly string[];
  readonly settingsEnvRefs: Readonly<Record<string, string>>;
  readonly otherCompanyRefs: readonly string[];
  /** Realpath pliku `runtime.claude.path` firmy, jesli ustawiony. */
  readonly configuredEnginePath: string | null;
  readonly summary: PlanSummary;
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const encoder = new TextEncoder();

export function planDigest(
  files: readonly Pick<PlannedFile, 'rel' | 'executable' | 'sha256'>[],
): string {
  const lines = [...files]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => `${f.rel}\0${f.executable ? 1 : 0}\0${f.sha256}\n`);
  return sha256Hex(lines.join(''));
}

const stripDot = (p: string): string => (p.startsWith('./') ? p.slice(2) : p);
const nameOf = (id: string): string => id.slice(id.indexOf('/') + 1);

const foldPath = (path: string): string => path.split('/').map(foldName).join('/');

/** Zbior zajetych nazw porownywanych jak sciezki w systemie plikow bez rozroznienia wielkosci liter. */
class TakenNames extends Set<string> {
  override has(value: string): boolean {
    return super.has(foldPath(value));
  }

  override add(value: string): this {
    return super.add(foldPath(value));
  }
}

class Collector {
  readonly files = new Map<string, PlannedFile>();
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly notes: string[] = [];

  /** Klucz bez rozroznienia wielkosci liter i w NFC: APFS i NTFS traktuja takie sciezki jak jedna. */
  add(rel: string, bytes: Uint8Array, executable = false): void {
    const key = foldPath(rel);
    if (this.files.has(key)) {
      this.errors.push(`Dwa zasoby zapisywalyby ten sam plik: ${rel}.`);
      return;
    }
    this.files.set(key, { rel, bytes, executable, sha256: sha256Hex(bytes) });
  }
}

interface FilesContentFacts {
  allowedTools: boolean;
  readonly allowedToolsValue: string[];
  inlineCommands: boolean;
  readonly inlineSnippets: string[];
  readonly tools: string[];
  readonly model: null;
}

type Parsed = Extract<ReturnType<typeof parseContent>, { ok: true }>;

function contentFacts(parsed: Parsed, sourceSha256: string): ResourceFacts {
  return {
    content: {
      allowedTools: parsed.flags.allowedTools,
      allowedToolsValue: parsed.allowedToolsValue,
      inlineCommands: parsed.flags.inlineCommands,
      inlineSnippets: parsed.inlineSnippets,
      tools: parsed.tools,
      model: parsed.model,
      hooks: parsed.hooks,
    },
    sourceSha256,
  };
}

function parseOrReport(
  kind: 'skill' | 'agent' | 'command',
  bytes: Uint8Array,
  label: string,
  out: Collector,
  resourceName?: string,
): Parsed | null {
  const parsed = parseContent(kind, bytes, resourceName);
  if (!parsed.ok) {
    out.errors.push(`${label}: ${parsed.reason}.`);
    return null;
  }
  return parsed;
}

function pinInfos(
  pins: Awaited<ReturnType<typeof pinHookCommands>>['pins'],
  dropped: number,
): PinInfo[] {
  const infos = pins.map((pin): PinInfo => ({
    raw: pin.token.raw,
    sha256: pin.status.state === 'pinned' ? pin.status.sha256 : null,
    unpinnedReason: pin.status.state === 'pinned' ? null : describeUnpinned(pin.status.reason),
  }));
  if (dropped > 0) {
    infos.push({
      raw: `(+${dropped} sciezek)`,
      sha256: null,
      unpinnedReason: 'ponad limit przypinania',
    });
  }
  return infos;
}

function hookCommands(resource: Resource): string[] {
  if (resource.kind !== 'settings') return [];
  return Object.values(resource.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
}

function refsOfResource(resource: Resource): string[] {
  if (resource.kind === 'mcp') return mcpEnvRefs([resource]);
  if (resource.kind !== 'settings') return [];
  return Object.values(resource.env).flatMap((entry) => ('envRef' in entry ? [entry.envRef] : []));
}

function slugOf(id: string): string {
  return (
    id
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 50) || 'plugin'
  );
}

/**
 * Plan generowania w pamieci (APR-04 krok 2): wszystkie bajty, ktore trafia na dysk, i skroty
 * zatwierdzen liczone z tych samych obiektow. Funkcja niczego nie zapisuje; plan nie czyta juz
 * rejestru ani zrodel po zatwierdzeniu.
 */
export async function buildRuntimePlan(input: PlanInput): Promise<RuntimePlan> {
  const { layout, workspace, company, effective, projectDir } = input;
  const companyId = company.metadata.id;
  const out = new Collector();
  const projectHash = sha256Hex(projectDir).slice(0, 16);
  const baseDir = await realpathLoose(runtimeCompanyDir(layout, companyId));
  const session = `sessions/${projectHash}`;
  const dirs = new Map<Resource, string>(
    workspace.registry.entries.map((entry) => [entry.resource, entry.dir]),
  );

  const subjects: ApprovalSubject[] = [];
  const subject = (resource: Resource, facts: ResourceFacts, key?: string): void => {
    const fields = executionFields(resource, facts);
    if (fields === null || !needsApproval(resource, facts)) return;
    subjects.push(
      makeSubject({
        ...(key === undefined ? {} : { key }),
        company: companyId,
        kind: resource.kind as
          'mcp' | 'plugin' | 'settings' | 'skill' | 'agent' | 'command' | 'files',
        id: resource.id,
        version: resource.version ?? null,
        fields,
        warnings: approvalWarnings(resource, facts),
      }),
    );
  };

  // Piny hookow licza sie po zebraniu calego planu: skrypt moze pochodzic z zasobu przetworzonego
  // pozniej, a zatwierdzenie ma obejmowac bajty, ktore plan zapisze, nie stara kopie z dysku.
  const pendingPins: Array<{
    resource: Resource;
    facts: ResourceFacts;
    commands: readonly string[];
    exclude?: (raw: string) => boolean;
  }> = [];

  const summary = {
    profile: { skills: 0, agents: 0, commands: 0, files: 0, settings: false },
    plugin: { skills: 0, agents: 0, commands: 0 },
    mcp: 0,
    pluginDirs: 0,
    rewrittenReferences: 0,
  };
  const pluginDirs: string[] = [];
  const pluginSnapshots: string[] = [];
  const mcpServers: McpServer[] = [];
  const commandPaths: Record<string, string> = {};
  const profileNames = { skills: [] as string[], agents: [] as string[], commands: [] as string[] };
  const taken = new TakenNames();
  /** Nazwa z frontmattera decyduje o tym, ktory agent odpowiada: dwa zasoby o tej samej nazwie to blad. */
  const agentNames = new Map<string, string>();
  const claimAgentName = (name: string | null, source: string, inPlugin: boolean): void => {
    if (name === null) return;
    const key = `${inPlugin ? 'plugin' : 'profile'}:${foldName(name)}`;
    const other = agentNames.get(key);
    if (other !== undefined) {
      out.errors.push(`Dwa zasoby definiuja agenta o nazwie "${name}": ${other} i ${source}.`);
    } else agentNames.set(key, source);
  };

  // Odwolania do natywnego `~/.claude` w kopiach: sesja czyta profil, nie prawdziwy katalog natywny.
  const nativeDir = join(input.homeDir, '.claude');
  const homeDirs = [nativeDir, await realpathLoose(nativeDir)];
  const patterns = new Map<string, RegExp>();
  const patternFor = (origin: string | undefined): RegExp => {
    const key = origin ?? '';
    let pattern = patterns.get(key);
    if (pattern === undefined) {
      pattern = nativeDirPattern(origin === undefined ? homeDirs : [...homeDirs, origin]);
      patterns.set(key, pattern);
    }
    return pattern;
  };
  const rewriter = {
    /**
     * Zmienione bajty i liczba odwolan (katalog domowy oraz katalog natywny zapisany w zasobie);
     * pliki wykonywalne i nietekstowe zostaja bez zmian.
     */
    apply(file: TreeFile, origin?: string): { file: TreeFile; count: number } {
      if (file.executable) return { file, count: 0 };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
      } catch {
        return { file, count: 0 };
      }
      if (text.includes('\0')) return { file, count: 0 };
      const result = rewriteNativeConfigRefs(text, patternFor(origin), join(baseDir, 'claude'));
      return result.count === 0
        ? { file, count: 0 }
        : { file: { ...file, bytes: encoder.encode(result.text) }, count: result.count };
    },
    note(label: string, count: number): void {
      if (count === 0) return;
      summary.rewrittenReferences += count;
      out.notes.push(
        `${label}: przepisano ${count} odwolan do natywnego katalogu konfiguracji na sciezke profilu.`,
      );
    },
  };

  for (const entry of effective.resources) {
    const resource = entry.resource;
    const label = resource.id;
    if (resource.kind === 'workflow') {
      out.notes.push(`${label}: workflow nie jest generowany do silnika w tym etapie.`);
      continue;
    }
    const inPlugin = entry.origin === 'mandatory';
    const base = inPlugin ? `${session}/plugin` : 'claude';
    const counters = inPlugin ? summary.plugin : summary.profile;
    const dir = dirs.get(resource);
    if (resource.kind !== 'settings' && resource.kind !== 'mcp' && dir === undefined) {
      out.errors.push(`${label}: brak katalogu zasobu w rejestrze.`);
      continue;
    }

    switch (resource.kind) {
      case 'skill': {
        if (dir === undefined) break;
        const name = nameOf(resource.id);
        const tree = await readTree(
          dir,
          (rel) => rel === resourceFileName('skill') || rel === '.DS_Store',
        );
        if (!tree.ok) {
          out.errors.push(`${label}: ${tree.message}.`);
          break;
        }
        const wanted = stripDot(resource.source);
        let rewritten = 0;
        const treeFiles = tree.files.map((f) => {
          const result = rewriter.apply(f, resource.nativeDir);
          rewritten += result.count;
          return result.file;
        });
        const main = treeFiles.find((f) => f.rel === wanted);
        if (main === undefined) {
          out.errors.push(`${label}: brak pliku zrodlowego ${wanted}.`);
          break;
        }
        const parsed = parseOrReport('skill', main.bytes, label, out, name);
        if (parsed === null) break;
        rewriter.note(label, rewritten);
        const finals: TreeFile[] = treeFiles
          .filter((f) => f.rel !== wanted)
          .concat({ rel: 'SKILL.md', bytes: parsed.content, executable: false });
        if (new Set(finals.map((f) => foldPath(f.rel))).size !== finals.length) {
          out.errors.push(`${label}: kolizja nazwy SKILL.md w drzewie skilla.`);
          break;
        }
        if (taken.has(`${base}/skills/${name}`)) {
          out.errors.push(`${label}: nazwa skilla "${name}" jest juz zajeta przez inny zasob.`);
          break;
        }
        taken.add(`${base}/skills/${name}`);
        for (const file of finals) {
          out.add(`${base}/skills/${name}/${file.rel}`, file.bytes, file.executable);
        }
        counters.skills += 1;
        if (!inPlugin) profileNames.skills.push(name);
        const skillFacts = contentFacts(parsed, treeSha256(finals));
        const skillCommands = Object.values(parsed.hooks).flatMap((groups) =>
          groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
        );
        if (skillCommands.length > 0) {
          pendingPins.push({ resource, facts: skillFacts, commands: skillCommands });
        } else subject(resource, skillFacts);
        break;
      }
      case 'agent':
      case 'command': {
        if (dir === undefined) break;
        const name = nameOf(resource.id);
        const folder = resource.kind === 'agent' ? 'agents' : 'commands';
        const bytes = await readSourceFile(dir, stripDot(resource.source));
        if (bytes === null) {
          out.errors.push(
            `${label}: brak pliku zrodlowego ${resource.source} albo jest niebezpieczny.`,
          );
          break;
        }
        const rewrittenSource = rewriter.apply(
          { rel: `${name}.md`, bytes, executable: false },
          resource.nativeDir,
        );
        const parsed = parseOrReport(resource.kind, rewrittenSource.file.bytes, label, out, name);
        if (parsed === null) break;
        rewriter.note(label, rewrittenSource.count);
        if (resource.kind === 'agent') claimAgentName(parsed.name, label, inPlugin);
        if (taken.has(`${base}/${folder}/${name}`)) {
          out.errors.push(`${label}: nazwa "${name}" jest juz zajeta przez inny zasob.`);
          break;
        }
        taken.add(`${base}/${folder}/${name}`);
        out.add(`${base}/${folder}/${name}.md`, parsed.content);
        if (resource.kind === 'agent') counters.agents += 1;
        else counters.commands += 1;
        if (!inPlugin) {
          (resource.kind === 'agent' ? profileNames.agents : profileNames.commands).push(name);
        }
        subject(resource, contentFacts(parsed, sha256Hex(parsed.content)));
        break;
      }
      case 'files': {
        if (dir === undefined) break;
        const tree = await readTree(
          dir,
          (rel) => rel === resourceFileName('files') || rel === '.DS_Store',
        );
        if (!tree.ok) {
          out.errors.push(`${label}: ${tree.message}.`);
          break;
        }
        const own = tree.files.filter(
          (f) => f.rel === resource.path || f.rel.startsWith(`${resource.path}/`),
        );
        if (own.length === 0 || own.length !== tree.files.length) {
          out.errors.push(
            `${label}: pliki zasobu musza lezec pod spec.path (${resource.path}) i nie moze ich brakowac.`,
          );
          break;
        }
        if (own.some((f) => foldName(f.rel.split('/').pop() ?? '') === 'skill.md')) {
          out.errors.push(`${label}: Files nie moze zawierac manifestu skilla (skill.md).`);
          break;
        }
        let rewritten = 0;
        const finals: TreeFile[] = [];
        const facts: FilesContentFacts = {
          allowedTools: false,
          allowedToolsValue: [],
          inlineCommands: false,
          inlineSnippets: [],
          tools: [],
          model: null,
        };
        let failed = false;
        for (const original of own) {
          // Files to dane: bez bitu wykonywania (0600).
          const file: TreeFile = { ...original, executable: false };
          const result = rewriter.apply(file, resource.nativeDir);
          rewritten += result.count;
          if (foldName(file.rel).endsWith('.md')) {
            // Plik .md w skills/ albo agents/ nigdy nie zachowuje surowego frontmattera: te same
            // reguly co Skill i Agent, tools/allowed-tools/model i hooks to odrzucenie.
            const parsed = parseFilesMarkdown(resource.root, result.file.bytes);
            if (!parsed.ok) {
              out.errors.push(`${label}/${file.rel}: ${parsed.reason}.`);
              failed = true;
              break;
            }
            facts.inlineCommands ||= parsed.flags.inlineCommands;
            facts.inlineSnippets.push(...parsed.inlineSnippets);
            if (resource.root === 'agents')
              claimAgentName(parsed.name, `${label}/${file.rel}`, false);
            finals.push({ ...result.file, bytes: parsed.content });
          } else finals.push(result.file);
        }
        if (failed) break;
        const dirs = new Set(
          finals.filter((f) => f.rel.includes('/')).map((f) => f.rel.split('/')[0] ?? ''),
        );
        if (resource.root === 'skills' && [...dirs].some((d) => taken.has(`claude/skills/${d}`))) {
          out.errors.push(
            `${label}: katalog w skills/ jest juz zajety przez skill albo inny zasob.`,
          );
          break;
        }
        if (resource.root === 'skills') for (const d of dirs) taken.add(`claude/skills/${d}`);
        rewriter.note(label, rewritten);
        // Dane, nie polecenia: takze zasob obowiazkowy trafia do profilu pod zwykla sciezka (bez przedrostka pluginu).
        for (const file of finals) {
          out.add(`claude/${resource.root}/${file.rel}`, file.bytes, false);
        }
        summary.profile.files += 1;
        subject(resource, { content: facts, sourceSha256: treeSha256(finals) });
        break;
      }
      case 'settings': {
        pendingPins.push({ resource, facts: {}, commands: hookCommands(resource) });
        break;
      }
      case 'mcp': {
        mcpServers.push(resource);
        // Zatwierdzenie jest per projekt tylko dla polecenia-sciezki (SEC-01); `npx`, `node` i inne
        // pliki z PATH nie zaleza od projektu, wiec ich zatwierdzenie nie ma skakac miedzy projektami.
        if (!mcpCommandIsPath(resource.command)) {
          subject(resource, {});
          break;
        }
        const pin = await pinMcpCommand(resource.command ?? '', projectDir);
        if (!pin.ok) {
          out.errors.push(`${label}: nie da sie przypiac polecenia MCP (${pin.reason}).`);
          break;
        }
        commandPaths[resource.id] = pin.path;
        subject(
          resource,
          { projectDir, commandSha256: pin.sha256, commandPath: pin.path },
          `mcp:${resource.id}@${projectHash}`,
        );
        break;
      }
      case 'plugin': {
        if (resource.source.type !== 'local') {
          out.errors.push(
            `${label}: pluginy ${resource.source.type} nie sa obslugiwane w cwm start (tylko local).`,
          );
          break;
        }
        const root = dir === undefined ? null : await realInside(dir, resource.source.path);
        const tree = root === null ? null : await readTree(root);
        if (tree === null || !tree.ok) {
          out.errors.push(
            `${label}: ${tree === null ? 'katalog pluginu nie istnieje albo wychodzi poza zasob' : tree.message}.`,
          );
          break;
        }
        const treeHash = treeSha256(tree.files);
        const slug = `${slugOf(resource.id)}@${treeHash.slice(0, 16)}`;
        for (const file of tree.files) {
          out.add(`plugins/${slug}/${file.rel}`, file.bytes, file.executable);
        }
        pluginDirs.push(join(baseDir, 'plugins', slug));
        pluginSnapshots.push(slug);
        summary.pluginDirs += 1;
        if (!tree.files.some((f) => f.rel === '.claude-plugin/plugin.json')) {
          out.warnings.push(`${label}: brak .claude-plugin/plugin.json w drzewie pluginu.`);
        }
        const exec = extractPluginExecutables(tree.files);
        for (const text of exec.errors) out.errors.push(`${label}: ${text}`);
        pendingPins.push({
          resource,
          facts: {
            treeSha256: treeHash,
            files: tree.files.map((f) => ({ path: f.rel, sha256: sha256Hex(f.bytes) })),
            pluginExec: exec,
          },
          commands: exec.hookCommands,
          // Sciezki pod ${CLAUDE_PLUGIN_ROOT} sa w drzewie, wiec obejmuje je lista plikow.
          exclude: (raw) => raw.includes('CLAUDE_PLUGIN_ROOT'),
        });
        break;
      }
    }
  }

  if (summary.rewrittenReferences > 0) {
    out.notes.push(
      `Razem przepisano ${summary.rewrittenReferences} odwolan do natywnego katalogu konfiguracji (hooki bez zmian).`,
    );
  }

  const hasPluginContent = Object.values(summary.plugin).some((count) => count > 0);
  if (hasPluginContent) {
    const manifest = {
      name: cwmPluginName(companyId),
      description: `Zasoby obowiazkowe firmy ${companyId} (CWM)`,
    };
    out.add(`${session}/plugin/.claude-plugin/plugin.json`, encoder.encode(formatJson(manifest)));
    pluginDirs.unshift(join(baseDir, session, 'plugin'));
  }

  const mcp = buildMcpConfig(companyId, mcpServers, commandPaths);
  out.errors.push(...mcp.errors);
  out.warnings.push(...mcp.warnings);
  summary.mcp = mcpServers.length;
  let mcpConfigFile: string | null = null;
  if (mcpServers.length > 0) {
    out.add(`${session}/mcp.json`, encoder.encode(formatJson(mcp.document)));
    mcpConfigFile = join(baseDir, session, 'mcp.json');
  }

  const profileSettings = buildProfileSettings(effective.settings.regular);
  if (profileSettings !== null) {
    out.add('claude/settings.json', encoder.encode(formatJson(profileSettings)));
    summary.profile.settings = true;
  }
  const runSettings = buildRunSettings(effective.settings.enforced, {
    isolation: company.runtime.isolation,
  });
  out.add(`${session}/settings.json`, encoder.encode(formatJson(runSettings)));

  if (company.instructions !== null) {
    const root = companyDir(layout, companyId);
    const read = await readTextWithin(
      root,
      join(root, company.instructions.file),
      MAX_INSTRUCTIONS_BYTES,
    );
    if (read.ok) out.add('claude/CLAUDE.md', encoder.encode(read.text));
    else out.errors.push(`instructions.file: ${read.message}`);
  }

  const shadowed = await findShadowing(
    projectDir,
    addDirsFromArgs(input.userArgs, projectDir),
    profileNames,
  );
  for (const item of shadowed) {
    out.warnings.push(
      `Natywne .claude/ projektu ma zasob o tej samej nazwie co zasob firmy: ${item}.`,
    );
  }

  // Zasoby wlaczone przez warstwe projektu (SEC-06): zmiana tej listy zmienia skrot pary projekt-firma.
  const projectResources = effective.resources
    .filter((entry) => entry.layer === 'project')
    .map((entry) => ({
      key: refKey(entry.resource),
      sha256: sha256Hex(canonicalJson(entry.resource)),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  subjects.push(
    makeSubject({
      key: projectApprovalKey(projectDir),
      company: companyId,
      kind: 'project',
      id: projectDir,
      version: null,
      fields: { path: projectDir, company: companyId, projectResources },
      warnings:
        input.projectStore === 'local'
          ? [
              'manifest .cwm/project.yaml lezy w projekcie i wybiera firme: sprawdz, czy to Twoj projekt',
            ]
          : [],
    }),
  );

  // Opcje uruchamiania silnika firmy (SEC-12): zmiana pliku `claude`, passthrough albo izolacji = nowe pytanie.
  const configuredEnginePath =
    company.runtime.claudePath === null ? null : await realpathLoose(company.runtime.claudePath);
  subjects.push(
    makeSubject({
      key: companyApprovalKey(companyId),
      company: companyId,
      kind: 'company',
      id: companyId,
      version: null,
      fields: {
        claudePath: configuredEnginePath,
        envPassthrough: [...company.runtime.envPassthrough].sort(),
        isolation: company.runtime.isolation,
      },
      warnings: company.runtime.isolation
        ? []
        : ['runtime.isolation=false: sesja widzi pluginy, skille i konektory konta claude.ai'],
    }),
  );

  const own = new Set<string>();
  for (const entry of effective.resources) {
    for (const ref of refsOfResource(entry.resource)) own.add(ref);
  }
  const envRefs = settingsEnvRefs([effective.settings.regular, effective.settings.enforced]);
  const ownRefs = [...new Set([...own, ...Object.values(envRefs)])].sort();
  const registryRefs = workspace.registry.entries.flatMap((entry) =>
    refsOfResource(entry.resource),
  );

  for (const pending of pendingPins) {
    const { pins, dropped } = await pinHookCommands(pending.commands, input.homeDir);
    const kept =
      pending.exclude === undefined
        ? pins
        : pins.filter((pin) => !pending.exclude?.(pin.token.raw));
    const infos = pinInfos(kept, dropped).map((info) => {
      // Sciezka do pliku tego uruchomienia: liczy sie tresc, ktora trafi na dysk, nie stara kopia.
      const rel = info.raw.startsWith(`${baseDir}/`) ? info.raw.slice(baseDir.length + 1) : null;
      const planned = rel === null ? undefined : out.files.get(foldPath(rel));
      return planned === undefined
        ? info
        : { raw: info.raw, sha256: planned.sha256, unpinnedReason: null };
    });
    subject(pending.resource, { ...pending.facts, pins: infos });
  }

  const files = [...out.files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
  for (const file of files) {
    const check = validateCleanupPath(file.rel);
    if (!check.ok) out.errors.push(`Sciezka ${file.rel} jest niedozwolona (${check.reason}).`);
  }
  const profile = files.filter((f) => f.rel.startsWith('claude/'));
  const perRun = files.filter((f) => !f.rel.startsWith('claude/'));
  return {
    company: companyId,
    projectDir,
    projectHash,
    baseDir,
    configDir: join(baseDir, 'claude'),
    tmpDir: join(baseDir, 'tmp'),
    files,
    profileHash: planDigest(profile),
    sessionHash: planDigest(perRun),
    settingsFile: join(baseDir, session, 'settings.json'),
    mcpConfigFile,
    pluginDirs,
    pluginSnapshots: pluginSnapshots.sort(),
    subjects: subjects.sort((a, b) => (a.key < b.key ? -1 : 1)),
    ownEnvRefs: ownRefs,
    settingsEnvRefs: envRefs,
    otherCompanyRefs: foreignEnvRefs(registryRefs, ownRefs),
    configuredEnginePath,
    summary,
    notes: out.notes,
    warnings: out.warnings,
    errors: out.errors,
  };
}
