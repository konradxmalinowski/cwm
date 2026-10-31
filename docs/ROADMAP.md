# Universal AI Skills Manager - plan i roadmapa

Dokument Etapu 0, uzupełnienie `docs/ARCHITECTURE.md`. Etapy pochodzą z
`docs/00-wymagania-zrodlowe.md`; tu dostają strukturę katalogów, kryteria akceptacji, backlog
i analizę ryzyk. Kryteria są sformułowane tak, żeby dały się sprawdzić, a nie odhaczyć.

Zasada 6 i 15 z wymagań obowiązuje w każdym etapie: funkcja, która działa tylko w interfejsie,
nie jest ukończona, a atrapy nie wchodzą do wydania opisanego jako gotowe.

---

## 1. Struktura katalogów

```
universal-ai-skills-manager/
  docs/
    00-wymagania-zrodlowe.md
    ARCHITECTURE.md
    ROADMAP.md
    adr/0001 do 0031
  .github/workflows/
    ci.yml
    release.yml
  package.json
  tsconfig.base.json
  tsconfig.main.json
  tsconfig.renderer.json
  electron-builder.yml
  eslint.config.js
  .editorconfig
  .gitattributes                    wymuszenie LF w repozytorium

  src/
    main/
      bootstrap/                    okno, CSP, blokada sieci, single instance, ACL userData
      ipc/                          rejestracja kanalow, schematy, walidacja
      services/                     orkiestracja przypadkow uzycia (cienka warstwa)
      worker/                       skan drzewa, hash, diff duzych plikow

    preload/
      bridge.ts                     contextBridge, jawna zamknieta lista kanalow

    renderer/
      app/
        core/                       klient IPC, stan (signals), routing, obsluga bledow
        design-system/
          tokens/                   kolory, odstepy, typografia, dwa motywy
          components/               przycisk, pole, tabela, modal, toast, stany operacji
        features/
          dashboard/
          library/
          agents/
          commands/
          rules/
          profiles/
          sync-center/
          diff-viewer/
          import-wizard/
          history/
          settings/
          diagnostics/
      styles/
      index.html

    core/                           domena: zero zaleznosci na electron, fs, Angular, sqlite
      model/
        item.ts                     LibraryItem i typy pochodne
        library-errors.ts           bledy walidacji i operacji biblioteki
        library-limits.ts           limity rozmiaru i glebokosci (ADR 0031)
        library-file-names.ts       nazwy tymczasowe i systemowe
        path-containment.ts         kontrola zawierania sciezek, wspolna z main
        compatibility.ts            poziomy zgodnosci
        plan.ts                     WritePlan, SyncPlan, raporty
        hook.ts
        profile.ts
      ports/
        tool-adapter.ts
        file-gateway.ts             WriteGate
        toml-editor.ts
        object-store.ts
        library-store.ts            odczyt i zapis plikow elementu
        operation-log.ts            port logu operacji (implementacja w kawalku B)
        id-generator.ts             ULID
        store-failure.ts            przyczyny awarii magazynow
        index-store.ts
        secret-classifier.ts
        clock.ts
      services/
        library/
        normalization/
        diff-merge/
        sync-planner/
        policy/                     polityki zapisu, usuwania, wykluczen
        profiles/
        history/

    adapters/
      shared/
        yaml-frontmatter/           port parsera z generatora
        markdown/
        toml/                       serializacja plus SegmentTomlEditor
        naming/                     sanityzacja, slug, kolizje wielkosci liter
      claude-code/
        locations.ts
        scan.ts
        parse.ts
        to-canonical.ts
        plan.ts
        verify.ts
      codex/
        locations.ts
        scan.ts
        parse.ts
        to-canonical.ts
        plan.ts                     agenci do dwoch miejsc, komendy na skille
        verify.ts

    infra/
      fs/
        write-gate.ts               kanonizacja, backup, tmp plus rename, weryfikacja
        link-mode.ts                symlink, junction, kopia plus wykrywanie zdolnosci
        atomic.ts                   zapis atomowy, wspolny z zapisem biblioteki (ADR 0031)
        bounded-read.ts             odczyt z limitem rozmiaru, bez dowiazan
      library/
        library-store.ts            katalog roboczy plus zamiana katalogow
        item-swap.ts                nazwy katalogow pobocznych, odzyskanie po przerwaniu
      db/
        schema/                     migracje
        index-store.ts              better-sqlite3, FTS5
        rebuild.ts                  odtworzenie indeksu z plikow
      store/
        object-store.ts             content-addressed
        backup.ts                   katalog plus MANIFEST
      platform/
        env.ts                      PlatformEnv
        locations.ts                tabela kandydatow per narzedzie i system
        permissions.ts              chmod na POSIX, icacls na Windows, raportowanie
        line-endings.ts
      logging/
        redact.ts
        logger.ts

  tests/
    harness/                        podstawianie HOME, kanarek na plikach wlasciciela
    fixtures/                       wylacznie syntetyczne drzewa, nazwy acme-*
    unit/
    contract/                       jeden zestaw przeciw kazdemu adapterowi
    integration/
    e2e/

  resources/
    icons/                          .icns, .ico, png (placeholder do decyzji wlasciciela)
```

