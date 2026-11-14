import type { FieldChange, MemberFields, PackMemberFacts } from '../core/cwm';
import { print } from './context';

/** Pola wykonawcze czlonka w calosci (hooki, piny skryptow, `allowed-tools`, wstawki `!`): zgoda ma byc swiadoma. */
export function renderExec(facts: PackMemberFacts, indent = '    '): void {
  const exec = facts.fields.exec;
  if (exec === null) return;
  for (const [name, value] of Object.entries(exec)) {
    print(`${indent}${name}: ${JSON.stringify(value)}`);
  }
  for (const text of facts.warnings) print(`${indent}UWAGA: ${text}`);
}

export function renderChanges(changes: readonly FieldChange[], indent = '    '): void {
  for (const change of changes) {
    print(`${indent}${change.name}`);
    if (change.detail !== undefined) {
      for (const line of change.detail) print(`${indent}  ${line}`);
    } else {
      print(`${indent}  bylo: ${change.before ?? '(brak)'}`);
      print(`${indent}  jest: ${change.after ?? '(brak)'}`);
    }
  }
}

export const fieldsSummary = (fields: MemberFields): string =>
  `${fields.files.length + fields.filesMore} plikow, drzewo sha256:${fields.tree.slice(0, 12)}`;
