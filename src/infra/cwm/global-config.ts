import { parseDocument } from 'yaml';

import { validateGlobalConfig, type MarketplaceSource } from '../../core/cwm';
import { loadGlobalConfig } from './workspace';
import type { CwmLayout } from './layout';
import { parseManifestYaml } from './yaml-manifest';
import { homeScope, WriteDeniedError, writeScopedFile } from './writer';

export type MarketplaceEdit =
  | { readonly ok: true; readonly next: Readonly<Record<string, MarketplaceSource>> }
  | { readonly ok: false; readonly reason: string };

export type MarketplaceEditResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Zmienia tylko `marketplaces` w `config.yaml`, zachowujac reszte dokumentu (w tym komentarze
 * uzytkownika). Plik jest czytany tuz przed zapisem, a wynik przechodzi ten sam walidator co odczyt,
 * wiec zapis nigdy nie uniewazni konfiguracji. Zapis atomowy przez writer `~/.cwm` (0600). Dwa
 * rownolegle `cwm marketplace ...` moga sobie nadpisac zmiane: to polecenia reczne, bez blokady.
 */
export async function editMarketplaces(
  layout: CwmLayout,
  edit: (current: Readonly<Record<string, MarketplaceSource>>) => MarketplaceEdit,
): Promise<MarketplaceEditResult> {
  const loaded = await loadGlobalConfig(layout);
  if (!loaded.ok) {
    return { ok: false, reason: `config.yaml jest niepoprawny albo nieczytelny (cwm doctor).` };
  }
  const decision = edit(loaded.value.marketplaces ?? {});
  if (!decision.ok) return decision;

  const doc = parseDocument(loaded.text, {
    schema: 'core',
    version: '1.2',
    merge: false,
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length > 0) return { ok: false, reason: 'config.yaml nie jest poprawnym YAML.' };
  const names = Object.keys(decision.next).sort();
  if (names.length === 0) doc.delete('marketplaces');
  else {
    doc.set(
      'marketplaces',
      doc.createNode(Object.fromEntries(names.map((name) => [name, { ...decision.next[name] }]))),
    );
  }
  const text = doc.toString({ lineWidth: 0 });

  const parsed = parseManifestYaml(text);
  const checked = parsed.ok ? validateGlobalConfig(parsed.value) : null;
  if (checked === null || !checked.ok) {
    throw new WriteDeniedError('Zmieniony config.yaml nie przechodzi walidacji; zapis odrzucony.');
  }
  await writeScopedFile(homeScope(layout.home), layout.configFile, text);
  return { ok: true };
}
