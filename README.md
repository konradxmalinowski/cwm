# Universal AI Skills Manager

Aplikacja desktopowa do zarządzania konfiguracją narzędzi AI do programowania z jednego
miejsca: skillami, agentami, komendami, instrukcjami globalnymi i hookami. Obsługuje Claude Code
i OpenAI Codex. Działa lokalnie na macOS, Windowsie i Linuksie, bez backendu i bez kont.
Twoja biblioteka to zwykłe pliki w katalogu danych aplikacji.

Wydania są niepodpisane (ADR 0003), więc system ostrzeże cię przy pierwszym uruchomieniu.
Postęp prac i kryteria wydania: `docs/ROADMAP.md`.

## Dokumentacja dla użytkownika

- [`docs/INSTALACJA.md`](docs/INSTALACJA.md): pobranie, sprawdzenie sum kontrolnych, instalacja
  i obejście ostrzeżeń Gatekeepera i SmartScreena, uruchomienie na każdym systemie, gdzie leżą
  dane.
- [`docs/OGRANICZENIA.md`](docs/OGRANICZENIA.md): co ginie i co jest dopisywane przy konwersji
  między narzędziami, kiedy aplikacja odmawia edycji `config.toml`, blok między markerami.
- [`docs/ODZYSKIWANIE.md`](docs/ODZYSKIWANIE.md): jak ręcznie odtworzyć pliki z kopii zapasowych
  i bibliotekę, gdy aplikacja nie startuje.

Dla deweloperów: `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/adr/` i dalsza część tego pliku.

## Co aplikacja robi

- **Biblioteka.** Tworzenie, edycja, wyszukiwanie i usuwanie elementów. Wyszukiwanie korzysta
  z indeksu pełnotekstowego SQLite; gdy indeks jest niedostępny, lista filtruje po nazwie,
  tytule, opisie i treści. Usunięcie ma plan i wymaga potwierdzenia.
- **Import.** Z `~/.claude`, `~/.codex` i wspólnego `~/.agents`: skille, agenci, komendy,
  instrukcje globalne i hooki. Podgląd wykrywa duplikaty i różnice, a elementy z potencjalnym
  sekretem są domyślnie odznaczone. Źródło nie jest modyfikowane.
- **Eksport.** Do Claude Code i Codeksa, z planem zapisu, podglądem różnic bez sekretów,
  ostrzeżeniami o utracie zgodności i potwierdzeniem. Przed zapisem powstaje kopia w `backups/`,
  po zapisie plik jest czytany z powrotem.
- **Synchronizacja i historia.** Stan każdego elementu względem każdego narzędzia, plan zmian,
  zapis i cofnięcie zapisu z widoku Historia.
- **Diagnostyka.** Raport środowiska, stan indeksu i ręczna odbudowa indeksu.

Zastrzeżenia, które warto znać przed pierwszym użyciem (szczegóły w `docs/OGRANICZENIA.md`):

- Tylko konfiguracje globalne (ADR 0032). `CLAUDE.md`, `AGENTS.md` i `.mcp.json` leżące
  w repozytoriach projektów nie trafiają do biblioteki.
- Eksport działa tylko do narzędzia, którego katalog główny (`~/.claude`, `~/.codex`) istnieje
  (ADR 0033).
- Aplikacja nie usuwa plików w narzędziach (ADR 0034). Usunięcie elementu z biblioteki zostawia
  jego plik w narzędziu. Jedyne usunięcie to cofnięcie własnego zapisu z widoku Historia.
- Serwery MCP i ustawienia narzędzi nie są ani importowane, ani eksportowane (ADR 0020).
- Reguły (rules) nie są obsługiwane.
- Nie ma jeszcze: porównywania i scalania wersji poza podglądem w planie eksportu, profili,
  ustawień aplikacji, eksportu do ZIP, autoaktualizacji ani integracji z Gitem.

## Dla deweloperów: wymagania

- Node.js 24 (linia LTS; wersja w `.nvmrc`)
- Nic poza tym. `better-sqlite3` 13 dostarcza w paczce npm prebuildy N-API dla
  wszystkich szesciu par system-architektura, ktore nas interesuja, a N-API jest
  stabilne miedzy Node i Electronem, wiec przy instalacji nie kompiluje sie nic.
  Toolchain C++ (Xcode Command Line Tools, MSVC Build Tools, `build-essential`)
  jest potrzebny tylko wtedy, gdy dla jakiejs pary prebuildu zabraknie i trzeba
  siegnac po `npm run rebuild:native`.

