# ADR 0020: Brak automatycznej synchronizacji serwerów MCP

Status: częściowo zastąpione przez ADR 0061 (import i jawny eksport serwerów MCP). Zakaz synchronizacji i MCP w
profilach obowiązuje dalej.
Data: 2026-10-20

## Kontekst

Wymagania mówią wprost: "Bez automatycznej synchronizacji MCP między narzędziami, dopóki nie
zostaną zaprojektowane reguły bezpieczeństwa i zakresów. Konfiguracja globalna i projektowa muszą
być rozróżniane; nie przenosić automatycznie serwerów MCP specyficznych dla jednego środowiska
do konfiguracji globalnej drugiego narzędzia".

Potwierdzone odczytem, co ten zakaz uzasadnia technicznie:

- Claude Code ma MCP w dwóch zakresach: globalnym (`mcpServers` w `~/.claude.json`) i projektowym
  (`.mcp.json` w katalogu projektu, z flagami włączenia per projekt).
- Codex ma MCP **wyłącznie globalnie**. `[projects."<ścieżka>"]` w `config.toml` trzyma jedno
  pole: `trust_level`. Sprawdzone na żywym pliku.
- Konfiguracje MCP zawierają dane uwierzytelniające albo odniesienia do nich. W audytowanym
  `config.toml` jest sekcja `mcp_servers.*.env`.
- Codex nie rozwija zmiennych środowiskowych w `mcp_servers.*.env` i nie przekazuje środowiska
  rodzica serwerom MCP, nawet przy `shell_environment_policy.inherit=all`. Właściwy mechanizm to
  `env_vars = [ "NAZWA" ]`. Serwer przeniesiony mechanicznie z jednego narzędzia do drugiego
  nie dostanie swoich zmiennych i albo nie wstanie, albo wstanie bez uwierzytelnienia.

## Rozważane opcje

**Synchronizować MCP jak każdy inny element.** Technicznie niemożliwe bez utraty semantyki:
serwer projektowy z Claude'a nie ma gdzie wylądować w Codeksie poza zakresem globalnym, co
oznacza udostępnienie go wszystkim projektom. To jest zmiana granicy bezpieczeństwa wykonana
w imieniu użytkownika.

**Synchronizować tylko serwery globalne.** Mniejsze ryzyko, ale nadal przenosi dane
uwierzytelniające między narzędziami i nadal rozjeżdża się na mechanizmie przekazywania zmiennych
środowiskowych.

**Importować do podglądu, nie eksportować.**

## Decyzja

Serwery MCP są typem elementu (`tool-setting` z zakresem) i mają poziom zgodności `unsupported`
dla eksportu. Konkretnie:

- **Import:** tak, do podglądu i diagnostyki. Użytkownik widzi, co gdzie ma skonfigurowane,
  i to jest realna wartość, bo dziś tego nie widzi w jednym miejscu.
- **Treść wrażliwa:** wartości z `env` i wszystko, co klasyfikator oznaczy, nie wchodzi do
  biblioteki i nie trafia do podglądu diffa. Importowana jest struktura (nazwy serwerów, komendy,
  zakres), nie sekrety.
- **Eksport i synchronizacja:** zablokowane, z czytelnym powodem. Nie "nie zaimplementowano",
  ale "przeniesienie zmieniłoby zakres z projektowego na globalny i nie przeniosłoby zmiennych
  środowiskowych".
- **Profile** nie mogą zawierać serwerów MCP. Wymaganie: "Profile nie mogą przypadkowo przenosić
  prywatnych sekretów ani konfiguracji specyficznych dla środowiska".

## Konsekwencje

Użytkownik, który oczekuje synchronizacji MCP, dostanie odmowę z wyjaśnieniem. To jest zgodne
z wymaganiami i z zasadą, że nie udajemy poprawnej konwersji.

Odblokowanie wymaga zaprojektowania reguł zakresów i bezpieczeństwa, czyli osobnego ADR
i osobnego etapu. Nie jest to zadanie na "kiedyś przy okazji", bo dotyczy granicy zaufania.

Diagnostics zyskuje funkcję, która sama w sobie jest przydatna: zestawienie, które serwery MCP
są zdefiniowane gdzie, i które z nich mają konfigurację niekompletną po stronie zmiennych
środowiskowych.
