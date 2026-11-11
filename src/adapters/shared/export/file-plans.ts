import type { LoadedItem, ToolId } from '../../../core/model/item';
import type { ExportContext, RootKind } from '../../../core/ports/tool-adapter';
import type { ConflictResolution, PlanConflictOption } from '../../../core/model/plan';
import {
  applyMarkerBlock,
  findManagedFragment,
  hasManagedBlock,
  hasOurMarkers,
  replaceFragment,
} from '../marker-block';
import { TextDecodeError, encodeUtf8 } from '../text';
import { mergeHooks, parseOriginalHook, type HookInput } from './hooks-export';
import { isJsonRecord, jsonEqual, setTopLevelKey } from './json-key';
import {
  PlanBuilder,
  TargetReadError,
  bytesEqual,
  pickRoot,
  readTarget,
  snapshotBytes,
} from './plan-support';

/** Plany plikow wspolnych: instrukcja globalna (blok miedzy markerami) i hooki (klucz JSON). */

const BOM = '﻿';

/** Dekodowanie z zachowaniem BOM: edycja ma zostawic bajty poza zakresem, wiec nie wolno go gubic. */
export function decodeRaw(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TextDecodeError();
  }
}

export interface FileTargetSpec {
  readonly tool: ToolId;
  readonly kind: RootKind;
  readonly fileName: string;
}

const REPLACE_OPTION: PlanConflictOption = {
  id: 'replace-fragment' satisfies ConflictResolution,
  label: 'Zamień ten fragment na blok aplikacji',
};
const APPEND_OPTION: PlanConflictOption = {
  id: 'append-block' satisfies ConflictResolution,
  label: 'Dopisz blok na końcu',
};

function fragmentReason(fileName: string, lines: number, unique: boolean): string {
  const found = unique
    ? `Plik ${fileName} zawiera treść zaimportowaną z niego do tego elementu (${lines} linii), ale bez znaczników aplikacji.`
    : `Plik ${fileName} zawiera treść zaimportowaną z niego do tego elementu w kilku miejscach, ale bez znaczników aplikacji.`;
  const replace = unique
    ? 'Zamiana wstawi blok aplikacji w miejsce tego fragmentu, a resztę pliku zostawi bez zmian. '
    : '';
  return `${found} ${replace}Dopisanie bloku na końcu zostawi starą treść w pliku, więc treść będzie w nim dwa razy.`;
}

function refuseAll(b: PlanBuilder, items: readonly LoadedItem[], reason: string): void {
  for (const l of items) b.refuse(l.item, reason);
}

