import { createClaudeCodeAdapter } from '../../adapters/claude-code';
import { createCodexAdapter } from '../../adapters/codex';
import type { ToolAdapter } from '../../core/ports/tool-adapter';

/**
 * Rejestr adapterow narzedzi. Jedyne miejsce, w ktorym main dowiazuje konkretne adaptery;
 * serwis importu dostaje liste i nie wie, ktore narzedzia istnieja.
 */
export function createAdapters(): readonly ToolAdapter[] {
  return [createClaudeCodeAdapter(), createCodexAdapter()];
}