## Dla deweloperów: uruchomienie ze źródeł

```
npm ci
npm run dev        # build i uruchomienie aplikacji
```

`npm run dev` nie stawia serwera deweloperskiego. Renderer jest serwowany
z tego samego schematu `app://` co w wydaniu, wiec CSP, blokada sieci, sandbox
i izolacja kontekstu obowiazuja takze w trakcie pracy - nie ma trybu, w ktorym
hartowanie z ADR 0008 jest wylaczone. Serwer na `http://localhost` wymagalby
rozluznienia CSP i otwarcia origin sieciowego, czyli dokladnie dwoch rzeczy,
ktore ta aplikacja blokuje.

Przeladowanie po zapisie dziala mimo braku serwera. Obserwator plikow siedzi
w `scripts/dev-reload.cjs` i jest wstrzykiwany do procesu glownego przez
`NODE_OPTIONS=--require`. Zmiana w rendererze przeladowuje okno, zmiana
w procesie glownym albo w preloadzie restartuje aplikacje. Zmierzone od zapisu
pliku do odswiezenia okna: **520 do 630 ms** (z czego 120 ms to celowe
wygaszanie serii zapisow, reszta to inkrementalny build Angulara).

Czego nie ma: HMR z zachowaniem stanu komponentu. Po zapisie strona
przeladowuje sie od zera. To swiadomy wybor - identyczny model bezpieczenstwa
w dev i w wydaniu jest tu wart wiecej niz zachowany stan komponentu.

Obserwatora nie ma w wydaniu i nie jest to kwestia przelacznika w kodzie.
`scripts/` nie wchodzi na liste `files` w `electron-builder.yml`, wiec w paczce
go nie ma (sprawdzone: archiwum `app.asar` zawiera tylko `dist`,
`node_modules` i `package.json`), a Electron odrzuca `NODE_OPTIONS`
w zapakowanej aplikacji, wiec sama droga wstrzykniecia tam nie istnieje.

## Polecenia

| Polecenie                 | Co robi                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `npm run build`           | proces glowny (tsc), preload (esbuild), renderer (Angular)            |
| `npm run dev`             | build plus uruchomienie Electrona                                     |
| `npm run lint`            | ESLint z regulami granic warstw plus Prettier                         |
| `npm run typecheck`       | `tsc --noEmit` dla main, preload i testow                             |
| `npm test`                | testy jednostkowe, kontraktowe i integracyjne (Vitest)                |
| `npm run test:boundaries` | dowod, ze reguly granic warstw faktycznie blokuja                     |
| `npm run test:e2e`        | testy E2E przeciw zbudowanej aplikacji (Playwright)                   |
| `npm run package`         | paczka probna bez instalatorow (`electron-builder --dir`)             |
| `npm run rebuild:native`  | ratunek, gdy dla jakiejs platformy brakuje prebuildu modulu natywnego |
| `npm run package:dist`    | instalatory dla biezacej platformy                                    |

`npm run test:e2e` wymaga wczesniejszego `npm run build`: testy uruchamiaja
zbudowana aplikacje z `dist/`, nie zrodla. Dwa testy idace przeciw faktycznie
zapakowanej aplikacji wymagaja dodatkowo `npm run package` i bez paczki sa
pominiete jawnie, a nie zaliczone po cichu.

## Granice warstw

Reguly z `docs/ROADMAP.md` sekcja 1 sa wymuszone lintem, nie dobra wola:

- `src/core/` nie importuje `electron`, `node:fs`, `better-sqlite3` ani Angulara,
- `src/adapters/` nie importuje `node:fs` ani `node:child_process`,
- `src/renderer/` nie importuje niczego z `main/`, `infra/` ani `adapters/`.

`npm run test:boundaries` wstawia celowo zakazany import, sprawdza, ze lint pada
na oczekiwanej regule, i usuwa plik. Jest tam tez proba kontrolna: czysty plik
w tym samym katalogu musi przejsc, zeby test nie zaliczal sie przez to, ze lint
pada zawsze.