export async function planInstructions(
  b: PlanBuilder,
  ctx: ExportContext,
  spec: FileTargetSpec,
  items: readonly LoadedItem[],
): Promise<void> {
  const choice = pickRoot(ctx, spec.tool, spec.kind);
  if (choice.root === null) {
    refuseAll(b, items, choice.missing);
    return;
  }
  const root = choice.root;
  let previous: Uint8Array | null;
  try {
    previous = await readTarget(ctx.reader, root.rootId, '');
  } catch (error) {
    if (!(error instanceof TargetReadError)) throw error;
    refuseAll(b, items, error.message);
    return;
  }
  let text: string | null = null;
  if (previous !== null) {
    try {
      text = decodeRaw(previous);
    } catch (error) {
      if (!(error instanceof TextDecodeError)) throw error;
      refuseAll(
        b,
        items,
        `Plik ${spec.fileName} nie jest poprawnym tekstem UTF-8, więc aplikacja go nie zmieni.`,
      );
      return;
    }
  }

  if (items.length === 0) {
    if (text !== null && hasManagedBlock(text)) {
      b.orphan(
        root.rootId,
        spec.fileName,
        'Plik ma blok aplikacji, ale żadna instrukcja globalna ze zbioru go nie realizuje. Aplikacja go nie usuwa.',
      );
    }
    return;
  }
  const ids = items.map((l) => l.item.id);
  if (items.length > 1) {
    b.conflict(
      ids,
      spec.fileName,
      'Kilka instrukcji globalnych celuje w ten sam plik. Wybierz jedną, aplikacja nie łączy ich sama.',
    );
    return;
  }
  const loaded = items[0];
  if (loaded === undefined) return;
  const body = loaded.item.content.body;

  // Bez zmian od importu z tego narzedzia: plik juz jest taki, jaki byl zrodlem.
  const snap = snapshotBytes(loaded, spec.tool, spec.fileName);
  if (previous !== null && snap !== undefined && bytesEqual(previous, snap)) {
    const snapRaw = decodeRaw(snap);
    const snapText = (snapRaw.startsWith(BOM) ? snapRaw.slice(1) : snapRaw).replace(/\r\n?/g, '\n');
    if (snapText === body) {
      b.entry({
        rootId: root.rootId,
        relPath: spec.fileName,
        action: 'unchanged',
        scope: 'marker-block',
        itemIds: ids,
        content: previous,
        previous,
      });
      return;
    }
  }

  if (/<!--[ \t]*(?:cwm|ai-skills-manager):(start|end)[ \t]*-->/.test(body)) {
    b.refuse(
      loaded.item,
      'Treść instrukcji zawiera znaczniki aplikacji. Wstawienie bloku w blok uszkodziłoby plik.',
    );
    return;
  }
  let appendAnyway = false;
  // Regula 3 (ADR 0025): plik ma niezarzadzany fragment ze snapshotu zrodla tego elementu.
  if (text !== null && snap !== undefined && !hasOurMarkers(text)) {
    const snapRaw = decodeRaw(snap);
    const fragment = findManagedFragment(text, snapRaw);
    if (fragment !== null) {
      const decision = ctx.decisions?.find(
        (d) => d.itemId === loaded.item.id && d.relPath === spec.fileName,
      )?.resolution;
      const unique = fragment.count === 1;
      if (decision === undefined || (decision === 'replace-fragment' && !unique)) {
        b.conflict(ids, spec.fileName, fragmentReason(spec.fileName, fragment.lines, unique), [
          ...(unique ? [REPLACE_OPTION] : []),
          APPEND_OPTION,
        ]);
        return;
      }
      if (decision === 'replace-fragment') {
        const replaced = replaceFragment(text, fragment, body);
        b.entry({
          rootId: root.rootId,
          relPath: spec.fileName,
          action: 'modify',
          scope: 'marker-block',
          itemIds: ids,
          content: encodeUtf8(replaced),
          previous,
          warnings: [
            'Fragment pliku zaimportowany z tego pliku zostanie zastąpiony blokiem aplikacji z nową treścią. Reszta pliku zostaje bez zmian.',
          ],
        });
        return;
      }
      appendAnyway = true;
    }
  }
  const result = applyMarkerBlock(text, body, { skipDuplicateCheck: appendAnyway });
  if (result.kind === 'conflict') {
    b.conflict(ids, spec.fileName, result.reason);
    return;
  }
  if (result.kind === 'refused') {
    b.refuse(loaded.item, result.reason);
    return;
  }
  const content = encodeUtf8(result.text);
  b.entry({
    rootId: root.rootId,
    relPath: spec.fileName,
    action: result.kind === 'unchanged' ? 'unchanged' : previous === null ? 'create' : 'modify',
    scope: 'marker-block',
    itemIds: ids,
    content: result.kind === 'unchanged' ? (previous ?? content) : content,
    previous,
    warnings:
      result.kind === 'appended'
        ? ['Plik nie miał znaczników aplikacji, więc blok zostanie dopisany na końcu.']
        : result.kind === 'migrated'
          ? [
              'Blok ma stare znaczniki ai-skills-manager. Zostaną zastąpione znacznikami cwm, a treść bloku zapisana na nowo.',
            ]
          : [],
  });
}

export interface HooksSpec extends FileTargetSpec {
  /** Zdarzenia, ktore narzedzie czyta; inne dostaja ostrzezenie przy wpisie. */
  readonly knownEvents: readonly string[] | null;
}

