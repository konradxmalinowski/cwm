import type { RetentionSettings } from '../../core/model/retention';
import type { ToolId } from '../../core/model/item';
import type { McpPreview } from '../../core/services/mcp/mcp-server';
import { redactSecrets } from '../../core/services/security/secret-redactor';

/**
 * Potwierdzenie operacji wysokiego ryzyka natywnym oknem w main (ADR 0063). Tresc okna powstaje
 * tutaj z danych, ktore main trzyma sam (plan, token podgladu, stan repozytorium), nigdy z ladunku
 * renderera. Modul nie zna Electrona: okno dostarcza port z `bootstrap/native-confirm.ts`.
 */

export interface ConfirmRequest {
  /** Pytanie w jednym zdaniu, pierwsza linia okna. */
  readonly message: string;
  /** Szczegoly po redakcji i z limitem dlugosci. */
  readonly detail: string;
  /** Czasownik na przycisku zgody. "Anuluj" jest zawsze przyciskiem domyslnym i odpowiedzia na Esc. */
  readonly confirmLabel: string;
}

export interface ConfirmPort {
  /** `true` tylko po wyborze przycisku zgody; zamkniecie okna i blad to odmowa. */
  confirm(request: ConfirmRequest): Promise<boolean>;
}

export const CANCEL_LABEL = 'Anuluj';
export const MAX_LINE_CHARS = 300;
export const MAX_SERVER_LINES = 24;

export const CONFIRM_CANCELLED_CODE = 'confirmation-cancelled';

/** Odpowiedz bez okna, tylko dla testow E2E; zmienna srodowiskowa ustawiana przez harness. */
export const TEST_CONFIRM_ENV = 'CWM_TEST_CONFIRM';

export type TestConfirmAnswer = 'accept' | 'cancel';

/**
 * Odpowiedz testowa obowiazuje wylacznie w aplikacji niezapakowanej (`app.isPackaged === false`).
 * Zapakowana binarka ignoruje zmienna, a renderer nie ma do niej dostepu.
 */
export function testConfirmAnswer(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): TestConfirmAnswer | null {
  if (isPackaged) return null;
  const value = env[TEST_CONFIRM_ENV];
  return value === 'accept' || value === 'cancel' ? value : null;
}

export function fixedConfirmPort(answer: TestConfirmAnswer): ConfirmPort {
  return { confirm: () => Promise.resolve(answer === 'accept') };
}

function isUnsafeChar(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x80 && code < 0xa0) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Jedna linia: znaki sterujace i kierunku tekstu na spacje, potem redakcja sekretow i limit dlugosci.
 * Sciezek nie redagujemy: polecenie serwera stdio ma byc widoczne w calosci, jak w podgladzie planu.
 */
