# CWM - Claude Workspace Manager - plan i roadmapa

Dokument Etapu 0, uzupełnienie `docs/ARCHITECTURE.md`. Etapy pochodzą z
`docs/00-wymagania-zrodlowe.md`; tu dostają strukturę katalogów, kryteria akceptacji, backlog
i analizę ryzyk. Kryteria są sformułowane tak, żeby dały się sprawdzić, a nie odhaczyć.

Zasada 6 i 15 z wymagań obowiązuje w każdym etapie: funkcja, która działa tylko w interfejsie,
nie jest ukończona, a atrapy nie wchodzą do wydania opisanego jako gotowe.

---

## 1. Struktura katalogów

Stan na 2026-11-05, po Etapie 5. Drzewo odpowiada repozytorium; to, czego jeszcze nie ma, jest
wymienione pod nim.

```
universal-ai-skills-manager/
  docs/
    00-wymagania-zrodlowe.md
    ARCHITECTURE.md
    DESIGN.md
    ROADMAP.md
    design-preview.html
    adr/0001 do 0035
  .github/workflows/
    ci.yml
    release.yml
  scripts/                          dev, build preloadu, kopiowanie schematu, test:boundaries, sumy kontrolne
  package.json
  tsconfig.base.json                plus tsconfig.main, preload, renderer, tests
  angular.json
  electron-builder.yml
  eslint.config.mjs
  playwright.config.ts
  vitest.config.ts
  .editorconfig
  .gitattributes                    wymuszenie LF w repozytorium

  src/
    main/
      index.ts
      bootstrap/                    okno, protokol app://, CSP, blokada sieci, start indeksu,
                                    skladanie serwisow (library, import, export, sync)
      ipc/
        registry.ts                 rejestracja kanalow z zamknietej listy
        handlers/                   library, import, export, sync, diagnostics plus walidacja ladunkow
      services/
        diagnostics.ts

    preload/
      bridge.ts                     contextBridge, jawna zamknieta lista kanalow

    shared/
      ipc/                          channels.ts, surface.ts, kontrakty DTO (library, import, export, sync)

    renderer/
      main.ts
      index.html
      styles/                       tokeny, baza, uklad, style widokow (SCSS)
      assets/fonts/
      app/
        app.component               powloka i spis tresci
        startup-banner.component    stan otwarcia indeksu
        core/                       ipc (klienci), routing, state (signals), keyboard, theme, labels
        features/                   library, import, export, sync, history, diagnostics

    core/                           domena: zero zaleznosci na electron, fs, Angular, sqlite
      model/                        item, plan, diagnostics, index-health, library-errors,
                                    library-limits, library-file-names, path-containment
      ports/                        tool-adapter (ToolAdapter, ToolExporter, LocationCatalog),
                                    write-gate, library-store, object-store, operation-log,
                                    sync-state, backup-reader, source-reader, index-store,
                                    store-failure, clock, id-generator
      services/
        library/                    LibraryService, walidacja, item-codec
        import/                     ImportService
        export/                     ExportService
        sync/                       SyncService, sync-recorder, sync-hash
        history/                    HistoryService
        security/                   secret-classifier, secret-redactor
        normalization/              hash, line-endings

    adapters/
      index.ts
      shared/                       frontmatter, markdown, skills, hooks, instructions, marker-block,
                                    slug, text, toml/ (SegmentTomlEditor), export/
      claude-code/                  index (import i eksport w jednej klasie), export, agent-attributes
      codex/                        index (import i eksport w jednej klasie), export, agents

    infra/
      fs/                           write-gate, write-path-guard, atomic, link-mode, bounded-read,
                                    stat, store-error
      library/                      library-store, item-swap, ensure-dirs
      db/                           index-store, quarantine, schema/ (001 init, 002 operation_log,
                                    003 sync_state)
      store/                        object-store, backup, backup-reader
      source/                       fs-source-reader
      platform/                     env, locations, root-salt
      logging/                      logger, redact

  tests/
    harness/                        podstawianie HOME, kanarek na plikach wlasciciela
    fixtures/                       wylacznie syntetyczne drzewa, nazwy acme-* (claude-code, codex, library-linux)
    unit/
    contract/                       jeden zestaw przeciw kazdemu adapterowi
    integration/
    e2e/

  resources/
    icons/                          placeholder do decyzji wlasciciela (pytanie 6)
```

Czego w drzewie jeszcze nie ma, choć wcześniejsza wersja tego dokumentu je wymieniała:

- `src/main/worker/` (skan drzewa, hash i diff dużych plików w osobnym wątku),
- `src/renderer/app/design-system/`: tokeny są w `styles/`, komponenty bazowe w komponentach
  widoków,
- widoki `dashboard`, `agents`, `commands`, `rules`, `profiles`, `settings` (rodzaje elementów
  obsługuje wspólny widok `library`),
- `core/services/diff-merge/`, `sync-planner/`, `policy/`, `profiles/`: synchronizacja jest w
  `SyncService`, a diff to `before` i `after` w planie eksportu (kanału `diff:compute` już
  nie ma, usunięty w Etapie 10),
- `core/model/compatibility.ts`, `hook.ts`, `profile.ts`: poziomy zgodności są w `plan.ts`,
- `core/ports/file-gateway.ts` i `toml-editor.ts`: portem zapisu jest `write-gate.ts`, a edytor
  TOML mieszka w `adapters/shared/toml/`,
- osobne pliki adaptera (`locations`, `scan`, `parse`, `to-canonical`, `plan`, `verify`):
  lokalizacje wykrywa `infra/platform/locations.ts` (ADR 0022), reszta jest w `index.ts` i
  `export.ts` adaptera, a weryfikacja po zapisie w `WriteGate`,
- `infra/platform/permissions.ts` (`icacls` i `chmod`, ADR 0018): w kodzie nie ma wywołania
  `icacls` ani `child_process`.

Reguła granic, wymuszana lintem: `core/` nie importuje `electron`, `node:fs`, `better-sqlite3`
ani Angulara. `adapters/` nie importuje `node:fs` ani `node:child_process`. `renderer/` nie
importuje z `main/`, `infra/`, `adapters/` ani `preload/`; do `core/` i `shared/` ma drogę
otwartą, bo lint nie odróżnia typów od wartości. Zapis do systemu plików jest dozwolony tylko
w plikach z listy `FS_WRITE_ALLOWED` w `eslint.config.mjs` (ADR 0012).

---

## 2. Zakres MVP (Etapy 1 do 5)

MVP rozwiązuje cały problem z wizji wymagań: użytkownik nie kopiuje plików ręcznie między
narzędziami, a aplikacja odpowiada za import, normalizację, konwersję, synchronizację, wykrywanie
konfliktów i bezpieczny eksport.

**Jest w MVP:** biblioteka z modelem kanonicznym, CRUD, wyszukiwanie i filtrowanie; import
z Claude Code i Codeksa z podglądem, wykrywaniem duplikatów i wykluczaniem sekretów; eksport
do obu narzędzi z ostrzeżeniami o utracie zgodności i podglądem plików; synchronizacja z planem
zmian, diffem przed zapisem, backupem, weryfikacją i cofaniem; trzy platformy; design system
z dwoma motywami i obsługą klawiatury.

**Nie ma w MVP:** scalania treści linia po linii (użytkownik widzi konflikt i wybiera wersję,
ale jej nie scala), profili, przywracania wersji elementu z interfejsu, dashboardu
z agregatami, eksportu do ZIP i Git, autoaktualizacji, podpisanych wydań, synchronizacji MCP.

**MVP nie jest wydaniem gotowym.** Etapy 8 do 10 są warunkiem wydania.

---

## 3. Etapy

### Etap 1: Szkielet - ZAMKNIĘTY

Status: wszystkie kryteria akceptacji spełnione na czterech celach w jednym przebiegu
(`39525840100`, commit `e34367a`). Pierwszy etap zamknięty w tym projekcie.

Zakres: projekt Electron plus Angular 20 standalone, TypeScript strict, SCSS. Granice modułów
z lintem. Routing i pusty szkielet jedenastu widoków plus Diagnostics. Design system: tokeny,
dwa motywy, komponenty bazowe, stany operacji. Preload z pustą, ale jawną listą kanałów.
Hartowanie renderera (ADR 0008). Konfiguracja testów na czterech poziomach. Macierz CI dla trzech
platform z czterema celami. `better-sqlite3` podłączony i budujący się na wszystkich celach.

Kryteria akceptacji:
1. `npm run dev` uruchamia aplikację na macOS; `ci.yml` buduje ją na wszystkich czterech celach
   macierzy i artefakty powstają.
2. `better-sqlite3` ładuje się w zbudowanej aplikacji na każdym celu macierzy. Test E2E otwiera
   bazę i wykonuje zapytanie. To jest kryterium, nie formalność: tu rozstrzyga się ryzyko R2.
   **Spełnione** przez trzy testy w `tests/e2e/packaged-db.spec.ts`, zielone na czterech celach.
   Jeden element dowodu, bezpośrednie wykonanie zapytania FTS wewnątrz paczki, przechodzi
   świadomie na Etap 2 (R2).
3. Reguła granic modułów jest wymuszona: celowy import `node:fs` w `core/` wywala lint w CI.
4. Hartowanie jest sprawdzone testem, nie konfiguracją: test E2E potwierdza, że `require`
   w rendererze nie istnieje, a żądanie sieciowe wychodzące jest zablokowane.
5. Zero zależności nieuzasadnionych. Każda pozycja w `package.json` ma powód zapisany w README
   albo w ADR.

### Etap 2: Biblioteka - ZAMKNIĘTY

Zakres: model kanoniczny (ADR 0023). Zapis i odczyt według układu danych (ADR 0014). Content
store i log operacji jako warstwa danych (ADR 0019). Lista, wyszukiwanie FTS, filtrowanie,
szczegóły, edycja, walidacja. Import pojedynczego pliku. Metadane i pliki powiązane. Walidator
kolizji wielkości liter (ADR 0017). Normalizacja końców linii (ADR 0016). Przebudowa indeksu
z plików z kwarantanną i triażem przyczyn awarii otwarcia (ADR 0029). Okno przed otwarciem
indeksu, z widokiem dla odmowy i dla odbudowy (ADR 0029, ARCHITECTURE 13.1).

**Stan (2026-11-10): zamknięty. Wszystkie kryteria mają testy, zielone na czterech celach w przebiegu CI `42072361844`.** Kawałki A
(warstwa plików i content store, ADR 0031) i C (kanały `library:*`, interfejs biblioteki, widok
Diagnostyki) są w kodzie. Kawałek B: migracja 4 (`004-library-index.sql`) dodaje tabelę `items`
z unikalnym indeksem `(kind, slug_key)` (ADR 0017 w bazie obok walidatora) i tabelę FTS5
`items_fts` (`unicode61 remove_diacritics 2`). `LibraryService` po każdym udanym zapisie plików
aktualizuje indeks (port `LibraryIndex`, implementacja `src/infra/db/library-index.ts`); awaria
indeksu daje ostrzeżenie `index-update-failed` i odbiera mu zaufanie, a slugi i wyszukiwanie
wracają do plików. Przy starcie indeks wypełnia się z plików, gdy jest świeży po odbudowie albo
liczba elementów w nim nie zgadza się z liczbą katalogów w `library/items`
(`src/main/bootstrap/library-index.ts`). Wyszukiwanie w `library:list` idzie przez FTS z
dopasowaniem prefiksowym na tokenach. Ręczna odbudowa działa przez `diagnostics:rebuild-index-plan`
i `-apply` (`src/main/services/index-rebuild.ts`), pod wspólną blokadą z zapisami
(`src/main/services/write-lock.ts`). Kryteria 1 i 4 należą do interfejsu i nie są tu rozstrzygane.

