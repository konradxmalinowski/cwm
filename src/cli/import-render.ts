import {
  targetNamespace,
  WriteDeniedError,
  type ImportPlan,
  type PackImportPlan,
  type PlanFlagged,
  type PlanItem,
  type ReportItem,
} from '../infra/cwm';
import { AtomicWriteError } from '../infra/fs/atomic';
import { errnoCode } from '../infra/fs/store-error';
import { print, table } from './context';
import { renderExec } from './pack-render';

export const STATUS_LABEL = { new: 'nowy', changed: 'zmieniony', unchanged: 'bez zmian' } as const;
export const REPORT_LIMIT = 40;

export function describeWriteError(error: unknown): string {
  if (error instanceof WriteDeniedError) return error.message;
  if (error instanceof AtomicWriteError) return `zapis odrzucony: ${error.message}`;
  return `blad zapisu (${errnoCode(error) ?? 'nieznany'})`;
}

export function flaggedLine(entry: PlanFlagged): string {
  const where = entry.line === null ? '' : ` (wiersz ${entry.line})`;
  const state = entry.hard ? 'zawsze pominiety' : entry.included ? 'dolaczony' : 'pominiety';
  return `${entry.path}${where}: ${entry.reason} [${state}]`;
}

export function remarks(item: PlanItem): string {
  const parts: string[] = [];
  if (item.status === 'changed' && item.changes.length > 0) {
    parts.push(`zmieniono: ${item.changes.join(', ')}`);
  }
  if (item.flags.allowedTools) parts.push('narzedzia (tools/allowed-tools)');
  if (item.flags.inlineCommands) parts.push('wstawki ! (polecenia przy wczytaniu)');
  return parts.join('; ');
}

export function renderPlan(
  plan: ImportPlan,
  from: string,
  emptyText = 'Brak zasobow do zaimportowania.',
): void {
  const where = plan.target.scope === 'global' ? 'global' : `firma ${plan.target.company}`;
  print(`Zrodlo: ${from}`);
  print(`Przestrzen: ${where}`);
  if (plan.items.length === 0) print(emptyText);
  else {
    print('');
    print(
      table([
        ['RODZAJ', 'ID', 'STATUS', 'UWAGI'],
        ...plan.items.map((item) => [item.kind, item.id, STATUS_LABEL[item.status], remarks(item)]),
      ]),
    );
  }
  if (plan.items.length > 0) {
    print('');
    print('Pochodzenie (zrodlo po realpath, skrot kopiowanego drzewa):');
    for (const item of plan.items) {
      print(`  ${item.id}: ${item.source} sha256:${item.sha256}`);
    }
  }
  if (plan.flagged.length > 0) {
    const open = plan.flagged.filter((f) => !f.hard && !f.included).length;
    print('');
    print(
      `Oznaczone pliki (mozliwy sekret, ${plan.flagged.length}; do przegladu ${open}, twardych ${plan.flagged.filter((f) => f.hard).length}):`,
    );
    for (const entry of plan.flagged.slice(0, REPORT_LIMIT)) print(`  ${flaggedLine(entry)}`);
    if (plan.flagged.length > REPORT_LIMIT) {
      print(`  ... i ${plan.flagged.length - REPORT_LIMIT} wiecej (uzyj --json)`);
    }
    if (open > 0) print('  Dolaczenie: --include-flagged <sciezka> albo wybor na terminalu.');
  }
  const report: ReportItem[] = [...plan.items.flatMap((item) => item.notes), ...plan.skipped];
  if (report.length > 0) {
    print('');
    print(`Raport (${report.length}):`);
    for (const entry of report.slice(0, REPORT_LIMIT)) print(`  ${entry.item}: ${entry.reason}`);
    if (report.length > REPORT_LIMIT)
      print(`  ... i ${report.length - REPORT_LIMIT} wiecej (uzyj --json)`);
  }
}