Jedno ograniczenie wprost: regula sciezkowa nie rozroznia importu typow od
importu wartosci, wiec `renderer` ma zamknieta droge do `main/`, `infra/`
i `adapters/` w calosci, a do `core/` i `shared/` droge otwarta. Reguly z
ARCHITECTURE "renderer importuje z core tylko typy" lint w tej formie nie
wyraza.

## Testy i izolacja

Harness testowy (`tests/harness/isolation.ts`) jest przeniesiony z generatora
konfiguracji (ARCHITECTURE 12.2):

- odmawia startu, jesli katalog bazowy testow lezy w `~/.claude`, `~/.codex`
  albo `~/.agents`, albo jest katalogiem domowym,
- liczy odcisk kontrolny plikow konfiguracyjnych wlasciciela przed i po calym
  przebiegu i porownuje je na koncu,
- daje kazdemu testowi wlasne drzewo tymczasowe pod `tests/.tmp`
  (`UASM_TEST_TMPDIR` nadpisuje lokalizacje).

Testy E2E przekierowuja katalog danych aplikacji na drzewo tymczasowe
wbudowanym przelacznikiem Electrona `--user-data-dir`. W kodzie aplikacji nie ma
ani jednej linii istniejacej tylko dla testow: zmienna srodowiskowa
przekierowujaca zapis bylaby dokladnie takim wejsciem, ktore kiedys posluzy
do czegos innego.

Fixture'y sa wylacznie syntetyczne, konwencja `acme-*` (ADR 0004). Nic
z prawdziwej konfiguracji nie wchodzi do repozytorium.

## Czego wymagamy od dowodu

Trzy reguly, kazda zrodzona z konkretnej pomylki w tym projekcie, nie
z teorii.

**Kazdy bezpiecznik ma test na sciezce pozytywnej, nie tylko na negatywnej.**
To uzasadnienie reguly z ARCHITECTURE 12.5 i jednoczesnie przypadek, ktory ja
zrodzil. Harness testowy ma odmawiac startu, jesli katalog bazowy lezy
w konfiguracji wlasciciela. Przy przenoszeniu tej reguly zgubiony zostal
wartownik `isAbsolute`, przez co na Windowsie **kazda** sciezka na innym dysku
niz katalog domowy wygladala jak lezaca w `~/.claude`: `path.relative` miedzy
roznymi dyskami nie zwraca `..`, tylko gotowa sciezke absolutna do celu.
Testy sprawdzaly tylko, czy bezpiecznik blokuje to, co ma blokowac - i to
przechodzilo. Nikt nie sprawdzal, czy przepuszcza to, co ma przepuszczac.

Ten sam blad siedzial w kontroli prefiksu dla schematu `app://`, czyli w kodzie
produkcyjnym. Tam nie byl niedogodnoscia, a obejsciem kontroli zawierania
sciezki: plik z innego dysku przechodzilby jako lezacy w katalogu builda.
Dojechalby do wydania, gdybysmy budowali tylko na macOS, bo na macOS i Linuksie
ten przypadek nie istnieje. Teraz obie kontrole przyjmuja modul `path` jako
parametr, wiec semantyke Windowsa sprawdza sie przez podstawienie `path.win32`
na dowolnym systemie (`tests/unit/path-containment.test.ts`).

**Test, ktorego nikt nie widzial padajacego, nie jest testem.** Reguly granic
warstw maja `npm run test:boundaries`, ktory wstawia zakazany import i wymaga,
zeby lint padl - plus probe kontrolna, zeby nie zaliczal sie przez to, ze lint
pada zawsze. Test na wartownik `isAbsolute` zostal w ten sam sposob sprawdzony:
po cofnieciu poprawki pada, po przywroceniu przechodzi.

**Zielony wynik z narzedzia o nieznanej niezawodnosci nie jest dowodem,
dopoki nie wiemy, jak czesto to narzedzie zawodzi.** Testy przeciw zapakowanej
aplikacji przechodzily przez `electron.launch` Playwrighta, czyli przylaczenie
przez protokol debugowania. Ten mechanizm zawiesza sie losowo: lokalnie na
macOS pada drugi start tej samej paczki co drugi albo co trzeci przebieg, na
runnerze Windows pada kazdy. Przez kilka przebiegow czytalismy jego zielone
wyniki jako potwierdzenie, ze modul natywny dziala w paczce - a byly to
trafienia. Zmienilo to nie poziom ryzyka, ale **podstawe dowodowa**, na ktorej
je oceniamy, i dlatego dowod na ten punkt nie przechodzi juz przez to
narzedzie (patrz nizej).