Ograniczenia tego kawałka:

- Zgodność indeksu z plikami przy starcie sprawdza tylko liczba elementów. Jeśli aktualizacja
  indeksu padła po zapisie plików, a liczby się zgadzają, po restarcie indeks może mieć starą
  treść do czasu ręcznej odbudowy z Diagnostyki.
- Gdy w `library/items` jest katalog, którego nie da się wczytać (problem albo niespójność),
  liczby nigdy się nie zgadzają i indeks wypełnia się przy każdym starcie.
- `unicode61` nie zdejmuje kreski z polskiego l, więc indeks składa je do zwykłego `l` po obu
  stronach (treść i zapytanie).
- Wyszukiwanie jest prefiksowe po tokenach, nie po podłańcuchu: fragment ze środka słowa już nie
  pasuje. Zapytanie bez żadnego słowa (same znaki specjalne) wraca do filtra podłańcucha po plikach.

Kryteria akceptacji:
1. Tworzenie, edycja, wyszukiwanie i usuwanie elementu działa z końca na koniec, przez interfejs,
   z potwierdzeniem operacji destrukcyjnej.
2. Usunięcie `index.db` i restart aplikacji odtwarza pełny indeks z plików, bez utraty
   danych. Test automatyczny, nie ręczny.
3. Cztery przyczyny awarii otwarcia indeksu dają trzy różne reakcje (ADR 0029): uszkodzenie
   i nieznany schemat prowadzą do odbudowy po kwarantannie, schemat z przyszłości do odmowy
   (asercja negatywna: **nie jest** odbudowywany, bo to zniszczyłoby log operacji), `userData`
   bez prawa zapisu i brak modułu natywnego do odmowy. Nieudana kwarantanna wstrzymuje odbudowę,
   a nie przechodzi w "usuń i spróbuj".
4. **Odziedziczone po Etapie 1: trzy stany otwarcia indeksu mają widok** (ADR 0029 punkt 3,
   wykonany dotąd do połowy). Ścieżka danych już jest: okno powstaje przed otwarciem indeksu,
   a stan otwarcia idzie do renderera przez `diagnostics:report`. Brakuje widoku, bo renderer
   w Etapie 1 jest pustą powłoką i taka była decyzja. Do pokazania:
   - **odmowa**: powód i ścieżka do pliku w kwarantannie,
   - **odbudowa**: liczba wczytanych elementów oraz jawna lista tego, czego nie odzyskano,
   - **start normalny**.

   Zastrzeżenie, bez którego ten widok skłamie: raport mówi dziś `restoredItems: 0`, bo warstwa
   biblioteki, z której odbudowa czerpie, powstaje dopiero w tym etapie. **Zero wczytanych
   elementów nie może wyglądać na sukces.** Nieodzyskane są dwie rzeczy i obie trzeba wymienić
   wprost: log operacji, nieodtwarzalny z plików z definicji (ADR 0014), oraz zawartość
   biblioteki, dopóki tej warstwy nie ma.

   Test uruchamia aplikację nad uszkodzonym indeksem i sprawdza, że okno się pojawia i mówi,
   co się stało.
5. Każda z czterech gałęzi triażu jest **osiągalna**, co jest osobnym testem od testu jej
   zachowania (ADR 0029 punkt 4). Gałąź "moduł natywny się nie ładuje" była nieosiągalna, dopóki
   `better-sqlite3` szedł importem statycznym, bo proces padał przed powstaniem okna.
6. Ręczna odbudowa z Diagnostics działa przez dwa kanały z ADR 0030, z planem przed
   zastosowaniem. Asercje: plan pokazuje, czego odbudowa nie odzyska; `apply` odmawia, gdy
   kwarantanna jest niemożliwa (`blocked`) oraz gdy plan jest przeterminowany; kanał nie przyjmuje
   żadnej ścieżki; dwa równoległe wywołania nie wchodzą sobie w drogę. To jedyne wyjście ze stanu
   "schemat z przyszłości", więc test obejmuje też ten przypadek z jawnym potwierdzeniem utraty
   logu operacji.
7. Zapytanie FTS wykonane **wewnątrz zapakowanej aplikacji** na pierwszej prawdziwej tabeli
   pełnotekstowej biblioteki, na czterech celach macierzy. To domyka ostatni element ryzyka R2
   i jest powodem, dla którego R2 nie zostało zamknięte w Etapie 1.
8. Próba zapisu elementu kolidującego po `lower(slug)` jest odrzucona z czytelnym komunikatem,
   na wszystkich trzech systemach.
9. Element z plikami pomocniczymi zapisuje się i odczytuje razem z nimi, włącznie ze ścieżkami
   ze spacjami i znakami spoza ASCII.
10. Element zapisany na Linuksie i skopiowany na macOS oraz Windows otwiera się bez błędu.

Dowody (stan na 2026-11-05):

| Kryterium | Test albo brak | Status |
|---|---|---|
| 1 | `tests/e2e/library-crud.spec.ts` (tworzenie, edycja, wyszukiwanie po słowie tylko z treści, usunięcie z potwierdzeniem; asercje na `library/items` i `objects/`), serwis: `tests/unit/library-service.test.ts`, `tests/integration/library-acceptance-fs.test.ts` | spełnione, CI `42072361844` na czterech celach |
| 2 | `tests/integration/library-index-restore.test.ts` (usunięcie `index.db`, ponowny start, wyszukiwanie znajduje wszystko; odbudowa uszkodzonego; element nieczytelny w `notRestored`), `tests/e2e/index-startup.spec.ts` (to samo przez zbudowaną aplikację) | spełnione |
| 3 | `tests/unit/index-startup.test.ts`, `tests/integration/index-store.test.ts`, `tests/integration/quarantine.test.ts`, `tests/integration/index-triage-reachability.test.ts` (prawdziwy plik; asercja negatywna: schemat z przyszłości zostaje nietknięty, bez kwarantanny i bez utraty logu), `tests/e2e/index-startup.spec.ts` | spełnione |
| 4 | `tests/e2e/index-recovery-ui.spec.ts` (tekst paska po uszkodzonym indeksie: liczba elementów, lista nieodzyskanych rzeczy, brak ścieżki; indeks z przyszłości: powód i ręczna odbudowa jako jedyne wyjście; wynik z zerem jako niepełny), `tests/e2e/index-startup.spec.ts` | spełnione, CI `42072361844` na czterech celach |
| 5 | `tests/integration/index-triage-reachability.test.ts`: każda z pięciu przyczyn (cztery gałęzie triażu) z prawdziwego `SqliteIndexStore`, `native-module` przez podstawione ładowanie sterownika (`loadDriver`); `tests/integration/index-store.test.ts` | spełnione |
| 6 | `tests/unit/index-rebuild.test.ts` (plan pokazuje utratę logu; `apply` odmawia przy `blocked` i przy planie przeterminowanym; brak ścieżki w ładunku; dwa równoległe wywołania; schemat z przyszłości z potwierdzeniem), `tests/unit/ipc-registry.test.ts`, `tests/e2e/index-startup.spec.ts` (oba kanały w zbudowanej aplikacji) | spełnione |
| 7 | `tests/e2e/packaged-db.spec.ts` (biblioteka na dysku bez indeksu, start zapakowanej aplikacji, zapytanie FTS na `items_fts` wypełnionej przez paczkę). Wynik na czterech celach daje CI | spełnione, CI `42072361844` na czterech celach |
| 8 | `tests/unit/library-service.test.ts` (kryterium 8), `tests/integration/library-acceptance-fs.test.ts`; macierz `npm test` na czterech celach | spełnione |
| 9 | `tests/unit/library-service.test.ts` (spacje, polskie litery, CJK), `tests/integration/library-service-fs.test.ts` | spełnione |
| 10 | `tests/integration/library-fixture.test.ts` na fixture `tests/fixtures/library-linux/` | spełnione |

### Etap 3: Import z Claude Code i Codeksa - ZAMKNIĘTY

Status: każde z ośmiu kryteriów ma test (tabela pod kryteriami), a ostatni przebieg CI na `main`
(`41991403641`, commit `c37e40d`) jest zielony na czterech celach. Zastrzeżenie do kryterium 1: jego część ręczna (sprawdzenie
na realnym drzewie) nie ma zapisu w repozytorium i mieć go nie powinna (ADR 0004); automatyczna
część jest sprawdzona. Zakres importu obejmuje wyłącznie konfiguracje globalne (ADR 0032).

Zakres: warstwa wykrywania lokalizacji (ADR 0022), z `~/.agents/skills` jako możliwym rootem
i wykrywaniem duplikatów międzyrootowych (ADR 0024). Adaptery obu narzędzi w zakresie
`detectLocations`, `scan`, `parse`, `toCanonical`. Kreator importu z podglądem. Wykrywanie
duplikatów i różnic wersji. Ostrzeżenie o rozjechaniu slug kontra `declaredName` (ADR 0026).
Pomijanie wybranych elementów. Klasyfikator sekretów i domyślne wykluczanie. Korpus fixture'ów
syntetycznych (ARCHITECTURE sekcja 12.3).

Kryteria akceptacji:
1. Import realnej konfiguracji Claude Code i Codeksa przebiega bez **ani jednej** modyfikacji
   źródła. Weryfikacja: hash każdego pliku w drzewie źródłowym przed i po, jako test
   automatyczny na fixture i jako ręczne sprawdzenie na realnym drzewie.
2. Import rozpoznaje poprawnie wszystkie siedem przypadków formatowych z audytu: katalog
   ze `SKILL.md`, katalog bez `SKILL.md` (nie skill), płaski `.md` bez frontmattera, plik bez
   rozszerzenia, alias przez symlink, agent z wpisem rejestracyjnym, wpis rejestracyjny bez pliku.
3. Element z trafieniem klasyfikatora sekretów jest domyślnie odznaczony, a włączenie go wymaga
   jawnego potwierdzenia z pokazanym powodem trafienia.
4. Symlink wyprowadzający poza wybrany root nie jest podążany. Test z fixture wskazującym
   na katalog zewnętrzny.
5. Powtórny import tego samego drzewa nie tworzy duplikatów i raportuje je jako istniejące
   bez zmian.
6. Root nieistniejący jest zwracany jako kandydat z informacją, że go nie ma, a element
   występujący w dwóch rootach tego samego narzędzia jest raportowany jako duplikat
   międzyrootowy z informacją, który jest aktywny. Testy z podstawionym środowiskiem,
   w którym drugi root raz istnieje, a raz nie.
