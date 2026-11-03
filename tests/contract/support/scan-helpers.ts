import type {
  DetectedRoot,
  ImportCandidate,
  RootKind,
  ScanResult,
  ToolAdapter,
} from '../../../src/core/ports/tool-adapter';
import { FsSourceReader, InstrumentedReader, type Fault } from './fs-source-reader';

export interface ScanOptions {
  readonly active?: boolean;
  readonly fault?: (relPath: string) => Fault | null;
}

export async function scanRoot(
  adapter: ToolAdapter,
  kind: RootKind,
  dir: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const root: DetectedRoot = {
    rootId: 'test-root',
    tool: adapter.id,
    kind,
    label: `~/${kind}`,
    exists: true,
    active: options.active ?? true,
  };
  const reader = new InstrumentedReader(
    new FsSourceReader(new Map([[root.rootId, dir]])),
    options.fault,
  );
  return adapter.scan(root, reader);
}

export function candidate(result: ScanResult, relPath: string): ImportCandidate {
  const found = result.candidates.find((c) => c.relPath === relPath);
  if (found === undefined) {
    throw new Error(
      `Brak kandydata "${relPath}"; sa: ${result.candidates.map((c) => c.relPath).join(', ')}`,
    );
  }
  return found;
}

export function warningCodes(c: ImportCandidate): string[] {
  return c.warnings.map((w) => w.code);
}

export function skipFor(result: ScanResult, relPath: string) {
  return result.skipped.find((s) => s.relPath === relPath);
}

export function unmapped(c: ImportCandidate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of c.draft.source?.snapshots[0]?.unmappedKeys ?? []) out[k.path] = k.value;
  return out;
}
