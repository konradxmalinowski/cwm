# ADR 0035: Zmiana nazwy produktu na CWM - Claude Workspace Manager

Status: zaakceptowane (decyzja właściciela produktu, 2026-11-11)
Data: 2026-11-11
Dotyka: ADR 0014 (układ `userData`), ADR 0019 i 0027 (format kopii zapasowych), ADR 0025 (marker bloku instrukcji)
Źródło: `plans/2026-11-11-zmiana-nazwy-na-cwm.md`

## Kontekst

Wersja v0.1.0 została opublikowana 2026-11-11 pod nazwą Universal AI Skills Manager. Produkt
ma stać się warstwą menedżera przestrzeni roboczych (workspace) dla Claude, a nie ogólnym
narzędziem do zarządzania konfiguracją wielu narzędzi AI. Stara nazwa mówi o czymś innym, niż
produkt ma robić dalej, i jest za długa do nazw plików, zmiennych środowiskowych i katalogu
danych.

Nazwa jest dziś zapisana w czterech miejscach, które użytkownik v0.1.0 ma na dysku albo w
systemie: w katalogu danych, w markerach bloku w `CLAUDE.md` i `AGENTS.md`, w polu `format`
pliku `MANIFEST` każdej kopii zapasowej oraz w identyfikatorze aplikacji instalatora. Zmiana
nazwy bez ochrony tych miejsc kończy się utratą biblioteki albo podwójnymi blokami w plikach
użytkownika, czyli dokładnie tym, przed czym produkt ma chronić (ADR 0012, 0025).

## Rozważane opcje

**Zmiana nazwy w v0.1.1.** Najszybciej, ale wersja poprawkowa zmieniałaby nazwę produktu,
identyfikator instalatora i miejsce danych. Numer wersji obiecuje drobną poprawkę, a nie
zmianę, po której na Windowsie trzeba odinstalować starą aplikację.

**Wycofanie v0.1.0 i publikacja od nowa.** Daje czystą historię wydań. Koszt: ktoś mógł już
pobrać v0.1.0, wycofanie nie usuwa jego danych ani plików, a link do wydania przestaje
działać bez żadnej korzyści dla użytkownika. Wydanie nie zawiera błędu, który to uzasadnia.

**Zmiana nazwy w v0.2.0, v0.1.0 zostaje.** Wersja drobna sygnalizuje zmianę widoczną dla
użytkownika. v0.1.0 zostaje opublikowane pod starą nazwą, a jego historia pozostaje prawdziwa.

## Decyzja

Wybieramy trzecią opcję. Pierwsze wydanie pod nową nazwą to v0.2.0. Sześć decyzji
szczegółowych:

1. **Nazwa.** Nazwa produktu widoczna w aplikacji (tytuł okna), instalatorach i README to
   `CWM - Claude Workspace Manager`. Nazwa techniczna to `cwm`: pakiet npm, nazwy plików
   wydania (`cwm-<wersja>-...`), plik wykonywalny, zmienne środowiskowe `CWM_*`, most w
   rendererze `window.cwm` i prefiks logów `[cwm]`. Ikona aplikacji bez zmian. Na Linuksie pakiet deb i polecenie nazywają się
   `claude-workspace-manager`, bo Debian ma już pakiet `cwm` (calmwm); pliki wydania zostają
   `cwm-<wersja>-...`. Na macOS i Windowsie nazwy bez zmian.
2. **Katalog danych.** `userData` to `<appData>/CWM`, ustawiony jawnie przez
   `app.setPath('userData', ...)` przed zdarzeniem `ready`, żeby nie zależał od długiej nazwy
   produktu ani od tego, jak Electron ją wyprowadza.