7. Element z rozjechaniem slug kontra `declaredName` importuje się bez przeszkód i dostaje
   ostrzeżenie z wyjaśnieniem konsekwencji dla każdego celu. Import nie prostuje nazwy.
8. Pliki uszkodzone, niedostępne (EACCES) i przekraczające limit rozmiaru dają błąd z nazwą
   pliku i nie przerywają całego importu, tylko oznaczają ten element.

Dowody (stan na 2026-11-05):

| Kryterium | Test |
|---|---|
| 1 | `tests/integration/import-source-untouched.test.ts` (hash każdego pliku przed i po skanie oraz imporcie) |
| 2 | `tests/unit/adapters-claude-code.test.ts` (przypadki 1 do 5; piąty, alias przez symlink, jest pomijany tam, gdzie system nie pozwala na symlinki), `tests/unit/adapters-codex.test.ts` (przypadki 6 i 7: agent z wpisem i wpis bez pliku) |
| 3 | `tests/unit/import-service.test.ts` (odznaczenie i `confirmedSecrets`), `tests/unit/secret-classifier.test.ts` |
| 4 | `tests/unit/adapters-claude-code.test.ts` (symlinki wyprowadzające poza root), `tests/integration/fs-source-reader.test.ts` |
| 5 | `tests/integration/import-source-untouched.test.ts`, `tests/unit/import-service.test.ts` |
| 6 | `tests/integration/locations.test.ts`, `tests/unit/import-service.test.ts` |
| 7 | `tests/unit/adapters-claude-code.test.ts` |
| 8 | `tests/unit/adapters-claude-code.test.ts` (limit rozmiaru, plik bez uprawnień) |

### Etap 4: Eksport i adaptery - ZAMKNIĘTY

Status: sześć z siedmiu kryteriów ma test, a ostatni przebieg CI na `main` (`41991403641`, commit `c37e40d`) jest
zielony na czterech celach. Otwarte jest kryterium 5: tryb materializacji jest wyliczany i
pokazywany w planie eksportu (`src/renderer/app/features/export/plan-view.component.html`),
ale żaden test nie sprawdza, że użytkownik go widzi. Testy poprawności per system są
(tabela pod kryteriami).

W kodzie kontrakt adaptera dzieli się na `ToolAdapter` (import) i `ToolExporter` (`capabilities`
i `plan`); `apply` i weryfikacja po zapisie są w `WriteGate`, nie w adapterze (ARCHITECTURE 5).
Eksport do narzędzia wymaga istniejącego katalogu głównego, a brakujące podkatalogi i pliki
w nim są tworzone (ADR 0033).

Zakres: `capabilities`, `plan`, `apply`, `verify` w obu adapterach. Mapowanie formatów, w tym
agent do dwóch miejsc w Codeksie i komenda na skill (ADR 0021). `SegmentTomlEditor` z preflightem
i weryfikacją semantyczną (ADR 0011). Zarządzanie blokiem między markerami dla instrukcji
globalnych (ADR 0025). Tryb materializacji (ADR 0015). Sonda `recoverability` na każdym wpisie
planu (ADR 0028). Podgląd plików przed zapisem. Zestaw testów kontraktowych.

Kryteria akceptacji:
1. Każdy obsługiwany typ elementu eksportuje się do obu narzędzi i powstały plik jest przez
   narzędzie akceptowany. Weryfikacja składniowa: wynik TOML parsuje się niezależnym parserem,
   wynik YAML frontmattera parsuje się ponownie i daje te same wartości.
2. Element nieobsługiwany jest jawnie oznaczony w planie z powodem i **nie powstaje żaden plik**.
   Dotyczy co najmniej serwerów MCP (ADR 0020).
3. Eksport agenta do Codeksa tworzy plik agenta i wpis rejestracyjny, a `config.toml` poza
   zakresem zarządzanym jest identyczny semantycznie z wejściem. Weryfikacja przez porównanie
   drzewa po niezależnym parsowaniu, z komentarzami i sekcjami obcymi zachowanymi.
4. `config.toml` zawierający konstrukcję poza zakresem segmentera dostaje odmowę edycji
   z czytelnym komunikatem, a nie uszkodzony wynik.
5. Tryb materializacji jest widoczny w interfejsie per element i poprawny na każdym systemie:
   symlink na POSIX, junction dla katalogu na Windowsie bez uprawnień, kopia dla pliku.
6. Zestaw testów kontraktowych przechodzi dla obu adapterów. Ten sam zestaw jest wymaganiem
   dla każdego przyszłego adaptera.
7. Eksport instrukcji globalnej podmienia wyłącznie blok między markerami, a treść poza blokiem
   jest identyczna bajt w bajt z wejściem. Plik bez markerów dostaje blok dopisany na końcu,
   nigdy przepisanie. Plik z treścią zarządzaną bez markerów wymaga decyzji użytkownika.
   Trzy osobne testy, każdy na obu narzędziach.

Dowody (stan na 2026-11-05):

| Kryterium | Test albo brak | Status |
|---|---|---|
| 1 | `tests/contract/export-contract.ts` (ponowne parsowanie YAML, niezależny parser TOML), uruchamiany dla obu adapterów przez `tests/contract/export.test.ts` | spełnione |
| 2 | `tests/contract/export-contract.ts` (element nieobsługiwany w `refusals`, fixture MCP, zero wpisów) | spełnione |
| 3 | `tests/contract/export-contract.ts`, `tests/unit/adapters-export-codex.test.ts` | spełnione |
| 4 | `tests/unit/adapters-segment-toml.test.ts`, `tests/contract/export-contract.ts` (odmowa edycji) | spełnione |
| 5 | Poprawność per system: `tests/integration/link-mode.test.ts`, `tests/integration/write-gate-link.test.ts`. Widoczność w interfejsie: `tests/e2e/export-materialization.spec.ts` (tekst trybu i jego wyjaśnienie per wpis planu), CI `42072361844` na czterech celach | spełnione |
| 6 | `tests/contract/export.test.ts` | spełnione |
| 7 | `tests/contract/export-contract.ts` (blok istnieje, brak markerów, treść bez markerów), `tests/unit/adapters-marker-block.test.ts` | spełnione |

### Etap 5: Synchronizacja i bezpieczeństwo (granica MVP) - ZAMKNIĘTY

Status: siedem z ośmiu kryteriów ma test, a ostatni przebieg CI na `main` (`41991403641`, commit `c37e40d`) jest
zielony na czterech celach. Kryterium 7 to `tests/e2e/full-flow.spec.ts`, zielony na czterech
celach w przebiegu `41895703009` dla commita `a6deea4` i w kolejnym. Otwarte jest kryterium 8:
przyczyny systemowe Windowsa (naruszenie współdzielenia, ACL z zapisem bez odczytu) nie mają
testu, a testy `chmod` są tylko dla POSIX. Do kryterium 2: błąd w połowie zapisu jest
wstrzykiwany przez port `rename`, a nie realnym odebraniem uprawnień.

Zakres zrealizowany: `SyncService` z siedmioma stanami elementu (`never`, `in-sync`,
`library-changed`, `tool-changed`, `conflict`, `missing-in-tool`, `unsupported`) i rozstrzygnięciem
`library-wins`, `tool-wins`, `skip`; `WriteGate`; widoki Synchronizacja i Historia; cofanie
przez `history:rollback` i `export:apply`. Diff jest częścią planu eksportu (kanału `diff:compute`
już nie ma, usunięty w Etapie 10). Polityka usuwania: ADR 0034.

Zakres: `SyncPlanner`, wybór celów, plan operacji, diff przed zapisem, identyfikacja konfliktów,
zatwierdzenie, `WriteGate` (ADR 0012), backup, obsługa błędów, weryfikacja po synchronizacji,
cofanie. Polityka usuwania (ADR 0034).

Prymityw zapisu atomowego `src/infra/fs/atomic.ts` (plik tymczasowy z pidem, `rename` z ponowieniami
na Windowsie, przepisanie trybu, sprzątanie, odczyt kontrolny, `fsync` katalogu) powstał już
w Etapie 2 i ma własne testy (ADR 0031). `WriteGate` go używa, nie pisze od nowa; Etap 5 dokłada
kanonizację ścieżki, kontrolę prefiksu, plan, zatwierdzenie i rollback. Poprawki w prymitywie
muszą pozostać zgodne z zapisem biblioteki, który dzieli z nim `renameWithRetry`, `syncDirectory`
i wzorzec nazw tymczasowych.

Kryteria akceptacji:
1. Zapis bez planu i bez jawnego zatwierdzenia jest niemożliwy. Nie istnieje ścieżka kodu, która
   go dopuszcza, co jest sprawdzone testem i regułą lintu.
2. Nieudana operacja jest w pełni odtwarzalna albo wycofywalna. Test wymusza błąd w połowie
   zapisu (odebranie uprawnień do katalogu docelowego) i sprawdza, że stan końcowy jest albo
   taki jak przed, albo spójny i domykalny ponownym przebiegiem. Na wszystkich trzech systemach.
3. Powtórna synchronizacja bez zmian nie modyfikuje ani jednego pliku i nie tworzy backupu.
   Idempotencja jako test: `plan` po `apply` jest pusty.
4. Żaden plik docelowy nie jest usuwany tylko dlatego, że nie ma go w bibliotece. Usuwanie
   przebiega wyłącznie według zatwierdzonej polityki i z potwierdzeniem.
5. Sekret nie trafia do podglądu diffa ani do logu. Asercje negatywne na zawartości ładunku IPC
   i na zawartości pliku logu.
