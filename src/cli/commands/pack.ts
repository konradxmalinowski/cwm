import { homedir } from 'node:os';

import type { Command } from 'commander';

import {
  memberKey,
  namespaceOf,
  packMemberHash,
  parseMemberKey,
  sanitizePackName,
  type PackKind,
} from '../../core/cwm';
import {
  deriveFromDisk,
  loadPackDefs,
  loadPackTrust,
  loadWorkspace,
  movePackMember,
  renamePack,
  splitPackId,
} from '../../infra/cwm';
import {
  contextOf,
  failure,
  print,
  printJson,
  table,
  usageError,
  warn,
  type Context,
} from '../context';
import { requireInitialized } from './shared';

function checkId(id: string): void {
  if (splitPackId(id) === null) throw usageError('Niepoprawne id pakietu (<przestrzen>/<nazwa>).');
}

async function listCommand(ctx: Context): Promise<void> {
  await requireInitialized(ctx.layout);
  const defs = await loadPackDefs(ctx.layout);
  const rows: { id: string; members: number; trusted: number | null; approvedAt: string | null }[] =
    [];
  const corrupt: string[] = [];
  for (const [id, manifest] of [...defs.packs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const trust = await loadPackTrust(ctx.layout, id);
    if (trust.state === 'corrupt') corrupt.push(`${id}: ${trust.message}`);
    const keys = new Set(manifest.spec.members.map((m) => memberKey(m.kind, m.id)));
    const trusted = trust.state === 'ok' ? trust.file.members.filter((m) => keys.has(m.key)) : null;
    rows.push({
      id,
      members: keys.size,
      trusted: trusted === null ? null : trusted.length,
      approvedAt:
        trusted
          ?.map((m) => m.approvedAt)
          .sort()
          .pop() ?? null,
    });
  }
  if (ctx.json) {
    return printJson({ ok: corrupt.length === 0, packs: rows, problems: defs.problems, corrupt });
  }
  if (rows.length === 0) print('Brak pakietow. Powstaja przy cwm import claude.');
  else {
    print(
      table([
        ['PAKIET', 'ZASOBY', 'ZATWIERDZONE', 'OSTATNIA ZGODA'],
        ...rows.map((r) => [
          r.id,
          String(r.members),
          r.trusted === null ? 'brak zgody' : String(r.trusted),
          r.approvedAt ?? '-',
        ]),
      ]),
    );
  }
  for (const text of defs.problems) warn(`Uwaga: ${text}`);
  for (const text of corrupt) warn(`Blad: ${text}`);
  if (corrupt.length > 0)
    throw failure('Uszkodzone zaufane skroty pakietow: nic w nich nie jest zatwierdzone.');
}

async function showCommand(ctx: Context, id: string): Promise<void> {
  checkId(id);
  await requireInitialized(ctx.layout);
  const defs = await loadPackDefs(ctx.layout);
  const manifest = defs.packs.get(id);
  if (manifest === undefined) throw failure(`Nie ma pakietu ${id}.`);
  const trust = await loadPackTrust(ctx.layout, id);
  if (trust.state === 'corrupt') throw failure(`Pakiet ${id}: ${trust.message}`);
  const workspace = await loadWorkspace(ctx.layout);
  const dirs = new Map(
    workspace.registry.entries.map((e) => [
      memberKey(e.resource.kind as PackKind, e.resource.id),
      e.dir,
    ]),
  );
  const rows: { key: string; state: string; approvedAt: string | null; via: string | null }[] = [];
  for (const ref of manifest.spec.members) {
    const key = memberKey(ref.kind, ref.id);
    const record = trust.state === 'ok' ? trust.file.members.find((m) => m.key === key) : undefined;
    const dir = dirs.get(key);
    let state: string;
    if (dir === undefined) state = 'brak w rejestrze';
    else {
      const derived = await deriveFromDisk(ctx.layout, dir, ref.kind, id, homedir());
      if (derived === null) state = 'nieczytelny';
      else if (record === undefined) state = 'bez zgody';
      else if (
        record.hash ===
        packMemberHash(key, { ...derived.facts.fields, bindings: record.fields.bindings })
      ) {
        state = derived.facts.required ? 'zatwierdzony (pola wykonawcze)' : 'zatwierdzony';
      } else state = 'zmieniony od zgody';
    }
    rows.push({ key, state, approvedAt: record?.approvedAt ?? null, via: record?.via ?? null });
  }
  if (ctx.json) return printJson({ ok: true, id, members: rows });
  print(`Pakiet ${id}: ${rows.length} zasobow`);
  print(
    table([
      ['ZASOB', 'STAN', 'ZGODA', 'ZRODLO'],
      ...rows.map((r) => [r.key, r.state, r.approvedAt ?? '-', r.via ?? '-']),
    ]),
  );
  print('Stan "zmieniony od zgody" i "bez zgody": cwm start zapyta raz o caly pakiet.');
}

async function renameCommand(ctx: Context, id: string, name: string): Promise<void> {
  checkId(id);
  const clean = sanitizePackName(name);
  if (clean !== name)
    throw usageError(`Nazwa pakietu: male litery, cyfry, ".", "_" i "-" (np. "${clean}").`);
  await requireInitialized(ctx.layout);
  const target = `${namespaceOf(id)}/${name}`;
  await renamePack(ctx.layout, id, target);
  if (ctx.json) return printJson({ ok: true, from: id, to: target });
  print(`Zmieniono nazwe pakietu: ${id} -> ${target} (zgoda zostaje).`);
}

async function moveCommand(ctx: Context, key: string, target: string): Promise<void> {
  checkId(target);
  const ref = parseMemberKey(key);
  if (ref === null)
    throw usageError('Niepoprawny zasob (<rodzaj>:<przestrzen>/<nazwa>, np. skill:global/acme).');
  if (namespaceOf(ref.id) !== namespaceOf(target)) {
    throw usageError('Zasob moze trafic tylko do pakietu ze swojej przestrzeni nazw.');
  }
  await requireInitialized(ctx.layout);
  const from = await movePackMember(ctx.layout, ref, target);
  if (ctx.json) return printJson({ ok: true, key, from, to: target });
  print(`Przeniesiono ${key}${from === null ? '' : ` z ${from}`} do ${target}.`);
  print('Zgoda nie przechodzi razem z zasobem: cwm start zapyta raz o pakiet docelowy.');
}

export function registerPack(program: Command): void {
  const pack = program
    .command('pack')
    .description('Pakiety zasobow: grupy zatwierdzane razem przy imporcie (~/.cwm/packs)');
  pack
    .command('list')
    .description('Wypisuje pakiety, liczbe zasobow i stan zgody')
    .action(async (_options: unknown, command: Command) => listCommand(contextOf(command)));
  pack
    .command('show <id>')
    .description('Pokazuje zasoby pakietu i ich stan wobec zaufanych skrotow (czyta rejestr)')
    .action(async (id: string, _options: unknown, command: Command) =>
      showCommand(contextOf(command), id),
    );
  pack
    .command('rename <id> <nowa-nazwa>')
    .description('Zmienia nazwe pakietu (zgoda zostaje)')
    .action(async (id: string, name: string, _options: unknown, command: Command) =>
      renameCommand(contextOf(command), id, name),
    );
  pack
    .command('move <zasob> <pakiet>')
    .description('Przenosi zasob (rodzaj:id) do pakietu; zgoda nie przechodzi razem z nim')
    .action(async (key: string, target: string, _options: unknown, command: Command) =>
      moveCommand(contextOf(command), key, target),
    );
}
