import type { LoadedItem, SecretFinding } from '../../model/item';
import { classifyStrict } from '../security/secret-classifier';

/**
 * Ponowny skan tresci elementu przy zapisie z edytora (ADR 0060). `secretFindings` z importu opisuje
 * stan sprzed edycji, a edycja moze dopisac sekret do tytulu, opisu albo tresci. Skan obejmuje to, co
 * uzytkownik wpisal, oraz pliki pomocnicze i snapshoty zrodla zapisanego elementu (edytor ich nie zmienia).
 * Wynik zastepuje stare wykrycia: usuniecie sekretu z tresci zdejmuje oznaczenie, dopisanie go dodaje.
 */
export function rescanFindings(
  content: { readonly title: string; readonly description: string; readonly body: string },
  previous: LoadedItem | null,
): SecretFinding[] {
  const encoder = new TextEncoder();
  const hits = classifyStrict([
    { relPath: 'body.md', bytes: encoder.encode(content.body) },
    { relPath: 'title', bytes: encoder.encode(content.title) },
    { relPath: 'description', bytes: encoder.encode(content.description) },
    ...(previous?.assets ?? []).map((a) => ({ relPath: `assets/${a.relPath}`, bytes: a.bytes })),
    ...(previous?.snapshotFiles ?? []).map((f) => ({
      relPath: `snapshots/${f.tool}/${f.relPath}`,
      bytes: f.bytes,
    })),
  ]);
  return hits.map((hit) => ({ rule: hit.rule, relPath: hit.relPath, line: hit.line }));
}