**Dowod rozlozony na dwa przebiegi CI nie jest dowodem.** Nie wyklucza, ze
poprawka jednego celu zepsula drugi, a dokladnie to sie tu stalo: Windows byl
zielony w jednym przebiegu, Linux w nastepnym, i w tym nastepnym Windows zrobil
regresje. Wymagamy jednego przebiegu, w ktorym wszystkie cztery cele sa zielone
naraz. "Trzy z czterech, kazdy kiedy indziej" to stan nieznany, nie stan
potwierdzony.

**Commitujemy przez `git commit --only <sciezki>`, nie przez `git add` plus
`git commit`.** W tym repozytorium pracuje rownolegle kilka osob i narzedzi,
wiec w indeksie moga lezec cudze, zaindeksowane i jeszcze niezacommitowane
pliki. `git add <moje pliki>` niczego nie ogranicza - `git commit` bierze
**caly** indeks. Zdarzylo sie to dwa razy: raz przez `git add -A`, raz przez
commit po `git add` jednego pliku, gdy w indeksie czekala praca kogos innego.
Oba razy nic nie zginelo, ale historia zaczela klamac o tym, co sie stalo.
`--only` commituje wylacznie wskazane sciezki, niezaleznie od stanu indeksu.

**Praca idzie bezposrednio na `main`, bez galezi i pull requestow** (zgoda
wlasciciela). Skoro nie ma przegladu przed scaleniem, dowodem jest przebieg CI
po pushu. Etap uznajemy za zamkniety dopiero wtedy, gdy kazde kryterium
akceptacji ma test, a ostatni przebieg na `main` jest zielony na czterech celach
naraz (`docs/ROADMAP.md` sekcja 3).

### Jak dowodzimy, ze baza dziala w zapakowanej aplikacji

Teza do udowodnienia brzmi: `better-sqlite3` laduje sie z `app.asar.unpacked`
w zapakowanej aplikacji i wykonuje zapytania (ADR 0007, ryzyko R2 z roadmapy).
Teza nie brzmi: Playwright potrafi przylaczyc sie do zapakowanego Electrona.
Do pewnego momentu pierwsze zalezalo od drugiego, a drugie zawodzi losowo.

Dowod jest teraz niezalezny od tego narzedzia i siedzi
w `tests/e2e/packaged-db.spec.ts`. Zapakowana binarka jest uruchamiana tak, jak
uruchomilby ja uzytkownik, bez protokolu debugowania i bez zagladania jej do
srodka, a dowodem jest to, co zostawila na dysku: baza z rejestrem migracji.
Zeby ten rejestr powstal, w zapakowanej aplikacji musi sie zaladowac modul
natywny i wykonac `CREATE TABLE` oraz `INSERT`. Odczyt robi test wlasnym
`better-sqlite3`, z zewnatrz. To obserwacja czarnoskrzynkowa i jest mocniejsza
niz pytanie aplikacji przez IPC, bo patrzy na skutek, a nie na odpowiedz.

Schemat w wersji 1 to **sam rejestr migracji**. Nie ma w nim tabeli dodanej po
to, zeby test mial co sprawdzic - to ten sam wzorzec co furtka istniejaca
tylko dla testu, tylko schowany w schemacie bazy. FTS5, na ktorym opiera sie
ADR 0007, jest na razie dowodzony dwuczesciowo: binding dostarczony w paczce
jest bajt w bajt tym samym plikiem, ktory laduje proces testu, a w tym procesie
FTS5 dziala. Bezposredni dowod nadal czeka na pierwsza prawdziwa tabele
pelnotekstowa: biblioteka jej jeszcze nie ma (`docs/ROADMAP.md`, Etap 2).

Dwa testy, ktore wczesniej szly ta droga (`tests/e2e/packaged-app.spec.ts`),
**zostaly usuniete**. Nie oznaczone jako pomijane, bo pomijany test udaje, ze
cos sprawdza.

Powod: zawieszaly sie losowo, mniej wiecej co czwarty przebieg, a ich czerwien
nie mowila nic o aplikacji (szczegoly nizej). Test, ktory czerwieni macierz co
czwarty raz bez powodu, uczy ignorowac czerwony wynik - czyli robi dokladnie
to, przed czym broni sie ten rozdzial. Dopoki byly jedynym dowodem na modul
natywny w paczce, trzymalismy je mimo tego kosztu; od momentu, gdy dowod
przeszedl do `packaged-db.spec.ts`, przestaly byc tego warte.