6. Path traversal jest niemożliwy: testy dla `..`, symlinku wyprowadzającego, UNC i `\\?\`
   na Windowsie, nazwy z NUL, nazwy zarezerwowanej Windowsa.
7. Pełny przepływ przechodzi w teście E2E na trzech systemach: import, edycja, plan
   synchronizacji, zatwierdzenie, weryfikacja, cofnięcie.
8. Operacja, której nie da się zabezpieczyć kopią, jest zablokowana **na etapie planu**
   i nie daje się zastosować (ADR 0028). Test dla każdej wykrywalnej przenośnie przyczyny:
   plik docelowy nieczytelny, katalog tylko do czytania, cel niebędący zwykłym plikiem, brak
   miejsca w `userData` (przez podstawienie portu, nie zapełnianie dysku). Przyczyny systemowe
   (naruszenie współdzielenia i ACL z zapisem bez czytania na Windowsie) w macierzy CI.
   Asercja negatywna: `apply` planu z wpisem `blocked` nie zapisuje ani jednego bajtu.

Dowody (stan na 2026-11-05):

| Kryterium | Test albo brak | Status |
|---|---|---|
| 1 | `tests/integration/write-gate.test.ts` (odmowy na starcie), `tests/unit/export-service.test.ts`, reguła lintu `FS_WRITE_ALLOWED` sprawdzana przez `npm run test:boundaries` w CI | spełnione |
| 2 | `tests/integration/write-gate.test.ts` (atomowość i rollback; błąd wstrzyknięty przez port `rename`, nie realne uprawnienia), na czterech celach | spełnione |
| 3 | `tests/integration/sync-flow.test.ts` (ponowny plan jest pusty i bez kopii) | spełnione |
| 4 | `tests/integration/write-gate-delete.test.ts`, `tests/integration/sync-flow.test.ts`, `tests/contract/export-contract.ts` (sierota nie jest wpisem planu) | spełnione |
| 5 | `tests/unit/security-export-diff.test.ts` (ładunek `export:plan`), `tests/integration/security-logger.test.ts`, `tests/unit/security-redactor.test.ts` | spełnione |
| 6 | `tests/integration/write-gate.test.ts` (bezpiecznik ścieżek, obie kolumny; UNC i `\\?\` przez podstawiony `path.win32`), `tests/integration/security-write-gate.test.ts` | spełnione |
| 7 | `tests/e2e/full-flow.spec.ts`: import, eksport, edycja, plan synchronizacji, zatwierdzenie, weryfikacja, cofnięcie, stan pliku co do bajta | spełnione |
| 8 | POSIX: `tests/integration/security-write-gate.test.ts`, `tests/integration/write-gate.test.ts` (nieczytelny plik, katalog tylko do odczytu, cel niebędący plikiem, brak miejsca, `blocked` bez zapisu). Windows: `tests/integration/write-gate-windows.test.ts` (naruszenie współdzielenia przez proces trzymający plik z `FileShare.None`, ACL z zapisem bez odczytu; oba z kolumną pozytywną), 4 testy wykonane w jobie `windows-x64` przebiegu `42072361844` | spełnione |

### Etap 6: Porównywanie i scalanie (po MVP)

Zakres: porównywanie wersji, strategie per format (Markdown, JSON, TOML), selektywne przyjmowanie
zmian, konflikty semantyczne, rozwiązywanie z zachowaniem oryginałów.

Kryteria akceptacji:
1. Diff wskazuje poprawnie nowe, usunięte i zmodyfikowane pliki, konflikty, zmiany scalane
   automatycznie i zmiany wymagające decyzji.
2. Konflikt nie jest nigdy rozwiązywany wyborem jednej z wersji bez decyzji użytkownika.
3. Wynik scalenia da się sprawdzić przed zastosowaniem, a oryginały pozostają dostępne.
4. Diff plików różniących się wyłącznie końcami linii jest pusty.
5. Diff TOML i JSON porównuje strukturę, nie tekst, więc zmiana kolejności kluczy nie jest
   zgłaszana jako zmiana treści.

### Etap 7: Historia i profile (po MVP)

Widok historii i cofanie zapisów do narzędzi weszły do Etapu 5 (ADR 0019, 0034). Tu zostaje
to, czego w nich nie ma: przywracanie wersji elementu biblioteki z interfejsu i profile.

Zakres: widok historii, porównywanie wersji, przywracanie wybranej wersji, cofanie operacji
z interfejsu, profile (General Development, Backend, Frontend, DevOps, Security, School Projects),
eksport zestawu do wielu narzędzi jednocześnie.

Kryteria akceptacji:
1. Historia pokazuje kiedy, co i do jakiego narzędzia wyeksportowano, oraz z jakim wynikiem.
2. Przywrócenie poprzedniej wersji elementu i cofnięcie operacji synchronizacji działa
   z interfejsu i samo tworzy wpis w historii.
3. Profil eksportuje się do kilku narzędzi w jednej operacji, z jednym planem i jednym
   zatwierdzeniem.
4. Profil nie może zawierać elementu oznaczonego jako prywatny, zależny od projektu ani
   z trafieniem klasyfikatora sekretów. Blokada w walidatorze profilu, nie ostrzeżenie w UI.
5. Przywrócenie dowolnej wersji z całej historii działa bez rekonstrukcji z łańcucha różnic
   (ADR 0027), a rozmiar content store jest widoczny w Settings.

### Etap 8: Dopracowanie UI i UX - ZAMKNIĘTY

Status: wszystkie pięć kryteriów ma test E2E, a przebieg CI na `main` (`42889995454`) jest zielony
na czterech celach. Rzeczy, których te testy nie dowodzą: audyt jest automatyczny (axe-core plus
własny odczyt kontrastu), bez przejścia czytnikiem ekranu (VoiceOver, Narrator, Orca), a jasny
motyw jest przełączany atrybutem `data-theme`, nie klikaniem w przełącznik. Dla Diagnostyki
„stan pusty” oznacza start bez zdarzeń do zgłoszenia (widok nie ma kolekcji, którą dałoby się
opróżnić); to interpretacja do potwierdzenia przez właściciela produktu.

Zakres zrealizowany: rejestr scen `tests/e2e/scenes.ts` (jedno miejsce, które wie, jak dojść do
każdego stanu widoku i dialogu), z którego korzystają testy stanów, audytu i inwentaryzacji.
Ładowanie i błąd powstają przez podmianę handlera IPC w procesie głównym w pomocniku
`tests/e2e/ui-helpers.ts`, bez żadnej gałęzi w kodzie aplikacji. Poprawki w aplikacji: tekst
drugorzędny na powierzchni nadpisania (`text-muted` na `cobalt-600`, 3,95:1) dostaje `cobalt-100`;
opis w tabeli biblioteki łamie się do dwóch wierszy z pełną wartością w `title`; fokus wraca na
element otwierający po zamknięciu okna dialogowego (bez wyścigu z odświeżeniem widoku); import nie
zaznacza domyślnie elementów zmienionych (napis w grupie mówił, że są pominięte); okno dialogowe
mieści się przy wysokości 700 px; Diagnostyka ma jawne zdanie dla startu bez zdarzeń.

Kryteria akceptacji:
1. Każda widoczna kontrolka coś robi. Lista kontrolek bez działania jest pusta, a nie krótka.
2. Każdy widok ma stan pusty, ładowania, sukcesu, ostrzeżenia i błędu, i każdy da się wywołać
   w teście E2E.
3. Pełna obsługa klawiatury dla krytycznych przepływów: import, synchronizacja, diff, cofanie.
   Fokus widoczny, kolejność logiczna, pułapki fokusu w modalach.
4. Audyt dostępności przechodzi bez błędów krytycznych, kontrast spełnia WCAG AA w obu motywach.
5. Interfejs działa na szerokości okna od 1024 px bez poziomego przewijania i bez przycinania
   treści.

| Kryterium | Test | Status |
|---|---|---|
| 1. Każda kontrolka coś robi | `tests/e2e/controls-inventory.spec.ts`: mechaniczna inwentaryzacja na każdej scenie przez CDP (`DOMDebugger.getEventListeners`), lista martwych kontrolek pusta, żadna kontrolka nie jest zawsze zablokowana | spełnione |
| 2. Pięć stanów na widok | `tests/e2e/view-states.spec.ts`: rejestr pokrywa 6 widoków x 5 stanów (test statyczny), każda scena ma asercje o treści | spełnione, Diagnostyka „pusty” wg interpretacji wyżej |
| 3. Klawiatura w krytycznych przepływach | `tests/e2e/keyboard-flows.spec.ts`: import, synchronizacja, diff, cofanie i okno usuwania wyłącznie przez `keyboard.press`, asercje na `document.activeElement`, pierścień fokusu, kolejność w dokumencie, pułapka w oknie, Escape i powrót fokusu | spełnione |
| 4. Audyt dostępności i kontrast | `tests/e2e/a11y-fit.spec.ts`: axe-core na każdej scenie w obu motywach, pada na critical i serious, `AXE_EXCEPTIONS` puste; elementy nierozstrzygnięte przez axe liczy własny odczyt kontrastu | spełnione, bez przejścia czytnikiem ekranu |
| 5. Okno od 1024 px | `tests/e2e/a11y-fit.spec.ts`: okno 1024 x 700 na każdej scenie, brak przewijania poziomego strony i elementów, brak przyciętego tekstu bez pełnej wartości w `title`, dialog mieści się w oknie | spełnione; gdy system nie da oknu tego rozmiaru (mały ekran CI), widok dostaje go przez CDP |

### Etap 9: Testy i bezpieczeństwo - ZAMKNIĘTY

Status: siedem z siedmiu kryteriów ma test, a przebieg CI `42889995454` (commit `7f62d5d`) jest
zielony na czterech celach, razem z jobami paczki dystrybucyjnej.

Zakres: domknięcie pokrycia, pełny korpus fixture'ów, scenariusze błędów, build produkcyjny.

Kryteria akceptacji:
1. Każdy moduł z ARCHITECTURE sekcja 6 ma testy sprawdzające zachowanie, nie istnienie klas.
2. Pełny korpus fixture'ów z ARCHITECTURE sekcja 12.3 jest zaimplementowany i wszystkie
   przechodzą, w tym: ścieżki ze spacjami i znakami spoza ASCII, brak uprawnień, pliki uszkodzone,
   przerwana synchronizacja, potencjalne sekrety, path traversal.
3. Testy bezpieczeństwa z ARCHITECTURE sekcja 12.4 przechodzą jako asercje negatywne.
4. Każdy mechanizm ochronny ma test na ścieżce pozytywnej, nie tylko negatywnej (ARCHITECTURE
   sekcja 12.5). Kryterium jest zero-jedynkowe: żaden bezpiecznik nie ma w repozytorium samych
   testów sprawdzających, że blokuje.
5. Ani jeden fixture nie pochodzi z realnej konfiguracji. `gitleaks` w CI przechodzi na całej
   historii, nie tylko na HEAD.
6. Build produkcyjny powstaje dla wszystkich trzech platform i uruchamia się na każdej z nich.
7. Testy round-trip property-based przechodzą, a wszystkie udokumentowane wyjątki (`partial`,
   `lossy`) są jawne i uzasadnione w kodzie testu.

Dowody (stan na 2026-11-10):

| Kryterium | Test albo brak | Status |
|---|---|---|
| 1 | Library: `tests/unit/library-*.test.ts`, `tests/integration/library-*.test.ts`; Normalization: `line-endings.test.ts`, kontrakt eksportu, `tests/property/round-trip.test.ts`; Tool adapters: `tests/contract/adapters.test.ts`, `export.test.ts`, `adapters-*.test.ts`; Import: `import-service.test.ts`, `import-source-untouched.test.ts`, `import-corpus.test.ts`; Export: `export-service.test.ts`, `export-fresh-home.test.ts`; Synchronization: `sync-service.test.ts`, `sync-flow.test.ts`, `sync-interrupted.test.ts`; History and rollback: `sync-flow.test.ts` (rollback i cofnięcie rollbacku), `index-sync-state.test.ts`; Security: `secret-classifier.test.ts`, `security-*.test.ts`, `write-gate*.test.ts`, `network-block.test.ts`, `no-exec-static.test.ts`; Diagnostics: `diagnostics.test.ts`, `index-rebuild.test.ts`. W MVP nie istnieją: Diff and merge (Etap 6; diff jest częścią planu eksportu), Profiles (Etap 7), Settings (brak modułu, ustawienia nie są trwałe) | spełnione dla istniejących modułów |
| 2 | Korpus z wymagań i ustalenia empiryczne: `tests/fixtures/claude-code`, `tests/fixtures/codex` plus przypadki budowane w teście (symlinki, uprawnienia, wielkość liter, sekret); testy: `adapters-claude-code.test.ts`, `adapters-codex.test.ts`, kontrakty, `import-corpus.test.ts` (cały korpus przez import, kolizja wielkości liter, sekret), `fs-source-reader.test.ts`, `locations.test.ts` (spacje i znaki spoza ASCII). Przerwana synchronizacja: `sync-interrupted.test.ts`, błąd w połowie `apply` i proces znikający po pierwszym elemencie; oba domykają się ponownym przebiegiem | spełnione |
| 3 | Traversal, UNC, `\\?\`, NUL, nazwy zarezerwowane: `write-gate.test.ts`, `security-write-gate.test.ts`; sekret poza diffem: `security-export-diff.test.ts` (ładunek IPC); sekret poza logiem: `security-logger.test.ts`; zakaz sieci: `network-block.test.ts`, `tests/e2e/renderer-hardening.spec.ts`; zakaz wykonania: reguła lintu dla `core/` i `adapters/` (`child_process`, `worker_threads`, `vm`, `cluster`, `require`, `import()`, `new Function`), 7 prób w `scripts/verify-boundaries.mjs`, test statyczny `no-exec-static.test.ts`; brak cichego nadpisania: `write-gate.test.ts` (odmowy na starcie) | spełnione |
| 4 | Tabela bezpieczników w raporcie Etapu 9; brakujące kolumny pozytywne dopisane: blokada sieci (`network-block.test.ts`), harness z nazwami myląco podobnymi i katalogiem tymczasowym (`isolation-harness.test.ts`), wolne miejsce wystarczające i nieznane (`write-gate.test.ts`), limity IPC i planu eksportu (`ipc-limits.test.ts`), wykrywacz wykonania i wykrywacz przecieków w fixture'ach (oba z próbą w obie strony) | spełnione |
| 5 | `tests/unit/fixture-hygiene.test.ts` (nazwy `acme-*`, brak ścieżek domowych, adresów i kluczy); job „Skan sekretow (cala historia)” z `fetch-depth: 0` i `--log-opts="--all --full-history"`: 64 commity, bez wycieków (przebieg `42840056457`) | spełnione |
| 6 | Job `dist` w `ci.yml`, niezależny od E2E: `electron-builder` z tymi samymi flagami co `release.yml`, `SHA256SUMS` liczone i sprawdzane, instalacja jak u użytkownika (DMG przez `ditto` z kontrolą `lipo`, NSIS `/S`, deb przez `apt`) i `tests/smoke/dist-smoke.test.ts` na zainstalowanej binarce, na czterech celach. Przebieg `42889995454` (commit `7f62d5d`): `paczka linux-x64`, `paczka macos-arm64` (lipo: arm64), `paczka macos-x64` (lipo: x86_64), `paczka windows-x64` zielone. AppImage: krok informacyjny, rozpakowany AppImage bez `--no-sandbox` pada na Ubuntu 24.04 (pomocnik SUID nie jest skonfigurowany), co trafia do README w Etapie 10; dowodem dla Linuksa jest deb | spełnione |
| 7 | `tests/property/round-trip.test.ts`: skill, komenda, agent, hook i instrukcja globalna dla obu narzędzi, przez prawdziwy `WriteGate` i skan adaptera; wyjątki `partial` i `lossy` w `expectationFor` z odwołaniem do ADR, sprawdzane razem z werdyktem; 25 przebiegów na przypadek w CI, lokalnie 400 | spełnione |

Błędy znalezione w tym etapie i poprawione: werdykt agenta nie zapowiadał dopisanych pól `name`
i `description` (test property-based); po przerwanym `apply` plik tymczasowy zostawał w drzewie
narzędzia na zawsze (`sync-interrupted.test.ts`); lista architektur macOS w `electron-builder.yml`
wygrywała z flagą, więc oba runnery macOS budowały oba DMG, a scalone `SHA256SUMS` miało dwie
sumy dla jednego pliku; build Linuksa padał na pustym katalogu `resources/icons`.

### Etap 10: Dokumentacja i wydanie MVP

Zakres: README z instalacją i uruchomieniem, dokumentacja architektury (aktualizacja tego
dokumentu i ADR-ów), lista obsługiwanych formatów, lista ograniczeń konwersji, procedura backupu
i odzyskiwania, build instalacyjny, weryfikacja instalacji od zera.

Kryteria akceptacji:
1. README pozwala osobie, która nie zna projektu, zainstalować i uruchomić aplikację na każdej
   z trzech platform, razem z instrukcją obejścia Gatekeepera i SmartScreena (ADR 0003).
2. Ograniczenia konwersji są opisane jawnie, per typ elementu i per narzędzie, razem
   z ograniczeniem segmentera TOML. Nie w formie "mogą wystąpić problemy".
3. Procedura odzyskiwania danych bez aplikacji jest opisana i sprawdzona: użytkownik odtwarza
   pliki z `backups/` ręcznie.
4. Instalacja od zera na czystym systemie każdej z trzech platform została wykonana i opisana.
5. Wydanie zawiera `SHA256SUMS` i nie zawiera żadnej funkcji opisanej jako gotowa, która jest
   atrapą.

Dowody (stan na 2026-11-11):

| Kryterium | Test albo dokument | Status |
|---|---|---|
| 1 | `docs/INSTALACJA.md` (wybór pliku DMG arm64 i x64, obejście Gatekeepera w dwóch wariantach z `xattr`, obejście SmartScreena, deb zalecany, AppImage na Ubuntu 24.04 z `--no-sandbox` i jego konsekwencją dla bezpieczeństwa, weryfikacja `SHA256SUMS` na trzech systemach, `npm ci` i `npm run dev`, katalogi `userData` na trzech systemach i ich zawartość, zakres z ADR 0032) oraz odnośniki w `README.md`. Ścieżki `userData` sprawdzone na macOS przez `app.getPath('userData')`, wzorzec polecenia sum na macOS; kroki obejść opisane według dokumentacji systemów, wynik na czystych systemach należy do kryterium 4 | spełnione dla treści; wykonanie na czystych systemach w kryterium 4 |
| 2 | `docs/OGRANICZENIA.md`: tabela typ elementu i narzędzie wyprowadzona z `claudeCapabilities` i `codexCapabilities` (`src/adapters/*/export.ts`), segmenter TOML z listą konstrukcji powodujących odmowę zgodną z `SegmentTomlEditor.checkScanned`, markery `ai-skills-manager` i reguły `applyMarkerBlock`, MCP (ADR 0020), sieroty (ADR 0034). Zachowania z dokumentu sprawdzone w kodzie: zablokowany eksport skilla nad zwykłym katalogiem (probe), dopisanie drugiego bloku po edycji zaimportowanej instrukcji (`applyMarkerBlock`) | spełnione |
| 3 | `docs/ODZYSKIWANIE.md` i `tests/integration/recovery-procedure.test.ts`: kopia z prawdziwego `WriteGate` (zmiana pliku z trybem, nowy plik w nowym katalogu, dowiązanie do katalogu, plik zastąpiony dowiązaniem), kroki A1 do A4 wykonane samym `node:fs`, drzewo porównane przez `treeHash` bajt w bajt razem z trybami i celami dowiązań; A5 z `objects/`; D1 dla dowiązania wskazującego w próżnię; B1 do B3 dla elementu biblioteki i poprzedniej wersji z `objects/`; C dla indeksu w kwarantannie. Test widziany jako czerwony po usunięciu kroku `chmod` | spełnione |

#### Kryteria 4 i 5: dowody (pipeline wydania i atrapy)

Status etapu: **wydany, z jednym krokiem otwartym**. Wydanie
[v0.1.0](https://github.com/konradxmalinowski/universal-ai-skills-manager/releases/tag/v0.1.0)
opublikowane 2026-11-11 z commita `6d83a46` (przebieg `release.yml` `43018775505`, CI `main`
zielone na czterech celach i czterech paczkach). Wydanie ma osiem plików i `SHA256SUMS`;
suma DMG arm64 sprawdzona po pobraniu. Kryteria 1–5 mają dowód poniżej. Otwarty zostaje krok
ręczny z checklisty na końcu: pierwsze uruchomienie pobranych plików przez Gatekeepera
i SmartScreen nie zostało wykonane i jest wymienione w notatce wydania jako znane ograniczenie.

**Pipeline wydania** (`.github/workflows/release.yml`). Tag `v*` uruchamia: `preflight` (tag
musi równać się `v` + wersja z `package.json`), `build` na czterech celach z flagami jak w jobie
`dist`, `collect` (scala sumy w jedno `SHA256SUMS`, sprawdza je `sha256sum -c` na plikach po
przejściu przez artefakty, wymaga unikalnych nazw i zgodności listy plików z sumami) oraz
`publish`, jedyny job z `contents: write`, który robi `gh release create --draft --verify-tag`.
Wydanie nigdy nie jest publikowane przez workflow. `workflow_dispatch` z `dry_run=true`
(domyślnie) wykonuje wszystko poza `publish`. Poprawki znalezione przy przeglądzie pod kątem
pierwszego tagu: `latest*.yml` wyłączone (`publish: null`, dwa runnery macOS nadpisywały sobie
`latest-mac.yml`); nazwy plików z productName zawierały spacje, a GitHub zamienia je w zasobach
na kropki, więc `SHA256SUMS` nie pasowałoby do pobranych plików (nazwy teraz bez spacji,
`artifactName` w `electron-builder.yml`).
Przebieg próbny: `42893023897` (commit `7c5dc44`), cztery cele, `collect` zielony, `publish`
pominięty. Zebrane pliki: deb, AppImage, DMG i ZIP dla arm64 i x64, instalator NSIS i wersja
portable, razem z jednym `SHA256SUMS` (osiem plików, osiem sum, wszystkie `OK`). Nieprzetestowane
bez tagu: sam krok `gh release create` (nie da się go uruchomić bez tagu i bez tworzenia wydania).

**Kryterium 4: instalacja od zera.** Job `paczka <cel>` w `ci.yml`, przebieg `42893003790`
(commit `7c5dc44`), cztery cele zielone. Każdy runner to czysta maszyna wirtualna. Kroki:
`npm ci` i build, `electron-builder` z flagami wydania, `SHA256SUMS` policzone i sprawdzone,
instalacja artefaktu jak u użytkownika (macOS: montowanie DMG i `ditto` do katalogu aplikacji
oraz `lipo -archs` zgodne z celem; Windows: instalator NSIS z `/S`; Linux: `apt install` pakietu
deb), potem `tests/smoke/dist-smoke.test.ts` na zainstalowanej binarce. Czysty start: aplikacja
leży poza drzewem repozytorium (katalog tymczasowy runnera albo `/opt`), więc nie ma
`node_modules` w jej ścieżce; `userData` to nowy katalog z `createTempTree`, a test wymaga, by
`index.db` powstał od zera z migracjami 1 do 4 i by drugi start ich nie dublował. Podane jest
`--user-data-dir`, więc domyślna ścieżka `userData` systemu nie jest tu sprawdzana.

Czego CI **nie** sprawdza: interakcji z Gatekeeperem i SmartScreenem (runner instaluje bez GUI i
bez atrybutu kwarantanny), pierwszego uruchomienia dwuklikiem z Findera, Eksploratora i menedżera
plików, AppImage na systemie z pomocnikiem sandboxa (krok informacyjny, na Ubuntu 24.04 pada
bez `--no-sandbox`, dowodem dla Linuksa jest deb), instalacji portable.

**Kryterium 5: brak atrap.** Przejrzane miejsca:
- `src/shared/ipc/channels.ts`: kanały bez handlera `diff:compute`, `profiles:list`,
  `profiles:save`, `profiles:export-plan`, `settings:get`, `settings:set` **usunięte** (żaden
  kod renderera ani maina ich nie wołał). `IMPLEMENTED_CHANNELS` jest teraz tą samą listą co
  `IPC_CHANNELS`, a rejestr przy starcie odmawia, gdy któryś kanał nie ma handlera.
- Zdarzenia `progress` i `operation-log`: zadeklarowane i wystawione w moście, ale `main` nie
  nadawał ich nigdzie (brak `webContents.send`), a renderer nie miał subskrybenta. **Usunięte**
  razem z gałęzią `events` mostu (`surface.ts`, `bridge.ts`).
- Testy: `tests/unit/ipc-surface.test.ts` i `tests/e2e/renderer-hardening.spec.ts`; test
  hartowania sprawdza teraz, że most nie ma `diff`, `profiles`, `settings` ani `events`, że jest
  zamrożony i że ma dokładnie przestrzenie nazw z listy.
- Widoki renderera (`src/renderer/app/features`): biblioteka, import, eksport, synchronizacja,
  historia, diagnostyka; brak widoku profili i ustawień, brak przycisków do nich (potwierdza
  też `controls-inventory.spec.ts` z Etapu 8).
- `docs/ARCHITECTURE.md` 7.2 i dwa zdania w tym dokumencie, które wspominały o kanale bez handlera.
- `README.md`, sekcja „Co aplikacja robi dzis”: wymienia tylko biblioteke, import, eksport,
  synchronizację z historią i diagnostykę, co odpowiada widokom; zastrzeżenia (tylko konfiguracje
  globalne, bez MCP, bez usuwania plików w narzędziach) są jawne. Zdanie „Etapy 1 do 5 są w kodzie,
  to nie jest jeszcze wydanie” zostaje do przepisania przez `docs-agent` przy kryterium 1.
- Wyniki lint, typecheck, `npm test` (1197 testów), `test:boundaries` (32 próby) i build zielone.

**Do zrobienia ręcznie przez właściciela przed publikacją wydania:**
1. Upewnić się, że kryteria 1–3 są na `main`, a `package.json` ma wersję równą tagowi.
2. Utworzyć tag `vX.Y.Z`; workflow zostawia **szkic**. Sprawdzić w nim osiem plików i `SHA256SUMS`.
3. macOS (osobno arm64 i x64, najlepiej czysty użytkownik): pobrać DMG przeglądarką (ustawia
   kwarantannę), przeciągnąć aplikację do Programów, uruchomić dwuklikiem, zobaczyć ostrzeżenie
   Gatekeepera, obejść je wg README (menu kontekstowe „Otwórz” albo `xattr -d
   com.apple.quarantine`), sprawdzić start i działanie biblioteki.
4. Windows: pobrać instalator przeglądarką, uruchomić dwuklikiem, przejść SmartScreen („Więcej
   informacji”, „Uruchom mimo to”), zainstalować, uruchomić ze skrótu; osobno sprawdzić wersję
   portable.
5. Linux: `sudo apt install ./plik.deb`, uruchomić z menu aplikacji; AppImage jeśli README go
   zaleca (uwaga na sandbox).
6. Zweryfikować `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c`) na pobranych plikach.
7. Dopiero po tym opublikować szkic i zamknąć status Etapu 10.

### Zmiana nazwy na CWM: v0.2.0 (ADR 0035)

Wydanie v0.1.0 zostało opublikowane pod nazwą Universal AI Skills Manager i tak zostaje;
opisy Etapu 10 wyżej dotyczą tej nazwy. Pierwsze wydanie pod nazwą `CWM - Claude Workspace
Manager` ma być v0.2.0. Zakres: nazwa produktu i techniczna `cwm`, `userData` w
`<appData>/CWM` z migracją kopią z katalogu v0.1.0, nowe markery i format kopii z odczytem
starych, nowy `appId` (na Windowsie instalacja obok v0.1.0), zmiana nazwy repozytorium.

Stan: zmiana jest w pracy na gałęzi `feat/rename-to-cwm`, nie jest scalona ani wydana.
Dokumentacja użytkownika (`README.md`, `docs/INSTALACJA.md`, `docs/ODZYSKIWANIE.md`,
`docs/OGRANICZENIA.md`) opisuje stan docelowy v0.2.0. Wyniki weryfikacji, w tym dowody
zgodności formatów i migracji, trafią tu po jej wykonaniu.

---

## 4. Backlog po MVP

W kolejności według stosunku wartości do ryzyka, nie według atrakcyjności.

| Pozycja | Powód |
|---|---|
| Eksport do ZIP | Wymagania wymieniają to jako funkcję kolejną. Tanie, bo plan eksportu już istnieje |
| Integracja z Git jako warstwa opcjonalna | Wymagania wprost: warstwa dodatkowa, nigdy wymóg (ADR 0019) |
| Podpisanie i notaryzacja wydań | Warunek autoaktualizacji i usunięcia ostrzeżeń systemowych (ADR 0003) |
| Autoaktualizacja | Po podpisaniu. `latest.yml` jest generowany od MVP, więc to konfiguracja |
| Trzeci adapter | Prawdziwy test założenia 10 z wymagań. Dopiero on pokaże, czy kontrakt adaptera jest dobry |
| Eksport raportu diagnostycznego z redakcją ścieżek i nazw | Żeby zgłoszenia błędów nie wymagały ręcznej anonimizacji w publicznym repozytorium (ADR 0004) |
| Reguły bezpieczeństwa i zakresów dla MCP | Warunek odblokowania synchronizacji MCP. Osobny ADR, osobny etap (ADR 0020) |
| DPAPI na Windowsie | Warunek dla jakiejkolwiek funkcji przechowującej sekrety (ADR 0018) |
| Limit rozmiaru i czyszczenie content store | Świadomie odroczone (ADR 0027). Dołożą politykę nad istniejącym store'em, nie zmienią modelu danych. Usuwanie wymaga liczenia referencji, nie wieku obiektu |
| Konfiguracje projektowe | Zaplanowane po MVP (ADR 0032). Wymagają wpisu w `CANDIDATES` i kanału wyboru katalogu, czyli nowego ADR |
| Import z repozytorium Git jako źródła skilli | Wymagania o tym wspominają w kontekście bezpieczeństwa; funkcja wymaga pełnej ścieżki traktowania treści jako niezaufanej, która w MVP już istnieje |
| Ikona aplikacji w finalnej formie | Zależy od odpowiedzi na pytanie 6 |

### Znane ograniczenia

Rzeczy, o których wiemy, że działają gorzej, niż by mogły, i które nie blokują MVP. Każda ma
miejsce w kodzie albo ADR, w którym jest opisana.

| Ograniczenie | Gdzie |
|---|---|
| Kandydat z kolizją `lower(slug)` jest przy imporcie pomijany jako `conflict`, a kreator nie pozwala zmienić sluga, żeby go mimo to przyjąć | `ImportService.apply`, ADR 0017 |
| Pierwszeństwo dwóch rootów skilli Codeksa (`~/.codex/skills` jako główny) przyjęte bez dokumentacji Codeksa, na podstawie sondy | ADR 0024, `tests/integration/locations.test.ts` |
| Dla plików współdzielonych (blok między markerami, segment TOML, klucz JSON) zmiana w narzędziu jest wykrywana tylko po istnieniu pliku, nie po jego treści | `SyncService.inspectFile` |
| Dla dowiązania status nie widzi zmiany treści materializacji w `userData`, tylko samo dowiązanie | `SyncService.inspectLink`, ADR 0015 |
| Po cofnięciu pierwszego eksportu materializacja zostaje w `userData/materialized/` | `src/infra/fs/link-mode.ts`, ADR 0034 |
| Zmiana samej wartości sekretu jest niewidoczna w zredagowanym diffie, bo obie strony dają ten sam znacznik | `redactSecrets`, ARCHITECTURE 8.4 |
| Reguła lintu zakazuje `child_process` w `core/`, `adapters/` i `renderer/`, ale nie w `main/`, `infra/` i `preload/` | `eslint.config.mjs`, ADR 0008 |
| Slug jest tylko ASCII, więc nazwa z polskimi literami dostaje slug przybliżony, a oryginał trafia do aliasów | `validate.ts`, R7 |
| Kopia reguły zawierania w `tests/harness/isolation.ts` blokuje za dużo | `tests/harness/isolation.ts`, ARCHITECTURE 12.5 |
| Kanarek harnessu na `~/.claude.json` daje fałszywe alarmy, gdy Claude Code zapisuje ten plik w trakcie sesji | `tests/harness/isolation.ts` |
| Rzadki zawis E2E na macOS arm64 w CI (raz na około 30 przebiegów, przebieg `43013946705`): wisi najpewniej `app.close()` w `app-launch.spec.ts:26`, nie start. Nie odtworzony lokalnie. Plan: zamknięcie z limitem 15 s, które zapisuje stan procesu, stos (`sample <pid>`) i ogon stderr, a potem zabija proces | `tests/e2e/launch.ts` |
| Zgodność indeksu z plikami przy starcie sprawdza tylko liczba elementów; nieudana aktualizacja indeksu przy zgodnej liczbie zostawia starą treść do ręcznej odbudowy | `syncIndex` w `LibraryService`, Etap 2 |

---

## 5. Ryzyka techniczne

Poziom: prawdopodobieństwo razy skutek. Mitygacja jest zadaniem w konkretnym etapie, nie intencją.

### R1: Edycja TOML z zachowaniem formatowania. Poziom: WYSOKI

Brak format-zachowującego parsera TOML w ekosystemie JavaScriptu. Skutek realizacji: uszkodzony
`config.toml` użytkownika, czyli utrata konfiguracji, której aplikacja miała pilnować. To jest
najgorszy możliwy błąd tego produktu.

Mitygacja (Etap 4, ADR 0011): preflight odmawiający edycji poza zakresem, weryfikacja semantyczna
po zapisie przed dotknięciem dysku, minimalizacja zakresu zarządzanego do trzech linii na agenta.
Trzy ranked ścieżki wyjścia, gdyby ograniczenie okazało się nieakceptowalne.

Wczesny sygnał: preflight odmawia edycji na realnych plikach użytkowników.

### R2: Moduł natywny `better-sqlite3` na czterech celach. Poziom: NISKI, z jednym elementem dziedziczonym przez Etap 2

Brak prebuildu dla pary wersja Electrona plus platforma wymusza kompilację i pełny toolchain
na runnerze. Skutek: build nie przechodzi, potencjalnie w dniu wydania.

Mitygacja (Etap 1, ADR 0007 i 0010): macierz czterech celów działa od Etapu 1, a kryterium
akceptacji Etapu 1 obejmuje otwarcie bazy w zbudowanej aplikacji na każdym celu. Baza siedzi
za portem `IndexStore`, więc wymiana jest możliwa, a dane nie są w bazie (ADR 0014), więc wymiana
nie oznacza migracji.

#### Stan: domknięte przebiegiem `39525840100` na commicie `e34367a`

Cała macierz zielona, wszystkie sześć zadań, włącznie z `windows-x64`. Na Windowsie 48 testów
jednostkowych, kontraktowych i integracyjnych oraz 14 z 14 E2E w 8,2 sekundy, przy poprzednim
przebiegu na tym celu wynoszącym 4,1 minuty samych limitów.

Dowód stoi na trzech testach w `tests/e2e/packaged-db.spec.ts`, zielonych na czterech celach
w jednym przebiegu:

| Test | Co dowodzi | Czas |
|---|---|---|
| `:99` | moduł natywny ładuje się i wykonuje zapytania przy **zwykłym** starcie zapakowanej aplikacji | 268 ms |
| `:111` | drugi start nie duplikuje wpisu w rejestrze migracji, czyli migracja jest idempotentna w paczce | 533 ms |
| `:132` | binding w paczce jest tym samym plikiem, który ładuje proces testu, a FTS5 w tym procesie działa | 6 ms |

**Dowód jest deterministyczny i sprawdzony w obie strony.** Po wyłączeniu migracji przy otwarciu
test pada z komunikatem `zapakowana aplikacja nie zalozyla schematu`, po przywróceniu przechodzi
w 270 ms. To jest różnica wobec poprzedniego narzędzia, które zawodziło losowo i nigdy nie zostało
sprawdzone pod kątem tego, czy w ogóle potrafi paść z właściwego powodu.

#### Dlaczego R2 nie stanęło na starych testach, choć one też przeszły

Dwa stare testy przez protokół debugowania przeszły w tym samym zielonym przebiegu. R2 celowo
na nich nie stanęło, bo ich zielony wynik jest trafieniem, nie dowodem: wcześniej ten sam zawis
startu paczki odtworzył się lokalnie na macOS (pada drugi start tej samej paczki w pełnym przebiegu
E2E, co drugi albo co trzeci raz, w izolacji przechodzi zawsze), a powtórka wcześniej zielonego
zadania `windows-x64` na niezmienionym commicie `1b22da6` padła, więc nie było ani regresji,
ani winowajcy w commitach.

To jest najczystsza ilustracja czwartej reguły dowodzenia (ARCHITECTURE sekcja 12.6): zielony
wynik z narzędzia o nieznanej niezawodności nie jest dowodem, dopóki nie wiemy, jak często to
narzędzie zawodzi. Zielony wynik niewiarygodnego narzędzia nie staje się dowodem przez to, że
wiarygodne narzędzie obok pokazuje to samo.

Te dwa testy zostały następnie **usunięte, a nie pominięte**, bo pominięty test udaje, że coś
sprawdza. Ich dawne pokrycie (moduł natywny z `app.asar.unpacked`, brak dostępu renderera do Node,
odpowiedzi IPC bez ścieżek absolutnych) jest w trzech innych plikach E2E, a warunek ich powrotu
jest zapisany w `README`: wracają, jeśli przyłączanie Playwrighta do zapakowanego Electrona stanie
się wiarygodne, bo problemem była niezawodność narzędzia, nie sens tych asercji. **Nie powołujemy
się na nie jako na dowód w żadnym miejscu tej roadmapy.**

#### Potwierdzenie na implementacji ADR 0029

Przebieg `39527689189` na commicie `f6f93a5` jest zielony w całości: cztery cele macierzy plus
lint i skan sekretów, 14 testów E2E na Windowsie w 8,3 sekundy. Triaż awarii indeksu, kwarantanna
i kolejność startu z ADR 0029 są w kodzie i nie naruszyły dowodu na moduł natywny.

#### Jedyny element otwarty: bezpośredni dowód FTS5 w paczce

Zastrzeżenie zostaje w mocy i jest widoczne w samej nazwie testu `:132`, która mówi wprost, że
dowodzi identyczności pliku bindingu i działania FTS5 **w procesie testu**, a nie w zapakowanej
aplikacji. Inferencja jest mocna (porównanie SHA-256 pokazuje, że to ten sam plik), ale to nadal
inferencja.

Tabele `startup_probe` i `startup_probe_fts` istniały wyłącznie po to, żeby test miał co sprawdzać,
czyli były tym samym wzorcem co flaga diagnostyczna w kodzie produkcyjnym, tylko schowanym
w schemacie bazy. Zostały usunięte, a schemat w wersji 1 to sam rejestr migracji. Wybór jest
świadomy: wolimy jeden element otwarty o etap dłużej niż tabelę w schemacie produkcyjnym, której
jedynym użytkownikiem jest asercja (ARCHITECTURE sekcja 12.6).

**Zadanie dziedziczone przez Etap 2, z terminem, nie dług bez terminu:** pierwsza prawdziwa tabela
pełnotekstowa biblioteki musi mieć test wykonujący zapytanie FTS **wewnątrz zapakowanej
aplikacji**, nie w procesie testu. Jest to kryterium akceptacji Etapu 2, a nie zadanie "przy
okazji". W tym momencie R2 domyka się w całości i wypada z listy ryzyk.

Stan na 2026-11-05: test jest (`tests/e2e/packaged-db.spec.ts`, tabela `items_fts` z migracji 4)
i przechodzi lokalnie na macOS. R2 wypada z listy po zielonym przebiegu CI na czterech celach.

#### Awaria Windowsa z pierwszego przebiegu i jej ogólniejszy wniosek

Pierwsza awaria `windows-x64` wzięła się z mechanizmu, który sam zaprojektowałem: harness izolacji
odmawia startu, gdy katalog bazowy testów leży w żywej konfiguracji (ARCHITECTURE sekcja 12.2).
Na runnerze trafił fałszywie dodatnio na katalog roboczy CI. Mechanizm zadziałał zgodnie
z zamysłem, czyli odmówił zamiast ryzykować, i to jest dobra strona tej awarii. Zła strona: jego
warunek był napisany pod maszynę dewelopera. Poprawka należała do warunku, nie do reguły.

Wniosek jest ogólniejszy niż R2 i dlatego trafił do strategii testowania jako reguła projektowa
(ARCHITECTURE sekcja 12.5): bezpiecznik chroniący konfigurację użytkownika sam stał się punktem
awarii na platformie, której nie przewidziano, a dziewięć testów sprawdzających, że blokuje, nie
mogło tego wykryć, bo żaden nie sprawdzał, że przepuszcza.

### R3: Symlinki i uprawnienia na Windowsie. Poziom: ŚREDNI

Symlink wymaga trybu dewelopera, junction działa tylko dla katalogów, ACL nie jest ustawiany
przez `chmod`. Skutek: na Windowsie element nie propaguje zmian albo ochrona katalogu danych
jest fikcją.

Mitygacja (Etap 1 i 4, ADR 0015 i 0018): degradacja symlink, junction, kopia, z wykrywaniem
zdolności przez próbę, z trybem widocznym w interfejsie. ACL przez `icacls` z weryfikacją
i raportowaniem niepowodzenia zamiast milczenia. Testy na `windows-latest`, czyli bez uprawnień
administratora.

Co zmienił Etap 2, kawałek A (ADR 0031): zapis biblioteki dokłada dwie zależności od Windowsa,
których nikt tam jeszcze nie uruchomił. Pierwsza to `rename` katalogu z plikiem otwartym przez
antywirus lub indekser; kod ponawia go pięć razy w odstępach 25 do 400 ms i kończy błędem `busy`
ze starym stanem na miejscu, ale logikę sprawdzono szwem, nie NTFS. Druga to twarde linki dla
niezmienionych plików, z kopią tam, gdzie linku nie ma (FAT, SMB). Pierwsza jest do potwierdzenia
przez macierz CI; drugiej macierz nie sprawdzi, bo nie ma w niej takiego woluminu. Poziom ryzyka bez
zmiany; do zielonego przebiegu zapis biblioteki na Windowsie pozostaje nieudowodniony.

### R4: Dryf formatów obsługiwanych narzędzi. Poziom: WYSOKI

Claude Code 2.1.303 i codex-cli 0.158.0 to narzędzia o szybkim cyklu wydań, a część ich zachowań
nie jest udokumentowana. Skutek: aplikacja cicho gubi elementy albo pisze pliki, których
narzędzie nie przyjmuje.

Dowód z tego audytu, mocniejszy niż wyglądał w trakcie: `~/.agents/skills` to realny, wbudowany
root skilli Codeksa, nieobecny w `config.toml`, który dawał 55 zduplikowanych nazw w drzewie
skilli. Został usunięty sześć godzin przed audytem, więc audyt go nie zobaczył i zgłosił
niepewność. Root może więc zniknąć i wrócić bez udziału użytkownika, na przykład przy aktualizacji
narzędzia (ADR 0024).

Mitygacja (Etap 3 i 4): `unmappedKeys` obowiązkowe w modelu (ADR 0023), czyli nieznany klucz jest
raportowany, nie pomijany. Adapter deklaruje wersję narzędzia, na której był weryfikowany,
a Diagnostics porównuje ją z wykrytą i ostrzega przy rozbieżności. Warstwa lokalizacji raportuje
roots, których nie znalazła, i zgłasza pojawienie się roota, którego wcześniej nie było, jako
zmianę stanu środowiska (ADR 0022, 0024). Weryfikacja po zapisie jest częścią kontraktu
(ADR 0013).

### R5: Nieudokumentowane zachowania Codeksa. Poziom: ŚREDNI

Siedem zachowań potwierdzonych wyłącznie sondą, nie dokumentacją: struktura `hooks.json`, brak
rozwijania zmiennych w `mcp_servers.*.env`, brak przekazywania środowiska rodzica, zawartość
`[projects."..."]`, czytanie symlinkowanych katalogów skilli, rozwijanie tyldy w `config_file`,
brak potwierdzenia rozwijania `$HOME` w komendzie hooka. Każde z nich może się zmienić bez
ostrzeżenia.

Mitygacja (Etap 3): każde z tych zachowań dostaje test regresyjny z zapisaną datą i wersją
narzędzia, w którym je potwierdzono. Tam, gdzie zachowanie nie jest potwierdzone (rozwijanie
`$HOME` w Codeksie), używamy wariantu bezpiecznego (ścieżki absolutne) i zapisujemy, dlaczego.

### R6: Scalanie instrukcji globalnych. Poziom: NISKI (obniżony z ŚREDNIEGO)

`~/.claude/CLAUDE.md` i `~/.codex/AGENTS.md` to pojedyncze pliki. Eksport nie jest kopiowaniem.
Bez jawnej polityki pierwszy eksport nadpisałby treść pisaną ręcznie przez użytkownika.

Mitygacja (Etap 4, ADR 0025): zarządzany jest wyłącznie blok między markerami aplikacji.
Nadpisanie treści użytkownika przestaje być możliwe, bo zapis dotyczy tylko tego zakresu, a brak
markerów prowadzi do dopisania na końcu, nigdy do przepisania pliku. Precedens na tej samej
maszynie: antislop zainstalowany przez `<!-- antislop:start -->` i `<!-- antislop:end -->`
w obu plikach, potwierdzony odczytem.

Co zostaje z ryzyka: plik, w którym użytkownik wklejał ręcznie treść, którą aplikacja chce teraz
zarządzać, a która nie ma markerów. Ten przypadek wymaga decyzji użytkownika i nie wolno go
rozstrzygać automatycznie, bo jedyną automatyczną odpowiedzią byłoby zduplikowanie treści albo
nadpisanie jej.

### R7: Kolizje tożsamości slug kontra declaredName. Poziom: ŚREDNI

Claude kluczuje po katalogu, Codex po `name` z frontmattera. Realny przypadek w audytowanym
drzewie: aliasy, w których dwa katalogi wskazują ten sam `SKILL.md`. Skutek: element pojawia się
w Codeksie dwa razy pod tą samą nazwą albo pod inną niż w Claude.

Mitygacja (Etap 2 i 3, ADR 0023 i 0026): oba identyfikatory w modelu, dedup po `realpath` przy
skanowaniu (port z generatora), rozjechanie jako ostrzeżenie rozstrzygane per narzędzie przy
eksporcie. Po Etapie 2, kawałku A, część modelowa jest w kodzie: walidator zwraca ostrzeżenie
`slug-differs-from-declared-name` zamiast błędu, a kolizja `lower(slug)` + typ blokuje zapis.
Skutek uboczny dla Etapu 3: slug jest ASCII (litery, cyfry, `.`, `_`, `-`, najwyżej 64 znaki),
więc import katalogu o innej nazwie musi wyliczyć slug, a oryginał zachować w `declaredName`
albo `aliases`. To decyzja do podjęcia przy projektowaniu importu, nie rozstrzygnięta tu. Import nie prostuje nazwy, bo wymuszanie zgodności zablokowałoby przyjęcie poprawnego
skilla Claude'a.

Co zostaje z ryzyka: użytkownik może ostrzeżenie zignorować i dostać w Codeksie element pod nazwą,
której nie szuka. Dlatego konsekwencja musi być widoczna w planie eksportu jako skutek, nie jako
notka techniczna. Osobny, nierozstrzygalny automatycznie przypadek: dwa różne pliki deklarujące
ten sam `declaredName` to konflikt w planie, nie do rozwiązania bez decyzji.

### R8: Heurystyka rozpoznawania elementów na obcych drzewach. Poziom: ŚREDNI

Reguła "skillem jest katalog z `SKILL.md`" jest sprawdzona na drzewie właściciela (poprawnie
odrzuca 9 katalogów referencyjnych). Na obcym drzewie o innej strukturze może zawieść. Podobnie
heurystyka opisu dla płaskich plików.

Mitygacja (Etap 3): podgląd przed importem z możliwością odznaczenia, oznaczenie
`descriptionOrigin: 'derived'` dla wszystkiego wyliczonego, i raport w Diagnostics o elementach
rozpoznanych nietypowo. Użytkownik widzi decyzję aplikacji przed jej skutkiem.

### R9: Rozmiar paczki i czas budowania. Poziom: NISKI

Electron daje paczkę rzędu 100 MB i wieloletni czas budowania macierzy. Skutek: dłuższy cykl
i większy pobierany plik. Zaakceptowane (ADR 0001).

---

## 6. Ryzyka bezpieczeństwa

### S1: Wyciek sekretu do biblioteki, diffa lub logu. Poziom: KRYTYCZNY

Aplikacja czyta katalogi, w których realnie leżą dane uwierzytelniające (`~/.codex/auth.json`,
sekcje `env` w `config.toml`). Skutek: sekret trafia do biblioteki, którą użytkownik commituje
do repozytorium, albo do logu, który dołącza do zgłoszenia błędu.

Mitygacja (Etap 3 i 5, ADR 0018): trzy osobne mechanizmy w trzech miejscach. Klasyfikator przy
skanowaniu z domyślnym wykluczeniem. Redakcja w main przed wysłaniem do renderera, więc diff jest
liczony na treści zredagowanej. Redakcja w loggerze, czyli na poziomie infrastruktury, więc
serwis nie może zalogować sekretu, nawet gdyby chciał. Testy jako asercje negatywne na zawartości
ładunku IPC i pliku logu.

### S2: Path traversal i zapis poza dozwolonym katalogiem. Poziom: KRYTYCZNY

Nazwy i ścieżki pochodzą z niezaufanej treści. Skutek: zapis do dowolnego miejsca w systemie
plików użytkownika.

Mitygacja (Etap 1, 2 i 5, ADR 0008, 0012 i 0031): architektonicznie, nie przez walidację stringów.
Renderer nie przekazuje ścieżek, tylko nieprzezroczysty `rootId`, więc nie istnieje kanał,
przez który ścieżka mogłaby wejść. `WriteGate` kanonizuje przez `realpath` i sprawdza prefiks,
odrzuca UNC i `\\?\`, nazwy zarezerwowane Windowsa, NUL i znaki kontrolne. Skanowanie odmawia
podążania za symlinkiem wyprowadzającym poza root.

Co zmienił Etap 2, kawałek A: powstała druga droga zapisu, do własnej biblioteki, więc S2 nie
opiera się już wyłącznie na `WriteGate`. Ścieżki assetów przychodzą z niezaufanej treści i są
sprawdzane dwa razy: walidatorem w core (zestaw reguł z sekcji 12.5) i, jako obrona w głąb,
w magazynie plików (`assertPlan` z tą samą kontrolą zawierania co `main`); `id` elementu musi być
przenośną nazwą jednego katalogu. Dowiązania w katalogu elementu są odrzucane w całości.

### S3: Wykonanie importowanego kodu. Poziom: KRYTYCZNY

Skille i hooki zawierają komendy. Skutek: wykonanie dowolnego kodu z uprawnieniami użytkownika.

Mitygacja (Etap 1, ADR 0008): architektonicznie. Hooki i skrypty są tekstem i nigdy nie są
uruchamiane. `node:child_process` jest zabronione w `core/` i `adapters/` regułą lintu, która
wywala CI. Jedyne dopuszczone wołanie procesu potomnego to `icacls` w `infra/platform`, bez
żadnego argumentu pochodzącego z danych wejściowych (ADR 0018). Test statyczny potwierdza, że
żaden adapter nie importuje `child_process`.

### S4: Wstrzyknięcie przez podgląd Markdown. Poziom: WYSOKI

Treść skilla jest wyświetlana i jest obca. Skutek: wykonanie skryptu w rendererze, a stamtąd
próba dojścia do mostu IPC.

Mitygacja (Etap 1, ADR 0008): CSP bez `unsafe-inline` i `unsafe-eval`, renderowanie Markdown
bez surowego HTML, brak `innerHTML`, sanityzacja, `shell.openExternal` tylko po whiteliście
schematów. Most ma zamkniętą listę kanałów, więc nawet skompromitowany renderer nie ma dostępu
do dowolnej operacji.

### S5: Niepodpisane wydania. Poziom: WYSOKI, zaakceptowany

Użytkownik nie może sprawdzić, że pobrał to, co opublikowano. Skutek: podmieniona paczka wygląda
identycznie. Zaakceptowane świadomie (ADR 0003).

Mitygacja: `SHA256SUMS` w każdym wydaniu, publikowane wyłącznie przez workflow GitHub Actions
z tagu. Podpisanie w backlogu.

### S6: Nadpisanie konfiguracji użytkownika. Poziom: WYSOKI

Aplikacja ma prawo zapisu do katalogów, w których użytkownik trzyma ręcznie pisaną konfigurację.
Skutek: utrata pracy, której aplikacja miała pilnować.

Mitygacja (Etap 5, ADR 0012 i 0019): plan przed zapisem, jawne zatwierdzenie, backup przed
operacją destrukcyjną, zapis atomowy, weryfikacja po zapisie, rollback przy niepowodzeniu,
backup katalogowy z MANIFEST czytelny bez aplikacji. Zakaz usuwania plików docelowych, których
nie ma w bibliotece.

Po Etapie 2, kawałku A, część mitygacji jest przesunięta wcześniej: prymityw zapisu atomowego
istnieje i ma testy (ADR 0031), a `WriteGate` w Etapie 5 go użyje. Zakres S6 się nie zmienia:
dotyczy konfiguracji narzędzi, nie własnej biblioteki, która ma osobną ochronę (kopia poprzedniej
wersji w `objects/` przed nadpisaniem, plan i potwierdzenie przy usunięciu).

### S7: Publiczne repozytorium jako kanał wycieku. Poziom: WYSOKI

Projekt jest budowany przeciw realnej konfiguracji właściciela, a część kodu jest przenoszona
z generatora zawierającego ścieżki, nazwy i odniesienia do infrastruktury pracodawcy. Skutek:
jednorazowy, nieodwracalny wyciek w historii gitowej.

Mitygacja (od Etapu 1, ADR 0004): fixture'y wyłącznie syntetyczne, czyszczenie każdego
przenoszonego fragmentu, `gitleaks` jako bramka w CI uruchamiany na całej historii, przegląd
ręczny przed pierwszym pushem.

### S8: Łańcuch dostaw zależności. Poziom: ŚREDNI

Aplikacja z dostępem do katalogów z sekretami i prawem zapisu do konfiguracji. Skutek:
skompromitowana zależność tranzytywna dostaje ten sam dostęp.

Mitygacja (Etap 1 i 9): minimalna lista zależności z uzasadnieniem każdej (zasada 4 z wymagań),
`package-lock.json` w repozytorium, `npm audit` w CI, zależności przypięte do wersji dokładnych
w produkcji. Blokada sieci (ADR 0008) ogranicza skutek: skompromitowana zależność w rendererze
nie ma kanału wyjścia.

---

## 7. Stan blokad

Plan zaakceptowany 2026-10-20. Z ośmiu pytań z `ARCHITECTURE.md` sekcja 15 siedem jest
rozstrzygniętych i ma własne ADR-y: 1 do 3 i 7 w ADR 0024 do 0027 (2026-10-20), 4, 5 i 8
2026-11-03 w ADR 0034, 0032 i 0033.

Otwarte zostaje jedno pytanie:

| Pytanie | Blokuje |
|---|---|
| 6. Ikona i nazwa produktu | Etap 10 (wydanie), nie prace wcześniejsze. Nazwa rozstrzygnięta w ADR 0035 (CWM), ikona nadal otwarta |
