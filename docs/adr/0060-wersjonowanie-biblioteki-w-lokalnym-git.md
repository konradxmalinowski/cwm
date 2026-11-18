# ADR 0060: wersjonowanie biblioteki w lokalnym repozytorium Git jako warstwa opcjonalna

Status: zaakceptowane
Data: 2026-11-18
Dotyczy: ADR 0012 (blokada zapisu), ADR 0019 (Git jako warstwa opcjonalna), ADR 0030 (blokada operacji), ADR 0048 (pluginy z git), ADR 0056 (retencja), ADR 0058 (import z repozytorium Git), ADR 0059 (projekty)

## Kontekst

ADR 0019 zostawił Git w backlogu jako dodatkową warstwę: opcjonalne zapisywanie katalogu `library/` w repozytorium,
nigdy jako wymaganie do podstawowych operacji. Historia, porównywanie wersji i cofanie stoją dziś na content store i
logu operacji (ADR 0019, 0056), więc Git nie dostaje żadnej roli w mechanizmie, od którego aplikacja zależy. Użytkownik,
który chce mieć bibliotekę w `git log`, `git diff` albo w narzędziu, które już zna, nie ma jak jej tam włożyć bez
ręcznego kopiowania.

Dwa ryzyka decydują o kształcie. Pierwsze: repozytorium to kanał, z którego treść trudno cofnąć. Biblioteka trzyma elementy
prywatne, a import oznacza elementy z możliwym sekretem (`classification.secretFindings`); commit takiego elementu zostaje
w historii, nawet gdy element zniknie z biblioteki. Drugie: proces `git` to zewnętrzny program uruchamiany z uprawnieniami
użytkownika w katalogu, w którym leży cudza treść, więc potrzebuje tego samego hartowania co pobieranie z ADR 0048 i 0058.

## Rozważane opcje

**Repozytorium w `library/` (`library/.git`).** Odrzucone. Katalog `library/` jest własnością magazynu elementów (ADR 0014),
który listuje `items/` i odmawia obcych wpisów; `.git` obok `items/` byłby takim wpisem. Zwykły `git` w tym katalogu
(odpalony ręcznie albo przez edytor) czytałby też konfigurację z `library/.git/config` i hooki z `library/.git/hooks`,
czyli z miejsca, które aplikacja zapisuje. Katalog z historią kopiowany razem z biblioteką (np. przy ręcznym odzyskiwaniu
z `docs/ODZYSKIWANIE.md`) zabierałby całą historię prywatnych elementów.

**Osobny magazyn obiektów w `<userData>/library-git` z drzewem roboczym `library/`.** Wybrane. `GIT_DIR` wskazuje magazyn
poza biblioteką, `GIT_WORK_TREE` to `library/`. Biblioteka zostaje bez zmian, a użytkownik, który chce czytać historię,
robi to poleceniem `git --git-dir=<userData>/library-git --work-tree=<userData>/library log`.

**Commit wewnątrz `LibraryService`.** Odrzucone. Import tworzy elementy jednym wywołaniem `create` na element, więc commit
na zapis dałby jeden commit na element zamiast jednego na operację. `core/` zostaje też bez wiedzy o procesach i dysku.

**Commit pod blokadą trzymaną przez handler.** Odrzucone. Odpowiedź na zapis czekałaby na `git`, a jego limit czasu to
sekundy, nie milisekundy.

**Push do zdalnego repozytorium.** Poza zakresem tej zmiany (punkt 9).

## Decyzja

1. **Warstwa jest opcjonalna na trzech poziomach.** Wyłączona domyślnie (`<userData>/library-git.json`, brak pliku to
   wyłączone). Bez `git` w PATH funkcja pokazuje stały komunikat i nic więcej: `probe()` sprawdza plik `git` po
   ścieżce bezwzględnej tak samo jak pobieranie. Awaria `git` w trakcie nigdy nie zmienia wyniku operacji na bibliotece
   (punkt 4). Na Windowsie funkcja jest niedostępna z komunikatem, bo `resolveGit` zakłada ścieżki POSIX w PATH
   (to samo ograniczenie ma ADR 0058).