Reguła granic, wymuszana lintem: `core/` nie importuje `electron`, `node:fs`, `better-sqlite3`
ani Angulara. `adapters/` nie importuje `node:fs` ani `node:child_process`. `renderer/` nie
importuje niczego z `main/`, `core/` ani `infra/` poza typami.

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
ale jej nie scala), profili, widoku historii (warstwa danych jest, interfejsu nie), dashboardu
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

### Etap 2: Biblioteka

Zakres: model kanoniczny (ADR 0023). Zapis i odczyt według układu danych (ADR 0014). Content
store i log operacji jako warstwa danych (ADR 0019). Lista, wyszukiwanie FTS, filtrowanie,
szczegóły, edycja, walidacja. Import pojedynczego pliku. Metadane i pliki powiązane. Walidator
kolizji wielkości liter (ADR 0017). Normalizacja końców linii (ADR 0016). Przebudowa indeksu
z plików z kwarantanną i triażem przyczyn awarii otwarcia (ADR 0029). Okno przed otwarciem
indeksu, z widokiem dla odmowy i dla odbudowy (ADR 0029, ARCHITECTURE 13.1).

**Stan (2026-10-31): kawałek A zrobiony.** Etap dzieli się na trzy kawałki: A to warstwa plików
biblioteki i content store (ADR 0031), B to indeks, C to IPC i interfejs. Kawałek A dostarcza
model elementu, porty, walidację (slug, kolizje, ścieżki assetów, `item.json` z dysku), normalizację
końców linii, `LibraryService` (tworzenie, edycja, lista, plan i zastosowanie usunięcia, dwie
akcje naprawy elementu niespójnego), zapis elementu katalogiem roboczym z zamianą, content store
oraz zacommitowane syntetyczne drzewo `tests/fixtures/library-linux/`. Kryteria 8, 9 i 10 są
spełnione lokalnie na macOS. **Żadne z nich nie ma jeszcze dowodu z czterech celów.** Kryterium 10
(element zapisany na Linuksie otwiera się na macOS i Windowsie) i `rename` katalogu na Windowsie
są do potwierdzenia przez macierz CI; ostateczny dowód to jej zielony przebieg po pushu. Test czytający fixture biegnie wtedy na
`ubuntu-latest`, `macos-15`, `macos-15-intel` i `windows-latest`; to samo dotyczy kryteriów 8
i 9 na trzech systemach. Zachowania Windowsa, FAT i SMB, których macOS nie sprawdza, wymienia
ADR 0031.

Do kawałka B przechodzi to, czego A świadomie nie robi:

- **Log operacji w `index.sqlite`** (ADR 0019). Wersje w `objects/` już powstają przy każdym
  zapisie, ale wpisów logu z kawałka A nie da się odtworzyć wstecz (log jest nieodtwarzalny
  z plików, ADR 0014), więc edycje i usunięcia sprzed B mają treść do odzyskania, a nie mają
  historii zdarzeń. Serwis ma już port `OperationLog`; w A istnieje tylko implementacja testowa.
  B musi zdążyć przed C, bo od interfejsu użytkownik może edytować i ta luka przestaje być
  teoretyczna.
- **Indeks slugów** zamiast odczytu wszystkich `item.json` przy każdym zapisie
  (`LibraryService.existingSlugs`). Dziś koszt jest liniowy względem liczby elementów.
  Ma wynikać z indeksu unikalności `lower(slug)` + typ (ADR 0017), z komunikatem walidatora, nie
  z naruszenia ograniczenia bazy (kryterium 8).
