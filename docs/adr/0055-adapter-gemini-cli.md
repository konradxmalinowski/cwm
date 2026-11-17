# ADR 0055: adapter Gemini CLI jako trzecie narzędzie

Status: zaakceptowane w zakresie planu (2026-11-17)
Data: 2026-11-17
Dotyczy: ADR 0004 (higiena fixture'ów), ADR 0013 (kontrakt adaptera), ADR 0020 (brak synchronizacji MCP), ADR 0021 (komendy), ADR 0022 (lokalizacje), ADR 0025 (blok między markerami), ADR 0054 (układy ZIP)
Źródło: plan `plans/2026-11-16-adapter-gemini-cli.md` (lokalny, poza repozytorium); kod w `src/adapters/gemini-cli/`

## Kontekst

Założenie 10 z wymagań: nowe narzędzia mają dochodzić przez rozszerzalną architekturę, bez przepisywania aplikacji.
Dwa adaptery nie dowodzą tego, bo kontrakt mógł wyrosnąć z ich wspólnych przypadków. Trzecim narzędziem jest Gemini CLI
(otwarte źródła, konfiguracja w plikach, udokumentowane formaty). Zasada 9: obsługujemy to, co jest w dokumentacji.

## Wyniki researchu

Dokumentacja czytana 2026-11-17 w repozytorium `github.com/google-gemini/gemini-cli` (gałąź main, najnowsze wydanie v0.68.0
z 2026-11-10, https://github.com/google-gemini/gemini-cli/releases/tag/v0.68.0). Etykieta [D] to fakt z dokumentacji,
[?] to coś, czego dokumentacja nie rozstrzyga i czego adapter nie zakłada.

| Fakt | Źródło | Etykieta |
|---|---|---|
| Komendy użytkownika: `~/.gemini/commands/`; projektu: `<projekt>/.gemini/commands/`, komenda projektu wygrywa | docs/cli/custom-commands.md | [D] |
| Nazwa komendy to ścieżka względem `commands/`, separator katalogu to `:` (`git/commit.toml` to `/git:commit`) | docs/cli/custom-commands.md | [D] |
| Pole `prompt` (wymagane) i `description` (opcjonalne; bez niego opis jest generowany z nazwy pliku) | docs/cli/custom-commands.md | [D] |
| `{{args}}` wstawia argumenty; bez niego pełna wpisana komenda jest doklejana do promptu po dwóch nowych liniach | docs/cli/custom-commands.md | [D] |
| `!{...}` uruchamia polecenie powłoki i wstawia jego wynik; narzędzie pyta o potwierdzenie z dokładnym poleceniem; argumenty w `!{}` są escapowane | docs/cli/custom-commands.md | [D] |
| `@{...}` wstawia treść pliku; ścieżki bezwzględne tylko w obrębie workspace; kolejność: `@{}`, potem `!{}`, potem `{{args}}` | docs/cli/custom-commands.md | [D] |
| Instrukcje: `~/.gemini/GEMINI.md` (globalny), pliki w workspace i rodzicach, ładowanie JIT | docs/cli/gemini-md.md | [D] |
| Nazwę pliku kontekstu zmienia `context.fileName` w `settings.json` (jeden napis albo lista), domyślnie `GEMINI.md`. Nazwa `contextFileName` z planu to stara nazwa i nie jest używana | docs/cli/gemini-md.md, docs/reference/configuration.md | [D] |
| Import w `GEMINI.md` przez `@plik.md` | docs/cli/gemini-md.md | [D] |
| Skille istnieją: `~/.gemini/skills/` lub alias `~/.agents/skills/`; w workspace `.gemini/skills/` lub `.agents/skills/`; alias ma pierwszeństwo nad `.gemini/skills/` | docs/cli/skills.md | [D] |
| `SKILL.md` z frontmatterem `name` ("powinno zgadzać się z nazwą katalogu") i `description` ("krytyczne"); opcjonalne `scripts/`, `references/`, `assets/` | docs/cli/creating-skills.md | [D] |
| Subagenci jako pliki `~/.gemini/agents/*.md` i `.gemini/agents/*.md`, frontmatter: `name` i `description` wymagane; `kind`, `tools`, `mcpServers`, `model`, `temperature`, `max_turns`, `timeout_mins` opcjonalne | docs/core/subagents.md | [D] |
| Przełącznik `experimental.enableAgents` (domyślnie `true`) | docs/reference/configuration.md | [D] |
| Czy format plików agentów jest stabilny (strona nie oznacza go jako eksperymentalny, ale przełącznik leży pod `experimental`) | docs/core/subagents.md | [?] |
| Hooki w `settings.json` pod kluczem `hooks`: zdarzenie to lista grup `{matcher, hooks[]}`; zdarzenia SessionStart, SessionEnd, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool, PreCompress, Notification | docs/hooks/index.md | [D] |
| Hook typu `command`: `command`, `name`, `timeout`, `description`; `type` obsługuje tylko `command` | docs/hooks/index.md | [D] |
| `timeout` hooka jest w milisekundach, domyślnie 60000 (w Claude Code i modelu kanonicznym: sekundy) | docs/hooks/reference.md | [D] |
| Matcher zdarzeń narzędzi to wyrażenie regularne dopasowane do nazwy narzędzia (`write_file\|replace`), narzędzia MCP to `mcp_<serwer>_<narzędzie>` | docs/hooks/reference.md | [D] |
| `settings.json`: użytkownik `~/.gemini/settings.json`, projekt `.gemini/settings.json`, system `/etc/gemini-cli/settings.json` i odpowiedniki | docs/reference/configuration.md | [D] |
| `GEMINI_CLI_HOME` wskazuje katalog nadrzędny, w którym CLI tworzy `.gemini` | docs/reference/configuration.md | [D] |
| Serwery MCP w `mcpServers` w `settings.json` (`command`, `args`, `env`, `url`, `httpUrl`, `headers`); `env` i `headers` mogą nieść sekrety | docs/reference/configuration.md | [D] |
| Rozszerzenia (extensions) Gemini CLI | nie czytane | [?] |
| Czy `~/.gemini/commands` przechodzi przez dowiązania symboliczne | brak w dokumentacji | [?] |
| Nazwy narzędzi Gemini CLI używane w matcherach inne niż `write_file`, `replace` i `read_.*` z przykładów | brak pełnej listy w czytanych stronach | [?] |

Strony czytane przez pobranie surowych plików `docs/` z gałęzi main; dokumentacja na geminicli.com nie była czytana
(repozytorium jest źródłem pierwotnym).

## Decyzje

1. **Zakres obsługiwany.** Skille (`~/.gemini/skills/<nazwa>/SKILL.md` z plikami pomocniczymi), agenci
   (`~/.gemini/agents/<nazwa>.md`), komendy (`~/.gemini/commands/<nazwa>.toml`), instrukcja globalna (`~/.gemini/GEMINI.md`,
   blok między markerami, ADR 0025) i hooki (klucz `hooks` w `~/.gemini/settings.json`, edycja tylko tego klucza jak w
   Claude Code).
2. **Root skilli tylko `~/.gemini/skills`.** Alias `~/.agents/skills` [D] jest współdzielony z Codeksem (ADR 0024), więc
   skill z tego katalogu byłby importowany dwa razy jako element dwóch narzędzi. Alias nie jest rootem Gemini CLI.
3. **Komendy TOML.** Importer czyta `prompt` jako treść i `description` jako opis (bez opisu: wyliczony, `derived`).
   Pozostałe klucze trafiają do `unmappedKeys` (`toml.<klucz>`) i wracają przy eksporcie do tego samego narzędzia.
   Eksport zapisuje opis tylko wtedy, gdy pochodzi ze źródła, a treść jako wielolinijkowy napis literalny.
4. **Poziomy zgodności.** Skill: pełna, gdy `name` i `description` są w źródle; `lossy`, gdy trzeba je dopisać.
   Komenda: `partial` przy polach obcych i przy `!{...}`; `lossy`, gdy treść używa składni Claude Code (`$ARGUMENTS`, `$1`,
   `` !`...` ``), której Gemini CLI nie zna. Treść nie jest tłumaczona: zostaje bez zmian i jest to wymienione jako
   utrata, a nie po cichu "naprawiane". Agent: `partial` (poziom rozumowania, kolor i pamięć nie mają odpowiednika; `model`
   przyjmuje nazwy modeli Gemini, więc nie jest wyliczany); `lossy` przy dopisaniu `name` lub `description`. Hook: pełna
   dla znanego zdarzenia bez matchera, `partial` dla obcego zdarzenia (narzędzie go nie uruchomi) i dla matchera.
5. **Wstawki powłoki i pliku, hooki: ostrzeżenie doradcze.** Komenda z `!{...}` (powłoka) albo `@{...}` (treść pliku do
   modelu) i każdy hook dostają ostrzeżenie przy imporcie (`command-runs-shell`, `command-reads-files`), powód w werdykcie
   (`partial`) i ostrzeżenie we wpisie planu eksportu. To jest ostrzeżenie doradcze, nie bramka blokująca: plan z takim
   wpisem zatwierdza się tak samo jak każdy inny, a aplikacja niczego nie uruchamia. Faktyczna bramka (osobne potwierdzenie
   elementów wykonywalnych) nie istnieje także dla hooków w obecnych adapterach i jest decyzją projektową na później.
6. **Czas hooka.** Model trzyma całkowite sekundy dodatnie, Gemini CLI milisekundy [D]. Adapter przelicza w obie strony przez
   parametr `timeoutPerSecond` wspólnego kodu hooków (1 dla pozostałych narzędzi). Import zaokrągla w górę do pełnej sekundy
   (minimum 1) z ostrzeżeniem `hook-timeout-rounded`; wartość niedodatnia lub nieskończona jest pomijana z ostrzeżeniem
   `hook-timeout-invalid`. Eksport zostawia oryginalne milisekundy ze snapshotu, gdy dają te same sekundy.
7. **MCP i sekrety.** Bez synchronizacji MCP (ADR 0020). `settings.json` jest czytany tylko w kluczu `hooks`; `mcpServers`
   z `env` i `headers` nie trafia do biblioteki.
8. **Lokalizacje.** `~/.gemini` z nadpisaniem `GEMINI_CLI_HOME` jako katalogiem nadrzędnym (etykieta
   `$GEMINI_CLI_HOME/.gemini/...`). W układzie ZIP katalog to `gemini-cli/.gemini/...`.

## Niewspierane mapowania (jawnie)

- Przestrzenie nazw komend (podkatalogi `commands/`): pominięte z `ImportSkip` i powodem, bez straty danych na dysku.
- Konfiguracje projektowe (`.gemini/` w projekcie): poza zakresem MVP (ADR 0032).
- Rozszerzenia, serwery MCP, `context.fileName`, `hooksConfig` i reszta `settings.json`: nie czytane i nie zapisywane.
- Pole `model`, `tools`, `mcpServers`, `temperature`, `max_turns`, `timeout_mins` agenta: zostają w snapshocie źródła i
  wracają tylko do Gemini CLI.
- Poziom rozumowania, kolor i pamięć agenta z innych narzędzi: nie mają odpowiednika, wymienione jako utracone.
- Tłumaczenie `$ARGUMENTS` na `{{args}}` i `` !`...` `` na `!{...}`: świadomie brak, bo przepisywanie treści zmienia sens
  bez wiedzy użytkownika.

## Wynik testu założenia 10: co trzeba było ruszyć poza `src/adapters`

Kontrakt (`ToolAdapter`, `ToolExporter`, model kanoniczny, `PlanBuilder`, `WriteGate`, serwisy importu, eksportu,
synchronizacji i ZIP) nie wymagał zmian. Ruszone miejsca, każde to tabela lub rejestr, który z definicji zna narzędzia:

| Miejsce | Powód |
|---|---|
| `src/core/model/item.ts` (`TOOL_IDS`) | identyfikator narzędzia w modelu; z niego wynika `ToolId` |
| `src/shared/ipc/import-contract.ts` (`ToolIdDto`) | ręcznie utrzymywana unia dla renderera |
| `src/infra/platform/locations.ts` | `CANDIDATES`, katalog bazowy `.gemini` i nadpisanie rodzicem (`GEMINI_CLI_HOME`); jedyne miejsce ze ścieżkami (ADR 0022) |
| `src/main/bootstrap/adapters.ts` | rejestr adapterów |
| `src/main/bootstrap/diagnostic-report.ts` | katalog `.gemini` na liście chronionych przed zapisem eksportu |
| `src/core/services/export/zip-export-service.ts` | prefiks etykiety `$GEMINI_CLI_HOME/` w ścieżce archiwum |
| `src/core/services/history/history-service.ts` | nazwa narzędzia w Historii (`Record<ToolId, string>`, kompilator wymusza wpis) |
| `src/core/services/diagnostics/report-redactor.ts` | segment `gemini` czytelny w raporcie diagnostycznym |
| `src/core/services/library/validate.ts` | treść ostrzeżenia o rozjazdzie nazwy ("Codex i Gemini CLI") |
| `src/renderer/app/features/import/import-model.ts`, `import-wizard.component.html` | etykieta, kolejność, tekst pustego stanu |
| `src/renderer/app/features/export/export-model.ts` | lista celów i układów ZIP, miejscownik |
| `src/adapters/shared/hooks.ts`, `shared/export/*` (wewnątrz `src/adapters`) | parametr jednostki czasu hooka i `renderCommandToml` |
| `tests/harness/isolation.ts` | `.gemini` w katalogach chronionych przed zapisem testów |

Wniosek: dodanie narzędzia wymaga wpisów w kilku tabelach, ale nie logiki w serwisach. Najbardziej uciążliwe są ręcznie
utrzymywane kopie listy narzędzi (`ToolIdDto`, etykiety renderera). Mogłyby powstać z jednego źródła; to osobna zmiana.

## Weryfikacja

Bez testów lokalnych (decyzja właściciela): kontrakty importu i eksportu z `tests/contract` dostały trzeci blok dla
Gemini CLI na fixture'ach w `tests/fixtures/gemini-cli/` (nazwy `acme-*`, ADR 0004), a higiena fixture'ów obejmuje nowe
katalogi. Dowodem jest CI na PR.

## Otwarte

- Blokująca bramka dla elementów wykonywalnych (hooki, komendy z `!{...}` i `@{...}`): osobne potwierdzenie przed zapisem.
  Dziś jest tylko ostrzeżenie doradcze w planie, tak samo jak dla hooków w pozostałych adapterach.
- Przestrzenie nazw komend (import i eksport podkatalogów) wymagają decyzji, jak nazwać slug (`git:commit`) i czy
  `WriteGate` tworzy zagnieżdżone katalogi w rootach katalogowych.
- Konfiguracje projektowe i rozszerzenia Gemini CLI.
- Zweryfikowanie zachowania narzędzia na prawdziwej instalacji (formaty pochodzą z dokumentacji, nie z uruchomienia).