Ich dawna wartosc jest pokryta, wiec nie ma tu luki:

| Co sprawdzaly                                           | Gdzie to jest teraz                    |
| ------------------------------------------------------- | -------------------------------------- |
| Modul natywny laduje sie z `app.asar.unpacked` w paczce | `tests/e2e/packaged-db.spec.ts`        |
| Renderer nie ma dostepu do Node                         | `tests/e2e/renderer-hardening.spec.ts` |
| IPC odpowiada i nie oddaje sciezek absolutnych          | `tests/e2e/sqlite.spec.ts`             |

**Warunek powrotu:** jesli przylaczanie Playwrighta do zapakowanego Electrona
stanie sie wiarygodne, te testy moga wrocic. Pokrycie czarnoskrzynkowe calej
paczki, razem z rendererem i IPC, ma wartosc samo w sobie - problemem byla
niezawodnosc narzedzia, nie sens tych asercji.

### Znane ograniczenie: przylaczanie Playwrighta do zapakowanej aplikacji

`electron.launch` Playwrighta zawiesza sie losowo, gdy celem jest zapakowana
binarka. Zawis jest cichy: proces startuje, nic nie wypisuje, okno nie
powstaje, a Playwright czeka do limitu. Nie udalo sie ustalic przyczyny.
Udalo sie ustalic, gdzie jej **nie ma**, i to jest zmierzone, nie wywnioskowane:

| Sprawdzone                                                   | Wynik                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE` w srodowisku testu    | nieobecne na macOS i na Windowsie                                                                 |
| Blokada pojedynczej instancji                                | dwie instancje z roznymi katalogami danych zyja rownolegle                                        |
| Procesy pozostale po przebiegu                               | zero                                                                                              |
| Koszt pierwszego startu niepodpisanej binarki                | limit 180 s i 300 s daja identyczny wynik, a powtorka przebiegu, ktory byl zielony, pada tak samo |
| Nazwa binarki wybierana przez resolver                       | dokladne dopasowanie, potwierdzone w logu CI                                                      |
| Inspektor Node w zapakowanej aplikacji, uruchamianej wprost  | odpowiada 5 razy na 5, srednio po 105 ms                                                          |
| `chromiumSandbox` i `ELECTRON_ENABLE_LOGGING` jako przyczyna | porazki wystepuja przy kazdym ustawieniu tych opcji                                               |

Pomiar rozstrzygajacy: szesc kolejnych uruchomien tej samej paczki w jednym
procesie, w trzech wariantach opcji startu, dalo 0, 1 i 2 porazki na szesc.
Ta sama binarka uruchamiana wprost, z `--inspect=0`, zglasza inspektor
bezblednie. Przyczyna jest wiec w sekwencji przylaczania Playwrighta, nie
w aplikacji i nie w opcjach, ktore mu podajemy.

Dlatego dowod na ryzyko R2 nie przechodzi przez to narzedzie, a przez odczyt
stanu bazy z dysku (sekcja wyzej), a dwa testy, ktore przez nie szly, zostaly
usuniete razem z uzasadnieniem i warunkiem powrotu.

## Zaleznosci i powody

Kryterium akceptacji Etapu 1 punkt 5: kazda pozycja w `package.json` ma powod.

### Runtime (ida do paczki)

| Pakiet           | Powod                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3` | indeks metadanych, FTS5, synchroniczne API pasujace do procesu glownego (ADR 0007)                                                                              |
| `smol-toml`      | niezalezny parser TOML do weryfikacji semantycznej edycji `config.toml` w `SegmentTomlEditor` (ADR 0011); zapisu nie robi, wiec komentarze uzytkownika nie gina |

### Fonty (pliki w `src/renderer/assets/fonts/`, ida do paczki)

| Krój                                        | Zrodlo i wersja                                                                                       | Licencja                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Space Grotesk (500, 700; latin i latin-ext) | `@fontsource/space-grotesk` 5.3.0, pliki bez zmian; kopiowane, nie jest to zaleznosc w `package.json` | SIL OFL 1.1, `LICENSE-space-grotesk` |
| Source Sans 3 (400, 500, 700)               | Fontsource, pliki bez zmian                                                                           | SIL OFL 1.1, `LICENSE-source-sans-3` |
| Commit Mono (400, latin)                    | Fontsource, pliki bez zmian                                                                           | SIL OFL 1.1, `LICENSE-commit-mono`   |