export async function planHooks(
  b: PlanBuilder,
  ctx: ExportContext,
  spec: HooksSpec,
  items: readonly LoadedItem[],
): Promise<void> {
  if (items.length === 0) return;
  const choice = pickRoot(ctx, spec.tool, spec.kind);
  if (choice.root === null) {
    refuseAll(b, items, choice.missing);
    return;
  }
  const root = choice.root;
  let previous: Uint8Array | null;
  try {
    previous = await readTarget(ctx.reader, root.rootId, '');
  } catch (error) {
    if (!(error instanceof TargetReadError)) throw error;
    refuseAll(b, items, error.message);
    return;
  }
  let text = '';
  let parsed: unknown = {};
  try {
    if (previous !== null) {
      text = decodeRaw(previous);
      parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    }
  } catch {
    refuseAll(
      b,
      items,
      `Plik ${spec.fileName} nie jest poprawnym JSON-em, więc aplikacja go nie zmieni.`,
    );
    return;
  }
  if (!isJsonRecord(parsed)) {
    refuseAll(
      b,
      items,
      `Plik ${spec.fileName} nie zawiera obiektu JSON, więc aplikacja go nie zmieni.`,
    );
    return;
  }

  const inputs: HookInput[] = [];
  const used: LoadedItem[] = [];
  for (const loaded of items) {
    const def = loaded.item.attributes.hook;
    if (def === undefined) {
      b.refuse(loaded.item, 'Element nie ma definicji hooka (zdarzenie i polecenie).');
      continue;
    }
    inputs.push({
      def,
      original: parseOriginalHook(snapshotBytes(loaded, spec.tool, 'hook.json')),
    });
    used.push(loaded);
  }
  if (inputs.length === 0) return;
  const ids = used.map((l) => l.item.id);

  const merged = mergeHooks(parsed['hooks'], inputs);
  if (typeof merged === 'string') {
    refuseAll(b, used, merged);
    return;
  }
  const warnings: string[] = [];
  if (spec.knownEvents !== null) {
    for (const { def } of inputs) {
      if (!spec.knownEvents.includes(def.event)) {
        warnings.push(
          `Zdarzenie "${def.event}" nie jest na liście znanych narzędziu. Może być po cichu pominięte.`,
        );
      }
    }
  }
  if (previous === null) {
    // Brak pliku: powstaje plik z samym kluczem hooks.
    b.entry({
      rootId: root.rootId,
      relPath: spec.fileName,
      action: 'create',
      scope: 'json-key',
      itemIds: ids,
      content: encodeUtf8(`${JSON.stringify({ hooks: merged.hooks }, null, 2)}\n`),
      previous: null,
      warnings,
    });
    return;
  }
  if (!merged.changed) {
    b.entry({
      rootId: root.rootId,
      relPath: spec.fileName,
      action: 'unchanged',
      scope: 'json-key',
      itemIds: ids,
      content: previous,
      previous,
      warnings,
    });
    return;
  }
  const edited = setTopLevelKey(text, 'hooks', merged.hooks);
  if (!edited.ok) {
    refuseAll(b, used, edited.message);
    return;
  }
  // Weryfikacja: poza kluczem hooks drzewo jest to samo, a hooks ma oczekiwana wartosc.
  const after = JSON.parse(
    edited.text.startsWith(BOM) ? edited.text.slice(1) : edited.text,
  ) as Record<string, unknown>;
  const { hooks: afterHooks, ...afterRest } = after;
  const { hooks: _beforeHooks, ...beforeRest } = parsed;
  void _beforeHooks;
  if (!jsonEqual(afterRest, beforeRest) || !jsonEqual(afterHooks, merged.hooks)) {
    refuseAll(
      b,
      used,
      `Weryfikacja semantyczna ${spec.fileName} nie przeszła. Plik zostaje bez zmian.`,
    );
    return;
  }
  b.entry({
    rootId: root.rootId,
    relPath: spec.fileName,
    action: 'modify',
    scope: 'json-key',
    itemIds: ids,
    content: encodeUtf8(edited.text),
    previous,
    warnings,
  });
}
