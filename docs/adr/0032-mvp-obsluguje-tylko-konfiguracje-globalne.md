# ADR 0032: MVP obsługuje tylko konfiguracje globalne

Status: zaakceptowane (odpowiedź właściciela produktu na pytanie 5 z Etapu 0, 2026-11-03)
Data: 2026-11-03
Doprecyzowuje: ADR 0022 (zakres tabeli lokalizacji)
Źródło: ARCHITECTURE 15.1, pytanie 5

## Kontekst

Wymagania mówią o bibliotece z instrukcjami projektowymi, ale Etapy 1 do 5 niczego takiego
nie wyróżniały. Pytanie brzmiało, czy MVP obsługuje konfiguracje projektowe (`CLAUDE.md`
i `AGENTS.md` w repozytoriach, `.mcp.json`), czy tylko globalne. Odpowiedź zmienia dwie
rzeczy: tabelę lokalizacji w Etapie 3 (konfiguracje projektowe nie mają stałej ścieżki,
więc potrzebny byłby wybór katalogu przez użytkownika) i model zakresów (element projektowy
nie może trafić do profilu ani do eksportu poza swój projekt).

## Rozważane opcje

**Globalne i projektowe w MVP.** Pełna wizja, ale każdy import projektowy otwiera pytania,
na które MVP nie odpowiada: skąd aplikacja zna listę projektów, co robi z repozytorium
zmienianym równolegle przez narzędzie, jak nie przenieść instrukcji jednego projektu
do drugiego. Zapis do repozytorium użytkownika jest też zapisem w miejscu, które trafia do Gita.

**Tylko globalne.**

## Decyzja

MVP obsługuje wyłącznie konfiguracje globalne: `~/.claude` (z `CLAUDE_CONFIG_DIR`),
`~/.codex` (z `CODEX_HOME`) i wspólny `~/.agents`. Konfiguracje projektowe przychodzą po MVP.

Trzy odpowiedzi z ARCHITECTURE 2.4:

- **Kto to wykonuje.** Tabela `CANDIDATES` w `src/infra/platform/locations.ts` jest jedynym
  miejscem, które zna ścieżki narzędzi (ADR 0022). Zawiera wyłącznie ścieżki pod trzema
  katalogami domowymi narzędzi. Renderer nie podaje żadnej ścieżki (ARCHITECTURE 7.2, reguła 1),
  więc nie ma kanału, którym użytkownik mógłby wskazać repozytorium.
- **Co się dzieje, gdy się nie da.** Plik projektowy położony w repozytorium nie jest
  wykrywany ani skanowany. Aplikacja nie zgłasza go jako błędu, bo nie jest jej rootem.
  Pole `classification.scope` elementu przyjmuje `project`, bo użytkownik może je wybrać
  w formularzu, ale to tylko etykieta: import ustawia `private`, żadna ścieżka odczytu nie
  sięga do repozytoriów, a ścieżki zapisu prowadzą wyłącznie do katalogów globalnych.
  Element z etykietą `project` eksportuje się do katalogu globalnego tak jak każdy inny,
  bo blokadę dla elementów projektowych dostają dopiero profile (ROADMAP Etap 7, kryterium 4).
- **Czy da się do tego dojść.** Nie da się, i to jest cel: dodanie roota projektowego wymaga
  wpisu w `CANDIDATES` i nowego kanału wyboru katalogu, czyli zmiany tej decyzji nowym ADR.

## Konsekwencje

Pozycja "Konfiguracje projektowe" w backlogu ROADMAP przestaje być warunkowa: jest zaplanowana
po MVP. Wartość `project` w `ItemScope` zostaje w modelu, żeby przyszły import projektowy
nie wymagał migracji elementów. Do tego czasu nic jej nie egzekwuje poza etykietą, więc
użytkownik nie powinien traktować jej jako zabezpieczenia przed eksportem.

Użytkownik, który trzyma instrukcje w repozytoriach, nie dostanie ich w bibliotece. To jest
koszt tej decyzji i jest do zakomunikowania w README przy opisie zakresu.