3. **Migracja przy pierwszym starcie.** Dotyczy tylko katalogu, który aplikacja sama wybiera;
   jawne `--user-data-dir` wyłącza migrację. Źródłem jest katalog v0.1.0 z niepustym
   `library/`, szukany w kolejności `Universal AI Skills Manager` (zainstalowana v0.1.0), potem
   `universal-ai-skills-manager` (uruchomiona ze źródeł). Sam `index.db` nie kwalifikuje, bo
   indeks odbudowuje się z plików (ADR 0029). Gdy kwalifikują się oba, wygrywa ten, którego
   drzewo `library/` ma nowszy czas modyfikacji. Cel jest wolny, gdy nie ma w nim żadnego z
   wpisów `index.db`, `library`, `objects`, `backups`, `materialized`, `root-salt`,
   `.cwm-migration`; cache Chromium i `.DS_Store` nie blokują. Zawartość jest kopiowana poza
   plikami blokad Chromium (`SingletonLock`, `SingletonSocket`, `SingletonCookie`,
   `lockfile`), do katalogu tymczasowego, i zamieniana jednym `rename`, więc nieudana
   migracja nie zostawia pół-katalogu. Stary katalog zostaje nietknięty. Wyłączność daje
   blokada na czas kopii. W katalogu danych powstaje plik `.cwm-migration` (nazwa katalogu
   źródłowego, czas, wynik), a na macOS i Linuksie nowy katalog ma tryb `700`.

   Wyniki: `migrated`; `none` (nic do zrobienia); `busy` (inna instancja właśnie migruje, ta
   kończy pracę bez komunikatu); `deferred` (działa starsza wersja, trzeba ją zamknąć i
   uruchomić CWM ponownie); `failed` (tylko kod błędu systemu plików, bez ścieżek);
   `skipped` (użytkownik wybrał start z pustą biblioteką). Przy `deferred` i `failed` natywne
   okno dialogowe pojawia się, zanim cokolwiek powstanie w nowym katalogu, i daje wybór:
   „Zamknij” (nic nie zapisano, następny start ponawia próbę) albo „Zacznij z pustą
   biblioteką” (zapis `.cwm-migration` z wynikiem `skipped`, migracja nie jest ponawiana, stary
   katalog zostaje i można go odzyskać ręcznie według `docs/ODZYSKIWANIE.md`). Wynik trafia do
   logu, a opcjonalne pole `dataMigration` (wynik, nazwa katalogu źródłowego, komunikat bez
   ścieżek) do danych diagnostyki, dostępnych w raporcie diagnostyki.
4. **Formaty na dysku: nowe nazwy przy zapisie, odczyt rozpoznaje stare.**
   - Marker bloku instrukcji: zapis `<!-- cwm:start -->` i `<!-- cwm:end -->`, odczyt
     rozpoznaje też `ai-skills-manager:start` i `ai-skills-manager:end`. Istniejący stary blok
     jest przy synchronizacji przepisywany na nowy marker jako wpis planu typu `modify` z
     ostrzeżeniem (rodzaj `migrated`), do zatwierdzenia jak każdy inny zapis (`WriteGate`,
     kopia). Plik z dwoma blokami, starym i nowym, to konflikt bez opcji rozwiązania, dopóki
     użytkownik sam nie naprawi pliku; nie ma cichej naprawy.
   - Kopie zapasowe: zapis `format: 'cwm-backup'`, odczyt przyjmuje też `uasm-backup` w wersji 1.
   - Klucz motywu w `localStorage`: zapis `cwm.theme`; gdy go brak, odczyt `uasm.theme` i
     jednorazowe przeniesienie.
5. **Identyfikator aplikacji.** `appId` to `io.github.konradxmalinowski.cwm`. Skutek: na
   Windowsie v0.2.0 instaluje się obok v0.1.0 zamiast ją aktualizować. README i
   `docs/INSTALACJA.md` mówią, żeby najpierw odinstalować starą wersję. Dane zostają i migrują.
6. **Repozytorium.** `konradxmalinowski/universal-ai-skills-manager` zmienia nazwę na
   `konradxmalinowski/cwm`. GitHub przekierowuje stare adresy. Zmiana nazwy repozytorium i
   aktualizacja `origin` następują dopiero po zgodzie właściciela na push, nie wcześniej.

Istniejące ADR-y nie są przepisywane, bo są zapisem historii. Tam, gdzie nazwa produktu albo
format jest częścią decyzji (0019, 0025, 0027), dostają jednowierszową adnotację o zmianie.
Stara nazwa zostaje w kodzie i dokumentach tylko tam, gdzie jest celowa: odczyt starych
formatów, migracja, historia w ADR i w `docs/ROADMAP.md`.