2. **Jedno hartowanie procesu.** Kod uruchamiania `git` z `git-fetch.ts` (`resolveGit`, `runGit`, limity czasu i
   wyjścia, zabijanie grupy procesów, `abortRunningGit`) przeniesiono bez zmiany zachowania do `infra/cwm/git-process.ts`.
   `git-fetch.ts` importuje go stamtąd i nadal re-eksportuje `abortRunningGit`. Lokalne repozytorium używa tego samego
   środowiska od zera (`buildGitEnv`: bez konfiguracji globalnej i systemowej, `GIT_TERMINAL_PROMPT=0`, `HOME` i `TMPDIR`
   w pustym katalogu 0700) i tych samych opcji `-c` (`gitHardeningArgs`: `core.hooksPath=/dev/null`, bez helperów
   haseł, bez filtrów LFS, `gc.auto=0`). `RunContext` dostał trzy pola: `commandMs` (15 s zamiast 120 s), `extraConfig` i `extraEnv`.
   Dla tej warstwy `extraConfig` dodaje `protocol.https.allow=never` (żadne polecenie nie dotyka sieci), autora,
   wyłączenie podpisów, `core.excludesFile=/dev/null` oraz zamknięcie programów z konfiguracji: `gpg.program`,
   `core.sshCommand`, `diff.external`, `core.gitProxy`, `core.worktree`, `core.pager=cat`, `log.showSignature=false`.
   `extraEnv` ustawia `GIT_LITERAL_PATHSPECS=1`, więc ścieżki z listy nie są wzorcami. **Konfiguracja magazynu nie jest
   zaufana:** przed każdym poleceniem (także przy odczycie stanu) `<git-dir>/config` jest przepisywany ze stałego
   szablonu, a `include.path`, którego nie da się wyczyścić z wiersza poleceń, zamyka właśnie ten szablon. Przy
   plikach przekierowujących (`commondir`, `gitdir`, `objects/info/alternates`) warstwa odmawia uruchomienia `git`. Lista plików z prawem `child_process` w `eslint.config.mjs` i
   w `scripts/verify-boundaries.mjs` zyskała `git-process.ts`; dwie nowe próby dowodzą, że `infra/library/` nie importuje
   ani `git-fetch.ts`, ani `child_process`. Importerzy `git-fetch.ts` pozostają ci sami (ADR 0058).
3. **Wejście do historii tylko przez listę ścieżek i własne atrybuty.** Pliki dodaje się poleceniem `git add -A -f
   --pathspec-from-file` z listą `items/<id>` elementów dopuszczonych, nie `git add -A`. Dzięki temu plik `.gitignore`
   w pliku pomocniczym elementu nie ukryje jego treści, a element wykluczony nie wejdzie przez przypadek. `info/attributes`
   ma `* -text -filter -ident -diff -merge !working-tree-encoding` i ma pierwszeństwo przed plikami w drzewie, więc plik
   pomocniczy o nazwie `.gitattributes` nie zmieni końców linii ani nie uruchomi filtra: bajty w historii to bajty z dysku.
   Dowiązania nie są śledzone (magazyn elementów ich nie tworzy), a `info/exclude` powtarza wykluczenia dla poleceń
   uruchamianych ręcznie na tym repozytorium.
4. **Commit po operacji, poza odpowiedzią, bez wpływu na wynik.** `IpcRegistry` dostał opcję `afterWrite(channel, result)`,
   wołaną po zwolnieniu blokady zapisu kanału z `WRITE_CHANNELS`; wyjątek jest połykany. Runner (`LibraryGitRunner`) mapuje
   kanały zapisujące bibliotekę na typ operacji: `library:save` (`save`), `library:delete-apply` (`delete`),
   `library:repair` (`repair`), `import:apply` (`import`), `projects:remove` (`detach`). `history:rollback`, `export:apply`
   i `sync:apply` zapisują konfiguracje narzędzi, nie bibliotekę, więc ich tu nie ma. Synchronizacja idzie w osobnej
   kolejce, pod wspólną blokadą zapisu (`tryEnterWrite`), więc odbudowa indeksu i czyszczenie historii nie wejdą w trakcie
   commita. Jest to **synchronizacja stanu, nie zapis różnicy**: każdy przebieg doprowadza repozytorium do aktualnego stanu
   biblioteki i tworzy jeden commit, jeśli coś się zmieniło. Przebieg pominięty (zajęta blokada) albo nieudany nadrabia się
   przy następnej operacji i jednorazowo przy starcie aplikacji. Awaria daje ostrzeżenie w Diagnostyce (stały tekst bez
   ścieżek i wyjścia procesu) i wpis w logu; wynik `library:save` itd. jest już odesłany, a zapis na dysku się nie cofa.
   Blokada zapisu trwa tylko przez skan i staging; sam commit idzie poza nią (limit całej synchronizacji to 20 s, a
   zajęta blokada kończy przebieg bez ostrzeżenia, bo następny go nadrobi). Zamknięcie aplikacji w trakcie polecenia
   może zostawić zamki (`index.lock`, `HEAD.lock`, `refs/**/*.lock`, `packed-refs.lock`, `shallow.lock`). Kolejka tego
   procesu jest jedynym pisarzem, a odczyty stanu nie biorą zamków, więc na początku każdej synchronizacji, gdy żadne
   polecenie `git` nie działa, wszystkie pliki `*.lock` w magazynie są usuwane. Zamek ręcznie uruchomionego `git`
   na tym repozytorium też zostanie usunięty; to świadomy koszt. Listy plików z `ls-files` i `diff --name-only`
   mają limit wyjścia 64 MiB, żeby duża biblioteka nie kończyła się błędem na stałe. `before-quit` woła
   `abortRunningGit()` bezpośrednio, niezależnie od importu.