const TRUST_LABEL = { approved: 'zatwierdzony', new: 'nowy', changed: 'zmieniony' } as const;
const DEFINITION_LABEL = { new: 'nowy', changed: 'zmieniony', same: 'bez zmian' } as const;

/** Zasoby z polami wykonawczymi, ktorych zgoda przy imporcie jest jeszcze do udzielenia. */
export function approvalCount(packs: PackImportPlan): number {
  return packs.packs
    .flatMap((pack) => pack.members)
    .filter((member) => member.derived.facts.required && member.trust !== 'approved').length;
}

/** Pakiety i pola wykonawcze ich czlonkow w calosci: potwierdzenie importu jest zgoda (ADR 0044). */
export function renderPacks(packs: PackImportPlan): void {
  if (packs.packs.length === 0 && packs.problems.length === 0) return;
  print('');
  print(
    'Pakiety (potwierdzenie importu zatwierdza je; cwm start nie pyta o zasoby, ktorych tresc i pola wykonawcze sie nie zmienily).',
  );
  print(
    '/cwm-pack-profile w polach to katalog profilu firmy, na ktory cwm start przepisuje odwolania do ~/.claude.',
  );
  for (const pack of packs.packs) {
    const required = pack.members.filter((member) => member.derived.facts.required);
    const plain = pack.members.length - required.length;
    print('');
    print(
      `  ${pack.id}: ${pack.members.length} zasobow, definicja ${DEFINITION_LABEL[pack.definition]}${pack.pending ? '' : ', zgoda aktualna'}`,
    );
    if (pack.corrupt !== null) {
      print(`    UWAGA: ${pack.corrupt} Zgody tego pakietu nie da sie zapisac.`);
    }
    if (plain > 0) print(`    ${plain} zasobow bez pol wykonawczych (tylko skrot drzewa)`);
    for (const member of required) {
      print(
        `    ${member.key} [${TRUST_LABEL[member.trust]}] sha256:${member.derived.facts.fields.tree.slice(0, 12)}`,
      );
      renderExec(member.derived.facts, '      ');
      for (const text of member.derived.facts.blockers) {
        print(
          `      UWAGA: zgoda pakietu go nie obejmie (${text}); cwm start zapyta o zgode firmy`,
        );
      }
      for (const rel of member.derived.profileRels) {
        const bound = member.derived.facts.fields.bindings.find((b) => b.rel === rel);
        const who =
          bound === undefined
            ? 'wlasny plik zasobu'
            : bound.owner === null
              ? 'wlasciciel ustalany przy starcie (cwm start zapyta, jesli go nie ma w pakiecie)'
              : `wlasciciel ${bound.owner}`;
        print(`      skrypt hooka w profilu: ${rel}: ${who}`);
      }
    }
  }
  for (const problem of packs.problems.slice(0, REPORT_LIMIT)) print(`  Pakiety: ${problem}`);
}

export function packsJson(packs: PackImportPlan) {
  return packs.packs.map((pack) => ({
    id: pack.id,
    definition: pack.definition,
    pending: pack.pending,
    members: pack.members.map((member) => ({
      key: member.key,
      status: member.status,
      trust: member.trust,
      required: member.derived.facts.required,
      tree: member.derived.facts.fields.tree,
      exec: member.derived.facts.fields.exec,
      warnings: member.derived.facts.warnings,
    })),
  }));
}

export function planJson(plan: ImportPlan, from: string) {
  return {
    from,
    target: plan.target.scope === 'global' ? { scope: 'global' } : plan.target,
    namespace: targetNamespace(plan.target),
    items: plan.items.map((item) => ({
      kind: item.kind,
      id: item.id,
      status: item.status,
      changes: item.changes,
      flags: item.flags,
      notes: item.notes,
      source: item.source,
      sha256: item.sha256,
    })),
    skipped: plan.skipped,
    flagged: plan.flagged,
  };
}