## Konsekwencje

**Windows ma dwie aplikacje obok siebie.** Zmiana `appId` sprawia, że instalator NSIS nie
rozpoznaje v0.1.0 jako poprzedniej wersji. Użytkownik, który nie odinstaluje starej,
zobaczy w systemie dwie aplikacje. Dane nie są przy tym zagrożone, bo obie czytają niezależne
katalogi, ale oba skróty wyglądają podobnie. Płacimy za to jednym zdaniem w dokumentacji.
Na macOS i Linuksie nazwa pakietu i aplikacji jest inna, więc stara wersja też nie jest
zastępowana automatycznie.

**Katalog danych jest kopiowany, nie przenoszony.** Po migracji dysk zajmuje dwa razy tyle,
co biblioteka. Zyskujemy powrót: v0.1.0 nadal działa na swoim katalogu, a wycofanie v0.2.0
nie wymaga odtwarzania danych. Zmiany robione w v0.2.0 nie wracają do v0.1.0. Dowiązania
utworzone przez v0.1.0 w katalogach narzędzi wskazują na `materialized/` w starym katalogu i
wskazują tam, dopóki następna synchronizacja w v0.2.0 nie zmaterializuje ich na nowo w
`<appData>/CWM`. `WriteGate` rozpoznaje je jako własne dowiązania aplikacji (korzeń
`materialized/` nowego i starych katalogów), więc eksport i cofnięcie działają na nich od razu.
Usunięcie starego katalogu przed tą synchronizacją zostawia je puste.

**Migracja przy działającej v0.1.0 i czas kopii.** Działającą v0.1.0 CWM wykrywa i odkłada
migrację (`deferred`), żeby nie skopiować `index.db` w trakcie zapisu. Na macOS i Linuksie
wykrycie opiera się na `SingletonLock`, na Windowsie jest best effort (próba otwarcia
`lockfile`, błąd `EBUSY`) i nie zostało sprawdzone na Windowsie. Kopia jest synchroniczna i
kończy się przed pojawieniem się okna, więc przy dużej historii start trwa dłużej bez okna;
drugi start w tym czasie kończy się od razu.

**Zgodność formatów jest jednostronna.** v0.2.0 czyta wszystko, co zapisała v0.1.0. v0.1.0
nie rozpozna bloku z markerem `cwm:*` ani kopii z `cwm-backup`. Użytkownik, który wróci do
v0.1.0 po synchronizacji w v0.2.0, dostanie w plikach instrukcji blok, którego stara wersja
nie uzna za swój, i dopisze drugi. To zamierzony koszt zasady "nowe nazwy przy zapisie"
(ADR 0025: zmiana markera bez rozpoznawania starego oznaczałaby duplikat). Rozpoznawanie
starych nazw przy odczycie nie ma terminu wygaśnięcia w tej decyzji; usunięcie go wymaga
osobnego ADR.

**Zmiana nazwy repozytorium.** Stare adresy (strona repozytorium, wydanie v0.1.0, `git clone`)
przekierowują do `konradxmalinowski/cwm`. Przekierowanie przestaje działać, jeśli ktoś
założy nowe repozytorium pod starą nazwą. Linki w dokumentach historycznych (`docs/ROADMAP.md`)
zostają ze starą nazwą i działają przez przekierowanie.

**Ryzyka po wydaniu**, które trzeba obserwować: zgłoszenia o "zniknięciu biblioteki" po
aktualizacji (nieudana migracja), podwójne bloki w `CLAUDE.md` i `AGENTS.md`, kopie, których
historia nie widzi. Wycofanie: v0.1.0 działa na starym katalogu, który migracja zostawia
nietknięty, oraz revert scalenia tej zmiany.

Dowód zgodności formatów i migracji ma dać istniejący zestaw testów dostosowany do nowych
nazw, z przypadkami dla starych markerów, starych kopii i migracji katalogu. Ta decyzja nie
dodaje osobnego zestawu testów (decyzja właściciela, 2026-11-11). Stan wykonania tych
przypadków jest w raporcie z weryfikacji, nie w tym ADR.