- **FTS i odbudowa indeksu z plików.** Odbudowa czyta bibliotekę przez `LibraryService.list()`,
  który zwraca osobno elementy poprawne, niespójne i problemy; raport odbudowy (kryterium 4) ma
  wymienić wszystkie trzy grupy, nie tylko liczbę wczytanych.

Dwa zadania odziedziczone po Etapie 1, oba konkretne: bezpośredni dowód FTS5 w zapakowanej
aplikacji (domyka ryzyko R2) oraz docelowy model awarii startu indeksu.

Kryteria akceptacji:
1. Tworzenie, edycja, wyszukiwanie i usuwanie elementu działa z końca na koniec, przez interfejs,
   z potwierdzeniem operacji destrukcyjnej.
2. Usunięcie `index.sqlite` i restart aplikacji odtwarza pełny indeks z plików, bez utraty
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

### Etap 3: Import z Claude Code i Codeksa

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

### Etap 4: Eksport i adaptery

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

### Etap 5: Synchronizacja i bezpieczeństwo (granica MVP)

Zakres: `SyncPlanner`, wybór celów, plan operacji, diff przed zapisem, identyfikacja konfliktów,
zatwierdzenie, `WriteGate` (ADR 0012), backup, obsługa błędów, weryfikacja po synchronizacji,
cofanie. Polityka usuwania (po odpowiedzi właściciela, ARCHITECTURE sekcja 15.2, punkt 4).

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

### Etap 8: Dopracowanie UI i UX

Zakres: przegląd wszystkich przepływów, usunięcie niedziałających kontrolek i placeholderów,
stany puste i błędy, responsywność na mniejszych ekranach, dostępność, spójność wizualna.

Kryteria akceptacji:
1. Każda widoczna kontrolka coś robi. Lista kontrolek bez działania jest pusta, a nie krótka.
2. Każdy widok ma stan pusty, ładowania, sukcesu, ostrzeżenia i błędu, i każdy da się wywołać
   w teście E2E.
3. Pełna obsługa klawiatury dla krytycznych przepływów: import, synchronizacja, diff, cofanie.
   Fokus widoczny, kolejność logiczna, pułapki fokusu w modalach.
4. Audyt dostępności przechodzi bez błędów krytycznych, kontrast spełnia WCAG AA w obu motywach.
5. Interfejs działa na szerokości okna od 1024 px bez poziomego przewijania i bez przycinania
   treści.

### Etap 9: Testy i bezpieczeństwo

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
| Konfiguracje projektowe, jeśli nie weszły do MVP | Zależy od odpowiedzi na pytanie 5 (ARCHITECTURE sekcja 15.2) |
| Import z repozytorium Git jako źródła skilli | Wymagania o tym wspominają w kontekście bezpieczeństwa; funkcja wymaga pełnej ścieżki traktowania treści jako niezaufanej, która w MVP już istnieje |
| Ikona aplikacji w finalnej formie | Zależy od odpowiedzi na pytanie 6 |

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

Plan zaakceptowany 2026-10-20, Etap 1 wystartował. Cztery z ośmiu pytań z `ARCHITECTURE.md`
sekcja 15 zostały rozstrzygnięte i mają własne ADR-y (0024 do 0027). W tym wszystkie trzy, które
blokowały Etap 2, bo zmieniały model danych: polityka scalania instrukcji globalnych, tożsamość
przy rozjechanej nazwie i retencja historii.

Cztery pozostają otwarte i żadne nie blokuje Etapu 1:

| Pytanie | Blokuje |
|---|---|
| 4. Polityka usuwania przy synchronizacji | Etap 5 |
| 5. Zakres projektowy w MVP | Etap 3 |
| 8. Tworzenie drzewa narzędzia od zera | Etap 4 |
| 6. Ikona i nazwa produktu | Etap 10 (wydanie), nie prace wcześniejsze |

Etapy 2 i 3 mogą ruszyć bez dalszych odpowiedzi, z zastrzeżeniem punktu 5: jeśli zakres projektowy
ma wejść do MVP, trzeba to wiedzieć przed projektowaniem tabeli lokalizacji w Etapie 3,
a nie po nim.