export function confirmLine(text: string): string {
  let flat = '';
  for (const ch of text) flat += isUnsafeChar(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  const clean = redactSecrets(flat).text;
  if (clean.length <= MAX_LINE_CHARS) return clean;
  const rest = clean.length - MAX_LINE_CHARS;
  return `${clean.slice(0, MAX_LINE_CHARS)} ... (i ${rest} ${plural(rest, 'znak', 'znaki', 'znaków')} więcej)`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

const TOOL_NAMES: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

/** Serwery MCP z planu w main, zapamietane przy wydaniu znacznika (ADR 0061, ADR 0063). */
export interface McpConfirmSummary {
  readonly tool: ToolId;
  /** Nazwa projektu przy celu projektowym, `null` dla zakresu globalnego. */
  readonly project: string | null;
  readonly servers: readonly McpPreview[];
}

function serverLines(server: McpPreview): string[] {
  const kind = server.transport === 'stdio' ? 'uruchomi' : `${server.transport}, połączy się z`;
  const lines = [`${server.name} (${kind}): ${server.launch}`];
  for (const header of server.headers) lines.push(`  nagłówek ${header}`);
  for (const notice of server.headerNotices) lines.push(`  ${notice}`);
  if (server.env.length > 0) lines.push(`  zmienne: ${server.env.join(', ')}`);
  if (server.globalToProject === true) lines.push('  serwer globalny trafi do projektu');
  return lines;
}

export function mcpExportConfirmation(summary: McpConfirmSummary): ConfirmRequest {
  const count = summary.servers.length;
  const where =
    summary.project === null
      ? TOOL_NAMES[summary.tool]
      : `${TOOL_NAMES[summary.tool]}, projekt ${summary.project}`;
  // Pierwszy serwer zawsze, kolejne tylko w calosci, dopoki mieszcza sie w limicie linii.
  const lines: string[] = [];
  let shown = 0;
  for (const server of summary.servers) {
    const own = serverLines(server);
    if (shown > 0 && lines.length + own.length > MAX_SERVER_LINES) break;
    lines.push(...own.slice(0, MAX_SERVER_LINES).map(confirmLine));
    shown += 1;
  }
  const hidden = count - shown;
  if (hidden > 0) {
    lines.push(`i ${hidden} ${plural(hidden, 'serwer', 'serwery', 'serwerów')} więcej`);
  }
  return {
    message: confirmLine(
      `Zapisać ${count} ${plural(count, 'serwer', 'serwery', 'serwerów')} MCP do ${where}?`,
    ),
    detail: [
      'Serwer stdio uruchamia polecenie na tym komputerze przy starcie narzędzia, a serwer http i sse wysyła nagłówki pod podany adres.',
      '',
      ...lines,
    ].join('\n'),
    confirmLabel: 'Zapisz serwery MCP',
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

export function retentionCleanConfirmation(plan: {
  readonly entries: number;
  readonly objects: number;
  readonly bytes: number;
}): ConfirmRequest {
  return {
    message: `Usunąć trwale ${plan.entries} ${plural(plan.entries, 'wpis', 'wpisy', 'wpisów')} historii i ${plan.objects} ${plural(plan.objects, 'obiekt', 'obiekty', 'obiektów')}?`,
    detail: `Czyszczenie zwolni ${formatBytes(plan.bytes)}. Usuniętych wpisów i obiektów nie da się przywrócić, a cofnięcie tych operacji z widoku Historia przestanie być możliwe.`,
    confirmLabel: 'Usuń wpisy historii',
  };
}

function limitLine(
  label: string,
  unit: string,
  before: number | null,
  after: number | null,
): string | null {
  const show = (v: number | null): string => (v === null ? 'bez limitu' : `${v} ${unit}`);
  return before === after ? null : `${label}: ${show(before)} -> ${show(after)}`;
}

export function retentionTightenConfirmation(
  current: RetentionSettings,
  next: RetentionSettings,
): ConfirmRequest {
  const lines = [
    limitLine('Liczba wpisów', 'wpisów', current.maxEntries, next.maxEntries),
    limitLine('Wiek wpisu', 'dni', current.maxAgeDays, next.maxAgeDays),
    limitLine('Rozmiar historii', 'MiB', current.maxStoreMiB, next.maxStoreMiB),
  ].filter((l): l is string => l !== null);
  return {
    message: 'Zapisać ostrzejsze limity historii?',
    detail: [
      'Przy następnym starcie aplikacja bez pytania usunie wpisy historii i obiekty ponad nowe limity. Usuniętych nie da się przywrócić.',
      '',
      ...lines,
    ].join('\n'),
    confirmLabel: 'Zapisz limity',
  };
}

export function versioningPrivateConfirmation(privateItems: number): ConfirmRequest {
  return {
    message: 'Dołączyć elementy prywatne i projektowe do historii Git?',
    detail:
      `Elementy prywatne i projektowe bez wykrytego sekretu: ${privateItems}. Ich treść trafi do lokalnego repozytorium ` +
      'i zostanie w historii także po wycofaniu zgody, dopóki nie usuniesz katalogu repozytorium.',
    confirmLabel: 'Dołącz do historii',
  };
}