5. **Tożsamość i treść commita.** Autor i komitujący to `cwm <cwm@localhost>`, ustawiani opcją `-c` przy każdym poleceniu
   (nie z konfiguracji użytkownika, której środowisko nie czyta). Bez podpisu (`commit.gpgsign=false`), `--no-verify`.
   Temat to typ operacji i liczba elementów (`import: 3 items`, `delete: 1 item`); liczba pochodzi z listy zmienionych
   katalogów `items/<id>` w indeksie. Temat jest po angielsku i bez nazw, slugów i ścieżek: to tekst maszynowy w
   repozytorium, nie interfejs. Pierwszy przebieg po włączeniu ma operację `enable`, przebieg po zmianie zgody `resync`.
6. **Elementy prywatne i z sekretami: decyzja.** Do historii trafiają domyślnie wyłącznie elementy o zakresie `public`.
   - Element z niepustym `classification.secretFindings` nie wchodzi **nigdy**, także po zgodzie. Zgoda nie ma tu zastosowania,
     bo wykrycie sekretu jest heurystyką, a historia Git jest nieodwracalna.
   - `secretFindings` z `item.json` bywa nieaktualne (edycja po imporcie, plik zmieniony na dysku), więc w chwili commita
     cała treść elementu jest skanowana od nowa (`classifyStrict`, jak w archiwum ZIP): `item.json` z tytułem i opisem,
     `body.md`, pliki pomocnicze i snapshoty źródła. Trafienie wyklucza element (`excluded-secrets`). Zapis z edytora
     (`library:save`) też liczy wykrycia od nowa i zastępuje nimi stare, więc biblioteka mówi prawdę, a usunięcie sekretu
     zdejmuje oznaczenie. Skan jest heurystyką: nie zmienia faktu, że historia jest nieodwracalna.
   - Plik albo katalog `.git` (bez względu na wielkość liter) gdziekolwiek w elemencie wyklucza go (`excluded-git-entry`),
     tak samo jak dowiązanie, plik specjalny i przekroczenie limitów. Powód widać w Diagnostyce osobnym licznikiem.
   - Elementy `private` i `project` wchodzą dopiero po jawnej zgodzie `includePrivate` (pole w ustawieniach, domyślnie
     `false`). Włączenie zgody w interfejsie wymaga osobnego potwierdzenia: pole "Rozumiem, że treść elementów prywatnych
     trafi do historii Git i zostanie w niej, dopóki nie usunę repozytorium". Brak potwierdzenia daje błąd przy polu i fokus
     na nim. Main wymusza to samo: zgoda (włączone wersjonowanie z `includePrivate`, gdy jeszcze nie obowiązuje) wymaga
     `acknowledged: true` i jednorazowego znacznika z odczytu stanu (`versioning:get`, ważny 5 minut, zużywany przy
     każdej próbie). Bez nich zapis kończy się `consent-required` albo `consent-expired`, więc skompromitowany renderer
     nie włączy prywatnych elementów jednym wywołaniem.
   - `item.json`, którego nie da się odczytać albo którego klasyfikacja ma nieznany kształt, jest wykluczony (`excluded-unreadable`):
     reguła zawodzi na zamknięciu. `libraryGitEligibility` w `core/model/library-git.ts` ma tę regułę w jednym miejscu.
   - Wykluczenie działa przy każdym przebiegu: element, który stał się prywatny albo dostał wykrycie sekretu, jest zdejmowany
     z indeksu poleceniem `git rm --cached`. **Historia nie jest przepisywana:** wersja z czasu, gdy element był publiczny i
     czysty, zostaje w poprzednich commitach. To samo dotyczy wycofania zgody `includePrivate`. Interfejs mówi to wprost
     przy opcji, a usunięcie historii to usunięcie katalogu `<userData>/library-git`.
   - Ten wybór oznacza, że przy typowej bibliotece (elementy domyślnie `private`) po włączeniu funkcji repozytorium jest prawie
     puste, a Diagnostyka pokazuje liczby elementów w historii i wykluczonych według powodu. To skutek zamierzony: pusta
     historia jest lepsza od historii z treścią, której użytkownik nie zatwierdził.
