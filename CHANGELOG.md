# Dziennik zmian

Wszystkie istotne zmiany w projekcie są zapisane w tym pliku.

Format opiera się na [Keep a Changelog 1.1.0](https://keepachangelog.com/pl/1.1.0/), a
numeracja wersji na [Semantic Versioning](https://semver.org/lang/pl/).

## [Unreleased]

Zmiany scalone do `main` (PR #1), przygotowane na v0.2.0 (ADR 0035). Numer wersji w
`package.json` zmieni się przy wydaniu.

### Added

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

### Changed

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
