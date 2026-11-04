import { createHmac, randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { RootId, ToolId } from '../../core/model/item';
import type { DetectedRoot, LocationCatalog, RootKind } from '../../core/ports/tool-adapter';
import { errnoCode } from '../fs/store-error';
import type { PlatformEnv } from './env';

/**
 * Jedyne miejsce w aplikacji, ktore zna sciezki konfiguracji narzedzi (ADR 0022). Dodanie roota,
 * narzedzia albo systemu to wpis w `CANDIDATES` plus test z podstawionym `PlatformEnv`.
 */

type Base = 'claude' | 'codex' | 'agents';
type EntryType = 'directory' | 'file';

interface CandidateSpec {
  readonly tool: ToolId;
  readonly kind: RootKind;
  readonly base: Base;
  readonly segments: readonly string[];
  readonly entry: EntryType;
  /** Brak pola oznacza wszystkie systemy. */
  readonly platforms?: readonly NodeJS.Platform[];
}

/**
 * Kolejnosc ma znaczenie: przy duplikacie miedzyrootowym wygrywa root wyzej w tabeli
 * (serwis importu bierze kolejnosc z wyniku `detect`). Dokumentacja Codeksa nie rozstrzyga,
 * ktory z dwoch rootow skilli ma pierwszenstwo, wiec `~/.codex/skills` jest przyjety jako glowny.
 */
export const CANDIDATES: readonly CandidateSpec[] = [
  { tool: 'claude-code', kind: 'skills', base: 'claude', segments: ['skills'], entry: 'directory' },
  { tool: 'claude-code', kind: 'agents', base: 'claude', segments: ['agents'], entry: 'directory' },
  {
    tool: 'claude-code',
    kind: 'commands',
    base: 'claude',
    segments: ['commands'],
    entry: 'directory',
  },
  {
    tool: 'claude-code',
    kind: 'global-instructions',
    base: 'claude',
    segments: ['CLAUDE.md'],
    entry: 'file',
  },
  {
    tool: 'claude-code',
    kind: 'hooks',
    base: 'claude',
    segments: ['settings.json'],
    entry: 'file',
  },
  { tool: 'codex', kind: 'skills', base: 'codex', segments: ['skills'], entry: 'directory' },
  // Drugi root skilli Codeksa (ADR 0024): dzis moze nie istniec, ale aktualizacja go odtworzy.
  { tool: 'codex', kind: 'skills', base: 'agents', segments: ['skills'], entry: 'directory' },
  { tool: 'codex', kind: 'agents', base: 'codex', segments: ['agents'], entry: 'directory' },
  {
    tool: 'codex',
    kind: 'global-instructions',
    base: 'codex',
    segments: ['AGENTS.md'],
    entry: 'file',
  },
  { tool: 'codex', kind: 'hooks', base: 'codex', segments: ['hooks.json'], entry: 'file' },
  {
    tool: 'codex',
    kind: 'agent-registry',
    base: 'codex',
    segments: ['config.toml'],
    entry: 'file',
  },
];

const BASE_DIR: Record<Base, { readonly dir: string; readonly override?: string }> = {
  claude: { dir: '.claude', override: 'CLAUDE_CONFIG_DIR' },
  codex: { dir: '.codex', override: 'CODEX_HOME' },
  agents: { dir: '.agents' },
};

/** Katalog glowny narzedzia; `agents` jest wspoldzielony i nie jest czyimkolwiek domem. */
const TOOL_HOME: Record<ToolId, Base> = { 'claude-code': 'claude', codex: 'codex' };

export type PathProbe = (absolutePath: string) => Promise<'directory' | 'file' | 'missing'>;

/** Probe idzie za dowiazaniem: `~/.codex/skills` bywa dowiazaniem do katalogu z dotfiles. */
export const fsProbe: PathProbe = async (absolutePath) => {
  try {
    const info = await stat(absolutePath);
    if (info.isDirectory()) return 'directory';
    return info.isFile() ? 'file' : 'missing';
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      return 'missing';
    }
    throw error;
  }
};

export interface LocationOptions {
  readonly probe?: PathProbe;
  /** Sol identyfikatorow; domyslnie losowa na instancje, w testach stala. */
  readonly salt?: Uint8Array;
}

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export class FsLocationCatalog implements LocationCatalog {
  private readonly paths = new Map<RootId, string>();
  private readonly probe: PathProbe;
  private readonly salt: Uint8Array;

  constructor(
    private readonly platformEnv: PlatformEnv,
    options: LocationOptions = {},
  ) {
    this.probe = options.probe ?? fsProbe;
    this.salt = options.salt ?? randomBytes(32);
  }

  /**
   * Zwraca takze rooty, ktorych nie ma na dysku (`exists: false`), zeby uzytkownik widzial,
   * gdzie aplikacja szukala. Etykieta jest stala z tabeli, nigdy sciezka z katalogiem domowym.
   */
  async detect(): Promise<readonly DetectedRoot[]> {
    const roots: DetectedRoot[] = [];
    for (const spec of CANDIDATES) {
      if (spec.platforms !== undefined && !spec.platforms.includes(this.platformEnv.platform)) {
        continue;
      }
      const absolute = this.absolutePath(spec);
      const found = await this.probe(absolute);
      const exists = found === spec.entry;
      const rootId = this.idFor(spec, absolute);
      this.paths.set(rootId, absolute);
      roots.push({
        rootId,
        tool: spec.tool,
        kind: spec.kind,
        label: this.label(spec),
        exists,
        // Narzedzie czyta kazdy istniejacy root; nieistniejacy nie jest czytany.
        active: exists,
      });
    }
    return roots;
  }

  async toolHomeExists(tool: ToolId): Promise<boolean> {
    return (await this.probe(this.baseDir(TOOL_HOME[tool]))) === 'directory';
  }

  /** Mapa zostaje w main: tylko czytnik zrodla pyta o sciezke, adaptery i renderer znaja `rootId`. */
  resolvePath(rootId: RootId): string | null {
    return this.paths.get(rootId) ?? null;
  }

  private baseDir(base: Base): string {
    const api = pathApiFor(this.platformEnv.platform);
    const { dir, override } = BASE_DIR[base];
    const overridden = override === undefined ? undefined : this.platformEnv.env[override];
    if (overridden !== undefined && overridden !== '' && api.isAbsolute(overridden)) {
      return overridden;
    }
    return api.join(this.platformEnv.homeDir, dir);
  }

  private absolutePath(spec: CandidateSpec): string {
    return pathApiFor(this.platformEnv.platform).join(this.baseDir(spec.base), ...spec.segments);
  }

  private label(spec: CandidateSpec): string {
    const { dir, override } = BASE_DIR[spec.base];
    const overridden = override === undefined ? undefined : this.platformEnv.env[override];
    const prefix =
      overridden !== undefined && overridden !== '' && override !== undefined
        ? `$${override}`
        : `~/${dir}`;
    return [prefix, ...spec.segments].join('/');
  }

  private idFor(spec: CandidateSpec, absolute: string): RootId {
    const digest = createHmac('sha256', this.salt)
      .update(`${spec.tool}|${spec.kind}|${absolute}`)
      .digest('base64url');
    return `root-${digest.slice(0, 22)}`;
  }
}