Teksty licencji leza obok plikow i trafia do paczki razem z nimi (`angular.json`, glob `assets`).
Space Grotesk zastapil poprzedni kroj naglowkowy 2026-11-11 z powodu licencji (`docs/DESIGN.md`, wpis l).

### Budowanie i testy (nie ida do paczki)

| Pakiet                                                          | Powod                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `electron`                                                      | runtime aplikacji (ADR 0001)                                                                                                                                             |
| `electron-builder`                                              | cztery cele wydania, asar, instalatory (ADR 0002, ADR 0010)                                                                                                              |
| `@angular/core`, `@angular/common`, `@angular/platform-browser` | framework renderera (ADR 0001); kod wchodzi do bundla, wiec zaleznosc jest wylacznie budowania                                                                           |
| `@angular/compiler`, `@angular/compiler-cli`                    | kompilacja szablonow i `strictTemplates`                                                                                                                                 |
| `@angular/build`, `@angular/cli`                                | builder renderera                                                                                                                                                        |
| `rxjs`, `tslib`                                                 | wymagane peer dependencies Angulara                                                                                                                                      |
| `typescript`                                                    | caly kod, `strict` wlaczone                                                                                                                                              |
| `@types/node`, `@types/better-sqlite3`                          | typy dla procesu glownego; `better-sqlite3` nie dostarcza wlasnych                                                                                                       |
| `esbuild`                                                       | bundlowanie preloada do jednego pliku; sandboxowany preload nie moze robic `require` na plikach wzglednych, wiec wyjscie wieloplikowe z `tsc` padloby w czasie dzialania |
| `eslint`, `@eslint/js`, `typescript-eslint`                     | lint z informacja o typach                                                                                                                                               |
| `eslint-plugin-import-x`                                        | `no-restricted-paths`, czyli kierunek zaleznosci miedzy katalogami                                                                                                       |
| `globals`                                                       | zestawy globali dla flat configa ESLinta                                                                                                                                 |
| `prettier`                                                      | formatowanie, jedno zrodlo prawdy o stylu                                                                                                                                |
| `vitest`                                                        | testy jednostkowe, kontraktowe i integracyjne (ARCHITECTURE 12.1)                                                                                                        |
| `@playwright/test`                                              | E2E przeciw Electronowi (ADR 0009)                                                                                                                                       |
| `fast-check`                                                    | testy property-based round-trip eksportu i importu dla obu narzedzi (ARCHITECTURE 12.1, ROADMAP Etap 9 kryterium 7); generatory zamiast recznie dobranych przykladow     |
| `axe-core`                                                      | audyt dostepnosci w E2E (ROADMAP Etap 8 kryterium 4): reguly WCAG A i AA na kazdym widoku i dialogu w obu motywach                                                       |

Pole `overrides` przypina `vitest` w drzewie `@angular/build`. Angular
deklaruje `vitest` jako opcjonalny peer w zakresie `^3.1.1`, a jego builder
testowy nie jest tu uzywany; wersja 3 ma otwarte zgloszenia bezpieczenstwa,
ktorych poprawka jest dopiero w 5.

Znane ostrzezenia `npm audit`: osiem pozycji o wadze moderate w drzewie
`electron-builder` (`sprintf-js` przez `roarr` i `global-agent`). Nie ma dla
nich poprawki poza cofnieciem `electron-builder` do starszej wersji, nie
dotycza kodu wchodzacego do aplikacji i nie sa w sciezce wykonania u uzytkownika.
Bramka w CI blokuje na poziomie `high` dla zaleznosci produkcyjnych.

## Wydania są niepodpisane

Świadoma decyzja na czas MVP (ADR 0003): bez certyfikatu Apple i Authenticode system ostrzega
przy pierwszym uruchomieniu, a autoaktualizacja jest wyłączona. Każde wydanie ma plik
`SHA256SUMS`, który jest jedyną weryfikacją pobranego pliku. Kroki obejścia ostrzeżeń
dla macOS, Windowsa i Linuksa oraz weryfikacja sum: [`docs/INSTALACJA.md`](docs/INSTALACJA.md).
