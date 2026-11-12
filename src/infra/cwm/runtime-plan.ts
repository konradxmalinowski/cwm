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
  extractPluginExecutables,
  foreignEnvRefs,
  formatJson,
  makeSubject,
  mcpCommandIsPath,
  mcpEnvRefs,
  needsApproval,
  projectApprovalKey,
  refKey,
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
import { parseContent } from './import-source';
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
  readonly profile: { skills: number; agents: number; commands: number; settings: boolean };
  readonly plugin: { skills: number; agents: number; commands: number };
  readonly mcp: number;
  readonly pluginDirs: number;
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

class Collector {
  readonly files = new Map<string, PlannedFile>();
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly notes: string[] = [];

  add(rel: string, bytes: Uint8Array, executable = false): void {
    if (this.files.has(rel)) {
      this.errors.push(`Dwa zasoby zapisywalyby ten sam plik: ${rel}.`);
      return;
    }
    this.files.set(rel, { rel, bytes, executable, sha256: sha256Hex(bytes) });
  }
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
    },
    sourceSha256,
  };
}

function parseOrReport(
  kind: 'skill' | 'agent' | 'command',
  bytes: Uint8Array,
  label: string,
  out: Collector,
): Parsed | null {
  const parsed = parseContent(kind, bytes);
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
        kind: resource.kind as 'mcp' | 'plugin' | 'settings' | 'skill' | 'agent' | 'command',
        id: resource.id,
        version: resource.version ?? null,
        fields,
        warnings: approvalWarnings(resource, facts),
      }),
    );
  };

  const summary = {
    profile: { skills: 0, agents: 0, commands: 0, settings: false },
    plugin: { skills: 0, agents: 0, commands: 0 },
    mcp: 0,
    pluginDirs: 0,
  };
  const pluginDirs: string[] = [];
  const pluginSnapshots: string[] = [];
  const mcpServers: McpServer[] = [];
  const commandPaths: Record<string, string> = {};
  const profileNames = { skills: [] as string[], agents: [] as string[], commands: [] as string[] };
  const taken = new Set<string>();

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
        const main = tree.files.find((f) => f.rel === wanted);
        if (main === undefined) {
          out.errors.push(`${label}: brak pliku zrodlowego ${wanted}.`);
          break;
        }
        const parsed = parseOrReport('skill', main.bytes, label, out);
        if (parsed === null) break;
        const finals: TreeFile[] = tree.files
          .filter((f) => f.rel !== wanted)
          .concat({ rel: 'SKILL.md', bytes: parsed.content, executable: false });
        if (new Set(finals.map((f) => f.rel.toLowerCase())).size !== finals.length) {
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
        subject(resource, contentFacts(parsed, treeSha256(finals)));
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
        const parsed = parseOrReport(resource.kind, bytes, label, out);
        if (parsed === null) break;
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
      case 'settings': {
        const { pins, dropped } = await pinHookCommands(hookCommands(resource), input.homeDir);
        subject(resource, { pins: pinInfos(pins, dropped) });
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
        const { pins, dropped } = await pinHookCommands(exec.hookCommands, input.homeDir);
        // Sciezki pod ${CLAUDE_PLUGIN_ROOT} sa w drzewie, wiec obejmuje je lista plikow.
        const outside = pins.filter((pin) => !pin.token.raw.includes('CLAUDE_PLUGIN_ROOT'));
        subject(resource, {
          treeSha256: treeHash,
          files: tree.files.map((f) => ({ path: f.rel, sha256: sha256Hex(f.bytes) })),
          pluginExec: exec,
          pins: pinInfos(outside, dropped),
        });
        break;
      }
    }
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