7. **Interfejs.** Nowa sekcja "Wersjonowanie biblioteki w Git" w Diagnostyce (`app-versioning-section`), ten sam wzorzec co
   sekcja retencji: nagłówek `h2` z `aria-labelledby`, `role="status"` dla zapisu, `role="alert"` dla błędu, `role="note"` dla
   ostrzeżenia i komunikatu o braku Git, `field__hint` i `aria-describedby` przy polach. Dwa pola wyboru, przycisk zapisu zawsze
   aktywny (poza trwającym zapisem; spis kontrolek E2E zabrania kontrolek zawsze zablokowanych) i lista stanu: włączone,
   repozytorium, liczba commitów, ostatni commit, elementy w historii i wykluczone. Przy braku Git pola zostają aktywne, a
   próba włączenia kończy się komunikatem z main. "Otwórz w Finderze" nie ma. Wyłączenie zapisuje ustawienie i nie dotyka
   repozytorium.
8. **IPC.** Dwa nowe kanały: `versioning:get` (stan i znacznik zgody) i `versioning:set` (`{ enabled, includePrivate,
   acknowledged?, nonce? }`; pola ustawień walidowane w main tym samym kodem co odczyt pliku, oba typu logicznego).
   Przy wyłączonym wersjonowaniu odczyt stanu nie skanuje elementów (liczniki zerowe). Żaden nie przyjmuje ścieżki, adresu ani tekstu
   commita, a stan nie zawiera ścieżek. Kanały nie są w `WRITE_CHANNELS`: nie zapisują do content store ani do logu operacji
   (bezpieczeństwo retencji z ADR 0056 zostaje), a blokadę zapisu biorą same. Włączenie robi pierwszą synchronizację przed
   zapisem ustawień: gdy `git` zawiedzie, ustawienia zostają bez zmian, a użytkownik dostaje powód.
9. **Push zdalny: nie na tym etapie.** Repozytorium nie ma żadnego zdalnego adresu, a `protocol.https.allow=never` blokuje
   sieć w każdym poleceniu tej warstwy. Zapisane jako pozycja otwarta w `docs/ROADMAP.md`. Push wymaga osobnej decyzji,
   bo przesuwa granicę z ADR 0008 (brak połączeń wychodzących) i bo historia z punktu 6 przestaje być lokalna.

## Konsekwencje

Historia biblioteki w Git jest dodatkiem do historii z ADR 0019 i niczego w niej nie zastępuje: cofanie, retencja i
odbudowa indeksu działają jak dotąd, a magazyn `library-git` nie jest ruszany przez retencję (ADR 0056), bo nie jest
content store. Przywracanie z Git nie jest funkcją aplikacji; wersje da się czytać zwykłym `git`.

Ograniczenia, na które się godzimy:

- Historia nie jest przepisywana (punkt 6). Element, który był czysty i publiczny, a potem dostał wykrycie sekretu, ma starszą
  wersję w poprzednich commitach.
- Zależność od stanu, nie od różnicy: commit po operacji może zawierać też zmiany z poprzedniej, nieudanej synchronizacji, a
  jego temat opisuje operację, która go wywołała. Liczba elementów dotyczy wszystkiego, co się zmieniło od ostatniego commita.
- Zmiana wykonana, gdy aplikacja jest zamknięta albo ręcznie na dysku, trafia do historii dopiero przy starcie albo przy
  następnej operacji.
- Wymaga `git` w wersji z `--pathspec-from-file` (2.26 i nowsze); starszy `git` daje ostrzeżenie zamiast commita.
- Elementy z `items/.<id>.<work|ready|old>.<pid>.<hex>` (katalogi pomocnicze zapisu) i wszystko poza `items/<id>` nie wchodzi
  do historii.
- Windows: funkcja niedostępna (punkt 1).
- Kolejność przebiegów po `afterWrite` zależy od kolejki jednego procesu; druga instancja aplikacji nie istnieje
  (blokada pojedynczej instancji), więc nie ma konkurencji o repozytorium.
