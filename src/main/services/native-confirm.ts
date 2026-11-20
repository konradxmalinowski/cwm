import type { RetentionSettings } from '../../core/model/retention';
import type { ToolId } from '../../core/model/item';
import type { McpPreview } from '../../core/services/mcp/mcp-server';
import { isInvisibleCodePoint } from '../../core/services/security/invisible-chars';
import { redactSecrets } from '../../core/services/security/secret-redactor';

/**
 * Potwierdzenie operacji wysokiego ryzyka natywnym oknem w main (ADR 0063). Tresc okna powstaje
 * tutaj z danych, ktore main trzyma sam (plan, token podgladu, stan repozytorium), nigdy z ladunku
 * renderera. Modul nie zna Electrona: okno dostarcza port z `bootstrap/native-confirm.ts`.
 */

export interface ConfirmRequest {
  /** Pytanie w jednym zdaniu, pierwsza linia okna. */
  readonly message: string;
  /** Szczegoly po redakcji, w calosci: okno nigdy nie prosi o zgode na tresc, ktorej nie pokazuje. */
  readonly detail: string;
  /** Czasownik na przycisku zgody. "Anuluj" jest zawsze przyciskiem domyslnym i odpowiedzia na Esc. */
  readonly confirmLabel: string;
}

/** `busy`: inne okno potwierdzenia jest otwarte, a ta prosba nie czeka w kolejce. */
export type ConfirmOutcome = 'accept' | 'cancel' | 'busy';

export interface ConfirmPort {
  /** `accept` tylko po zaznaczeniu pola i wyborze przycisku zgody; zamkniecie okna i blad to `cancel`. */
  confirm(request: ConfirmRequest): Promise<ConfirmOutcome>;
}

export const CANCEL_LABEL = 'Anuluj';
export const CHECKBOX_LABEL = 'Rozumiem skutki';

/** Budzet okna: przekroczenie oznacza odmowe operacji, nigdy skrocenie tresci. */
export const MAX_LINE_CHARS = 600;
export const MAX_DETAIL_LINES = 40;
export const MAX_DETAIL_CHARS = 6000;

export const CONFIRM_CANCELLED_CODE = 'confirmation-cancelled';
export const CONFIRM_TOO_LONG_CODE = 'confirmation-too-long';
export const CONFIRM_BUSY_MESSAGE =
  'Inne okno potwierdzenia jest otwarte. Zamknij je i spróbuj ponownie od podglądu albo planu.';

/** Zgoda wymaga przycisku zgody i zaznaczonego pola: przypadkowe podwojne klikniecie nie wystarczy. */
export function isAccepted(response: number, checkboxChecked: boolean): boolean {
  return response === 1 && checkboxChecked;
}

/**
 * Najwyzej jedno okno otwarte, bez kolejki: kolejna prosba w trakcie dostaje od razu `busy`, wiec
 * przejety renderer nie ustawi dziesiatek okien i nie trzyma blokady zapisu w oczekiwaniu.
 */
export function singleDialog(
  show: (request: ConfirmRequest) => Promise<{ response: number; checkboxChecked: boolean }>,
): ConfirmPort {
  let open = false;
  return {
    async confirm(request) {
      if (open) return 'busy';
      open = true;
      try {
        const result = await show(request);
        return isAccepted(result.response, result.checkboxChecked) ? 'accept' : 'cancel';
      } catch {
        return 'cancel';
      } finally {
        open = false;
      }
    },
  };
}

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

/** Ta sama sciezka co okno: odpowiedz jak klikniecie, z polem zaznaczonym tylko przy zgodzie. */
export function fixedConfirmPort(answer: TestConfirmAnswer): ConfirmPort {
  return singleDialog(() =>
    Promise.resolve(
      answer === 'accept'
        ? { response: 1, checkboxChecked: true }
        : { response: 0, checkboxChecked: false },
    ),
  );
}

/**
 * Jedna linia: znaki niewidoczne i sterujace na spacje (nie zlamia ukladu okna i nie odwroca tekstu),
 * potem redakcja sekretow. Sciezek nie redagujemy: polecenie serwera stdio ma byc widoczne w calosci.
 * Polecenia i adresu redakcja nie zmienia, bo core odmawia takiego serwera juz w planie (ADR 0061).
 */
export function confirmLine(text: string): string {
  let flat = '';
  for (const ch of text) flat += isInvisibleCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return redactSecrets(flat).text;
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

/** Ostrzezenia na poczatku bloku serwera, przed poleceniem. */
function serverLines(server: McpPreview): string[] {
  const lines = [`Serwer ${server.name}`];
  if (server.globalToProject === true) lines.push('  Uwaga: serwer globalny trafi do projektu.');
  for (const notice of server.headerNotices) lines.push(`  Uwaga: ${notice}`);
  lines.push(
    server.transport === 'stdio'
      ? `  uruchomi: ${server.launch}`
      : `  ${server.transport}, połączy się z: ${server.launch}`,
  );
  for (const header of server.headers) lines.push(`  nagłówek ${header}`);
  if (server.env.length > 0) lines.push(`  zmienne: ${server.env.join(', ')}`);
  return lines;
}

export type McpConfirmation =
  | { readonly ok: true; readonly request: ConfirmRequest }
  | { readonly ok: false; readonly reason: string };

/**
 * Okno z pelna trescia albo odmowa. Gdy linia, liczba linii albo calosc przekracza budzet okna, okna nie
 * ma: zgoda na tresc, ktorej uzytkownik nie widzi, nie jest zgoda.
 */
export function mcpExportConfirmation(summary: McpConfirmSummary): McpConfirmation {
  const count = summary.servers.length;
  const where =
    summary.project === null
      ? TOOL_NAMES[summary.tool]
      : `${TOOL_NAMES[summary.tool]}, projekt ${summary.project}`;
  const lines = summary.servers.flatMap((server, i) => [
    ...(i === 0 ? [] : ['']),
    ...serverLines(server).map(confirmLine),
  ]);
  const detail = [
    'Serwer stdio uruchamia polecenie na tym komputerze przy starcie narzędzia, a serwer http i sse wysyła nagłówki pod podany adres.',
    '',
    ...lines,
  ].join('\n');
  const longest = Math.max(0, ...lines.map((l) => l.length));
  if (
    longest > MAX_LINE_CHARS ||
    lines.length > MAX_DETAIL_LINES ||
    detail.length > MAX_DETAIL_CHARS
  ) {
    return {
      ok: false,
      reason:
        `Okno potwierdzenia nie zmieści pełnej treści tego planu (${count} ${plural(count, 'serwer', 'serwery', 'serwerów')} MCP, najdłuższa linia ${longest} znaków), a aplikacja nie prosi o zgodę na treść, której nie pokazuje. ` +
        'Nic nie zostało zapisane. Eksportuj mniej serwerów MCP w jednym planie albo skróć polecenie serwera w narzędziu źródłowym i zaimportuj go ponownie.',
    };
  }
  return {
    ok: true,
    request: {
      message: confirmLine(
        `Zapisać ${count} ${plural(count, 'serwer', 'serwery', 'serwerów')} MCP do ${where}?`,
      ),
      detail,
      confirmLabel: 'Zapisz serwery MCP',
    },
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
