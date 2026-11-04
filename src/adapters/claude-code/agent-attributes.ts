import type { ItemAttributes, ReasoningDepth } from '../../core/model/item';
import { asText, type FrontmatterResult } from '../shared/frontmatter';
import type { MappedAttributes } from '../shared/markdown-item';

// Przyblizenie: model Claude'a to nie to samo co glebokosc rozumowania (ADR 0023).
// Wartosc spoza listy zostaje w `unmappedKeys`, a oryginal i tak jest w snapshocie.
export const MODEL_DEPTH: Readonly<Record<string, ReasoningDepth>> = {
  haiku: 'routine',
  sonnet: 'deep',
  opus: 'deepest',
};

export function mapAgentAttributes(fm: FrontmatterResult): MappedAttributes {
  const attributes: { -readonly [K in keyof ItemAttributes]: ItemAttributes[K] } = {};
  const consumed: string[] = [];
  const color = asText(fm.data.get('color'));
  if (color !== null) {
    attributes.presentation = { accentColor: color };
    consumed.push('color');
  }
  const memory = asText(fm.data.get('memory'));
  if (memory !== null) {
    attributes.memoryScope = memory;
    consumed.push('memory');
  }
  const model = asText(fm.data.get('model'));
  const depth = model === null ? undefined : MODEL_DEPTH[model.toLowerCase()];
  if (depth !== undefined) {
    attributes.reasoningDepth = depth;
    consumed.push('model');
  }
  return { attributes, consumed, warnings: [] };
}
