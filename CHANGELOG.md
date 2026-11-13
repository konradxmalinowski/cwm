# Dziennik zmian

Wszystkie istotne zmiany w projekcie są zapisane w tym pliku.

Format opiera się na [Keep a Changelog 1.1.0](https://keepachangelog.com/pl/1.1.0/), a
numeracja wersji na [Semantic Versioning](https://semver.org/lang/pl/).

## [Unreleased]

Zmiany scalone do `main` (PR #1), przygotowane na v0.2.0 (ADR 0035). Numer wersji w
`package.json` zmieni się przy wydaniu.

### Added

- Polecenie `cwm` (CLI, gałąź `feat/cwm-cli`, jeszcze niescalona; ADR 0038, `docs/CLI.md`):
  `init`, `company add` i `company list`, `project create`, `project attach` i `project list`,
  `resource list`, `resolve` i `doctor`. Czyta i waliduje dane w `~/.cwm` (albo `CWM_HOME`),
  zapisuje tylko tam i w `<projekt>/.cwm` i nie rusza `.claude/`, `CLAUDE.md` ani `.mcp.json`.
  Manifest projektu może leżeć w projekcie (`--store local`) albo w `~/.cwm` (`--store home`).
  Nowe zależności, przypięte dokładnie: `commander` 15.0.0 i `@clack/prompts` 1.8.1. Nie ma
  jeszcze `start`, `sync`, `diff` ani `run`.
- Polecenie `cwm import claude` (gałąź `feat/cwm-start`, jeszcze niescalona; ADR 0039,
  `docs/CLI.md`): kopiuje do rejestru CWM skille, agentów, komendy i `settings.json` z natywnego
  katalogu Claude Code (domyślnie `~/.claude`), tylko do odczytu źródła, do firmy (`--company`) albo
  do przestrzeni wspólnej (`--global`). Pokazuje plan i raport (`--dry-run`), a zapis wymaga
  potwierdzenia na terminalu. Pomija dowiązania symboliczne, pliki wyglądające na sekrety i
  frontmatter uruchamiający kod; sekrety w `env` zamienia na `envRef`; niczego nie uruchamia.
- Polecenia `cwm start` i `cwm approvals` (gałąź `feat/cwm-run`, jeszcze niescalona; ADR 0040,
  `docs/CLI.md`): `start` składa konfigurację projektu, wymaga zatwierdzenia zasobów z polami
  wykonawczymi (zapamiętanego po skrócie w `~/.cwm/approvals/`), generuje profil firmy w
  `~/.cwm/runtime/<firma>/` i uruchamia Claude Code z `CLAUDE_CONFIG_DIR` profilu, z oczyszczonym
  środowiskiem i bez możliwości obejścia polityki przez argumenty. `--dry-run` pokazuje plan bez
  zapisu. `approvals list` i `approvals revoke` zarządzają zatwierdzeniami i unieważniają profil.
  Nowa opcja firmy `runtime` (`isolation`, `claude.path`, `env.passthrough`). Zatwierdzenie
  obejmuje m.in. plik polecenia MCP i zawartość pluginów; `node:child_process` jest dozwolony tylko
  w dwóch plikach (reguła ESLint z próbami granic).
  - Skan pluginu `local` znajduje `hooks/hooks.json`, `.mcp.json`, `.lsp.json` i `plugin.json` bez
    rozróżniania wielkości liter. Odwołania manifestu poza drzewo pluginu, do brakujących plików lub
    ze złym typem oraz nieznane klucze `plugin.json` są błędami. Odwołania `hooks`, `mcpServers`,
    `lspServers`, `commands`, `agents`, `skills` i `outputStyles` wchodzą do zatwierdzenia.
  - Zatwierdzenie serwera MCP ma klucz `mcp:<id>@<skrót-projektu>` (katalog projektu w skrócie)
    tylko dla polecenia-ścieżki; dla polecenia z `PATH` katalog projektu to `null` i klucz bez
    przyrostka. Sprzątanie wpisów w `approvals` zdejmuje przyrostek. Wygenerowany `mcp.json` ma
    bezwzględną ścieżkę polecenia po `realpath`.
  - Zakazane podpolecenia silnika w `cwm start -- ...` obejmują aliasy (`plugins`, `upgrade`,
    `kill` i pozostałe z `claude --help`), także gdy nie są pierwszym argumentem.
  - Ostrzeżenia zasobów już zatwierdzonych są wypisywane przed pytaniami o zatwierdzenie.
  - Izolacja od zasobów konta claude.ai jest domyślnie włączona (`runtime.isolation: false` ją
    wyłącza), a `SSH_AUTH_SOCK` jest domyślnie usuwany ze środowiska silnika (powrót przez
    `runtime.env.passthrough`).
- Rodzaje zasobów `Settings` (hooki typu `command`, uprawnienia, zmienne `env`, `enforce`) i
  `Command` w modelu CWM (rozszerzenie specyfikacji, ADR 0039), z kluczami `commands` i `settings`
  w zbiorach zasobów oraz scalaniem wielu `Settings` w `cwm resolve`.
- Weryfikacje Claude Code 2.1.322 na żywo (V-01 do V-08) w dodatku do ADR 0036.
- Rdzeń warstwy CWM: model manifestów firmy, projektu i zasobów (skill, agent, workflow, plugin,
  MCP), ręczne walidatory, resolver składający konfigurację z warstw global, firma, projekt i
  importy oraz parser manifestów YAML (nowa zależność `yaml`). Wewnętrzne, jeszcze niepodłączone
  do aplikacji (ADR 0037).
- Jednorazowa migracja danych z v0.1.0 przy pierwszym starcie: biblioteka, historia i kopie
  zapasowe są kopiowane do nowego katalogu danych, a stary katalog zostaje nietknięty. Jawne
  `--user-data-dir` wyłącza migrację.
- Okno dialogowe, gdy migracja się nie uda albo gdy działa v0.1.0. Pozwala zamknąć aplikację
  (następny start ponowi próbę) albo zacząć z pustą biblioteką.
- Rozpoznawanie bloku ze starym oznaczeniem `ai-skills-manager` w `CLAUDE.md` i `AGENTS.md`.
  Synchronizacja proponuje przepisać go na nowe oznaczenie przez zwykły plan, z zatwierdzeniem
  i kopią zapasową.
- Odczyt kopii zapasowych w formacie `uasm-backup` z v0.1.0.
- Rozpoznawanie dowiązań utworzonych przez v0.1.0 jako własnych dowiązań aplikacji, więc
  eksport i cofnięcie działają na nich od razu.
- `cwm import claude` i `cwm start` na prawdziwej konfiguracji (Etap C, ADR 0041, `docs/CLI.md`):
  - Dowiązania symboliczne, których cel leży wewnątrz `--from` (skille instalowane przez narzędzia
    jako dowiązania), są śledzone, a do rejestru trafia kopia treści. Cele poza `--from` i w
    pominiętych obszarach nadal są pomijane z raportem.
  - Pliki pomocnicze z trafieniem klasyfikatora sekretów trafiają do przeglądu w planie (ścieżka,
    powód, wiersz) zamiast być pomijane po cichu. Na terminalu wielokrotny wybór (domyślnie żaden),
    bez terminala `--include-flagged <ścieżka>`. Twardych sekretów (klucz prywatny, `AKIA`, `sk-`,
    tokeny GitHub/GitLab/Slack, JWT, adres z hasłem) nie da się dołączyć.
  - Nowy rodzaj zasobu `Files` (wspólne pliki: `.md` w `skills/`, katalogi bez `SKILL.md`,
    podkatalogi `agents/`) i klucz `files` we wszystkich zbiorach zasobów. Profil zapisuje je w
    `claude/<skills|agents>/<ścieżka>`.
  - Frontmatter agenta zachowuje `memory` (`user`, `project`, `local`) i `color`.
  - `cwm start` przepisuje w kopiach skilli, agentów, komend i `Files` odwołania do `~/.claude`,
    `$HOME/.claude` i ścieżki katalogu domowego na ścieżkę profilu; hooki bez zmian.
  - Poprawka bezpieczeństwa: frontmatter skilli, agentów, komend i plików `Files` jest
    odtwarzany bez pustego bloku (`name:` albo brak nagłówka), a treść zaczynająca się od drugiego
    bloku `---` albo od prologu w kształcie YAML zakończonego `---` jest odrzucana. Wcześniej drugi blok mógł trafić do silnika bez analizy (`hooks`, `permissionMode`).
  - `settings.json`: import `attribution` (`commit`, `pr`) i preferencji `theme`, `tui`, `voice`,
    `voiceEnabled`, `preferredNotifChannel`, `enableWorkflows`. `skipDangerousModePermissionPrompt`
    jest nadal odrzucany.

- Hooki w frontmatterze skilla (ADR 0042): skill może
  deklarować `hooks` (także `statusMessage`), ale tylko za zatwierdzeniem. Walidacja jak w Settings,
  profil dostaje hooki odtworzone ze zwalidowanego modelu, `cwm start` zawsze pyta o taki skill i
  pokazuje hooki oraz piny skryptów w całości, a `cwm import claude` je zachowuje z adnotacją
  "hooki skilla: wymaga zatwierdzenia". Agenci, komendy i pliki wspólne nadal odrzucają `hooks`;
  `permissionMode` i `mcpServers` są odrzucane także w skillu.
- Piny skryptów hooków (skille, Settings, pluginy) są liczone po zebraniu całego planu `cwm start`.
  Wcześniej skrypt zapisywany przez zasób przetwarzany później był pinowany starą kopią z profilu,
  więc jego zmiana mogła przejść bez ponownego pytania. Zatwierdzenia z pinem w profilu CWM zapytają
  raz ponownie.
- Pluginy z lokalnego marketplace'u w `cwm start` (Etap D, ADR 0043, `docs/CLI.md`): zasób `Plugin`
  z `source.type: marketplace` jest rozwiązywany z katalogu zarejestrowanego w opcjonalnym polu
  `marketplaces` w `~/.cwm/config.yaml` (stare pliki pozostają poprawne). Nowe polecenia
  `cwm marketplace add`, `list`, `remove` i `show`. Plan czyta `.claude-plugin/marketplace.json`
  (limit 512 KiB, ostra walidacja), wymaga `source` w postaci `./sciezka` wewnątrz katalogu
  marketplace'u (bez `..`, dowiązań, źródeł `github`/`url`/`git`/`npm`), odrzuca nazwy spoza ASCII i
  kolizje po `foldName`, a katalog marketplace'u musi należeć do użytkownika i nie być zapisywalny
  dla grupy ani innych. Dalej plugin przechodzi tę samą drogę co `local` (migawka, skan, piny,
  zatwierdzenie); pola zatwierdzenia dostają nazwę marketplace'u, wpisu, `source` i rozwiązaną
  ścieżkę, więc ich zmiana pyta ponownie. Skróty pluginów `local` się nie zmieniają. Rozjazd
  `version` w `plugin.json` i zasobie to ostrzeżenie. Nie ma `cwm plugin add`: manifest zasobu
  zapisuje się ręcznie (gotowy tekst wypisuje `cwm marketplace show <nazwa> <plugin>`).
  - Poprawka bezpieczeństwa (także pluginy `local`): polecenie hooka, `command`, `args`,
    `headersHelper` i `cwd` serwera MCP/LSP z `CLAUDE_PLUGIN_ROOT` i `..` (także zakodowanym) jest
    błędem skanu; wcześniej taki skrypt poza migawką nie był pinowany skrótem. Ścieżki
    bezwzględne i `~` w `command`, `args` i `headersHelper` serwerów pluginu są teraz pinowane, więc
    zatwierdzenia pluginów z takimi ścieżkami zapytają raz ponownie (skróty pozostałych bez zmian).
    Drzewa pluginów odrzucają pliki z wieloma twardymi dowiązaniami. `cwm marketplace` ogranicza
    długość `source`, odrzuca znaki sterujące i escapuje teksty z pliku.

### Changed

- Zsyntetyzowana nazwa agenta (gdy żaden klucz frontmattera nie przeżyje) przechodzi kontrolę
  duplikatów nazw agentów przy `cwm start`.

- Nowa nazwa produktu: CWM - Claude Workspace Manager (dawniej Universal AI Skills Manager).
  Nazwa techniczna to `cwm`: pakiet npm, pliki wydania `cwm-<wersja>-...`, zmienne środowiskowe
  `CWM_*`.
- Katalog danych to `<appData>/CWM`.
- Blok w `CLAUDE.md` i `AGENTS.md` jest oznaczony `cwm:start` i `cwm:end`.
- Nowe kopie zapasowe mają format `cwm-backup`.
- Na Linuksie pakiet deb i polecenie nazywają się `claude-workspace-manager`, bo Debian ma już
  pakiet `cwm`.
- Nowy identyfikator aplikacji (`io.github.konradxmalinowski.cwm`). Na Windowsie v0.2.0
  instaluje się obok v0.1.0 zamiast ją aktualizować, więc najpierw odinstaluj v0.1.0. Dane
  zostają i są migrowane.
- Repozytorium zmienia nazwę na `konradxmalinowski/cwm`. Stare adresy GitHub przekierowuje.
- Klasyfikator sekretów rozpoznaje więcej nazw plików: `secrets.yaml`, `secrets.yml`,
  `secrets.json`, `kubeconfig`, `.pgpass`, `.htpasswd`, `token.txt`, `service-account*.json` oraz
  rozszerzenia `.tfstate` i `.tfvars`. Dotyczy też aplikacji desktopowej: pliki o takich nazwach
  są traktowane jak potencjalne sekrety przy skanowaniu importu i w redakcji podglądu różnic.
  Nowa, ostrzejsza reguła liniowa (`hasło/token/klucz = wartość`) działa tylko w `cwm import`.
- Walidator serwerów MCP w warstwie CWM odrzuca znak `$` także w `args` i `url` (wcześniej tylko w
  `command`), bo silnik rozwija `${...}`. Sekrety przekazuje się przez `envRef`.

Powrót do v0.1.0 po synchronizacji w nowej wersji nie jest bezstratny: stara wersja nie
rozpozna bloku `cwm:*` ani kopii `cwm-backup` i dopisze własny blok obok.

## [0.1.0] - 2026-11-11

Pierwsze publiczne wydanie, pod nazwą Universal AI Skills Manager. Wydanie jest niepodpisane
(ADR 0003), więc macOS i Windows ostrzegą przy pierwszym uruchomieniu. Każde wydanie ma plik
`SHA256SUMS`.

### Added

- Aplikacja desktopowa na macOS, Windows i Linux, bez backendu i bez kont. Biblioteka to zwykłe
  pliki w katalogu danych aplikacji.
- Biblioteka skilli, agentów, komend, instrukcji globalnych i hooków: tworzenie, edycja,
  usuwanie z planem i potwierdzeniem, wyszukiwanie w indeksie pełnotekstowym SQLite z filtrowaniem
  po nazwie, tytule, opisie i treści, gdy indeks jest niedostępny.
- Import z `~/.claude`, `~/.codex` i wspólnego `~/.agents` z podglądem, wykrywaniem duplikatów i
  różnic. Elementy z potencjalnym sekretem są domyślnie odznaczone, a źródło nie jest
  modyfikowane.
- Eksport do Claude Code i OpenAI Codex z planem zapisu, podglądem różnic bez sekretów,
  ostrzeżeniami o utracie zgodności przy konwersji i potwierdzeniem. Przed zapisem powstaje kopia
  w `backups/`, po zapisie plik jest czytany z powrotem.
- Synchronizacja: stan każdego elementu względem każdego narzędzia, plan zmian, zapis i cofnięcie
  zapisu z widoku Historia.
- Diagnostyka: raport środowiska, stan indeksu i ręczna odbudowa indeksu.
- Widoki z obsługą stanów pustego, ładowania, sukcesu, ostrzeżenia i błędu, obsługa klawiaturą
  w głównych przepływach, jasny i ciemny motyw, układ od szerokości okna 1024 px.
- Dokumentacja dla użytkownika: `docs/INSTALACJA.md`, `docs/OGRANICZENIA.md`,
  `docs/ODZYSKIWANIE.md`.
- Pliki wydania: DMG i ZIP dla macOS (arm64 i x64), instalator NSIS i wersja portable dla
  Windowsa, deb i AppImage dla Linuksa.

### Security

- Renderer bez dostępu do Node, z blokadą ruchu sieciowego i zamkniętą listą kanałów IPC
  (ADR 0008).
- Zapis do systemu plików tylko przez `WriteGate`, z planem przed zapisem i kopią zapasową.
- Klasyfikator sekretów przy imporcie i redakcja sekretów w diffach i logach.
- Importowane hooki i skrypty są traktowane jako tekst i nigdy nie są uruchamiane.

### Known limitations

- Tylko konfiguracje globalne (ADR 0032). `CLAUDE.md`, `AGENTS.md` i `.mcp.json` w repozytoriach
  projektów nie trafiają do biblioteki.
- Eksport działa tylko do narzędzia, którego katalog główny istnieje (ADR 0033).
- Aplikacja nie usuwa plików w narzędziach (ADR 0034).
- Serwery MCP i ustawienia narzędzi nie są importowane ani eksportowane (ADR 0020). Reguły
  (rules) nie są obsługiwane.
- Brak porównywania i scalania wersji poza podglądem w planie eksportu, profili, ustawień
  aplikacji, eksportu do ZIP, autoaktualizacji i integracji z Gitem.
- Pierwsze uruchomienie pobranych plików przez Gatekeepera i SmartScreen nie zostało sprawdzone
  ręcznie.

[Unreleased]: https://github.com/konradxmalinowski/cwm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/konradxmalinowski/cwm/releases/tag/v0.1.0
