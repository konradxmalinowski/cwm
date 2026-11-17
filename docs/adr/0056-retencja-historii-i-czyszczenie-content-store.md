# ADR 0056: retencja historii i czyszczenie content store

Status: zaakceptowane w zakresie planu (2026-11-17)
Data: 2026-11-17
Dotyczy: ADR 0008 (granica IPC), ADR 0014 (log operacji nie wraca z plików), ADR 0019 (historia na content store), ADR 0027 (pełne treści z deduplikacją, czyszczenie odroczone), ADR 0028 (kopia przed operacją), ADR 0030 (blokada wspólna z odbudową indeksu), ADR 0034 (usuwanie tylko przy cofnięciu)
Źródło: plan `plans/2026-11-17-content-store-gc.md` (lokalny, poza repozytorium); kod w `src/core/services/retention/`, `src/infra/store/object-inventory.ts`, `src/infra/store/retention-settings.ts`, `src/main/services/retention-runner.ts`, `src/renderer/app/features/diagnostics/retention-section.component.*`

## Kontekst

ADR 0027 zapisał pełne treści każdej wersji w `objects/<aa>/<sha256>` i świadomie odroczył limit rozmiaru oraz
czyszczenie, z jednym zobowiązaniem: usuwanie wymaga liczenia referencji, nie wieku obiektu, bo ten sam obiekt bywa
równocześnie wersją elementu, kopią sprzed zapisu do narzędzia i wpisem operacji. Store rośnie monotonicznie, a log
operacji w `index.db` jest jedyną rzeczą, której nie da się odtworzyć z plików (ADR 0014). Ta decyzja dokłada politykę
nad istniejącym store'em. Model danych, format obiektów i schemat indeksu zostają bez zmian.

## Rozważane opcje

**Czyszczenie po wieku obiektu** (usuń wszystko starsze niż N dni). Odrzucone: wiek pliku nie mówi nic o tym, czy
biblioteka albo niecofnięty zapis go jeszcze potrzebuje. Element niezmieniany od roku ma rekord wersji sprzed roku, a
ADR 0027 zabrania tej drogi.

**Licznik referencji zapisany w bazie.** Odrzucone: to druga kopia prawdy, która rozjeżdża się z plikami po awarii,
ręcznej edycji albo odbudowie indeksu. Osiągalność jest tania do przeliczenia (jeden odczyt rekordu na wersję), więc
liczymy ją za każdym razem od zera.

**Osiągalność liczona przy każdym przebiegu (mark-and-sweep).** Wybrane.

## Decyzje

1. **Polityka to trzy opcjonalne limity, domyślnie żaden.** `maxEntries` (10 do 1 000 000), `maxAgeDays` (1 do 3650) i
   `maxStoreMiB` (16 do 1 048 576); nigdy nie dotyczą 10 najnowszych wpisów (podłoga, `MIN_KEPT_GROUPS`); każdy `null` albo liczba całkowita w zakresie, poza zakresem to błąd, nie przycięcie.
   Komplet `null` to zachowanie sprzed tej zmiany: nic nie jest przycinane, a jedyne, co usuwa czyszczenie, to obiekty
   bez żadnego odwołania. Ustawienia leżą w `<userData>/retention.json` (tryb 0600, zapis atomowy). Plik nieczytelny albo
   niezgodny z zakresami daje komplet `null`, więc usuwanie nigdy nie wynika z ustawień, których nie dało się odczytać.
2. **Jednostką przycięcia jest wpis historii, czyli grupa wierszy ze wspólnym `backup_id`** (wiersz bez kopii to osobna
   grupa), tak jak widzi to Historia. Limity liczby i wieku dotyczą wpisów. Limit rozmiaru dotyczy obiektów osiągalnych z
   biblioteki i zachowanych wpisów: gdy są większe niż limit, przycinane są kolejne najstarsze wpisy, aż suma zejdzie
   poniżej limitu albo zostaną wyłącznie wpisy chronione. Wpis bez czytelnej daty nie starzeje się. Przycina się
   zawsze od najstarszych. Limit wieku ufa zegarowi tylko wtedy, gdy ten nie jest przed najnowszym wpisem logu; w
   przeciwnym razie jest pominięty, a przebieg mówi o tym (`ageRuleSkipped`).
3. **Obiekt jest usuwany wyłącznie przez osiągalność.** Korzenie: (a) rekord wersji wskazywany przez `versionRecordHash`
   w `item.json` każdego elementu biblioteki, także niespójnego, bo naprawa przywraca wersję z `objects/`; (b) hashe
   `before` i `after` z zachowanych wierszy logu; (c) pliki `before` z `MANIFEST` kopii zachowanych wpisów. Rekord wersji
   wskazuje dalej na `assets[].bytesHash` i `source.snapshots[].files[].bytesHash`, a manifest stanu z dysku (usunięcie
   albo nadpisanie niespójnego elementu) na `salvaged[].hash`. Domknięcie ma jeden poziom: dzieci są plikami, nie
   korzeniami. Każdy obiekt w store bez odwołania z któregokolwiek korzenia jest usuwalny, także ten osierocony przez
   wcześniej przerwany przebieg albo nieudany zapis. Wieku obiektu kod nigdzie nie porównuje.
4. **Zawsze chronione:** cała biblioteka; ostatnia operacja, którą da się cofnąć (zapis do narzędzia z kopią, niecofnięty)
   razem z kopiami z jej `MANIFEST`; wpis cofający, dopóki zachowany jest wpis cofnięty (inaczej cofnięty zapis wyglądałby
   znów na możliwy do cofnięcia, a jego kopia mogłaby zostać zastosowana drugi raz). Gdy limit rozmiaru nie da się
   osiągnąć z tego powodu, przebieg mówi o tym (`sizeLimitUnmet`) i nie usuwa niczego ponad to, co jest bez odwołań.
5. **Brak dowodu osiągalności to brak działania.** Przebieg kończy się raportem `blocked` i niczego nie zmienia, ani
   wpisów, ani plików, gdy: któregoś elementu biblioteki nie da się odczytać (brak `item.json`, błąd odczytu,
   nieparsowalny plik); brakuje katalogu `library/items`; biblioteka jest pusta, a log i store nie (wygląda na utratę
   biblioteki); korzeń zachowanego wpisu albo elementu jest w store uszkodzony albo go brakuje (jego dzieci są
   nieznane); `MANIFEST` kopii zachowanego wpisu jest nieczytelny z innego powodu niż brak katalogu kopii (`ENOENT`).
   Korzeń wpisu, który właśnie jest przycinany, nie blokuje. Nazwy katalogów, które nie są identyfikatorem elementu,
   nie są elementami i nie blokują.
6. **Kolejność jest częścią gwarancji.** Przy wykonaniu najpierw znikają wiersze logu (jedna transakcja SQLite, trwała
   przed dalszymi krokami), dopiero potem pliki obiektów, każdy osobno. Przerwanie po pierwszym kroku zostawia obiekty
   bez odwołań, czyli osierocone pliki, które usunie następny przebieg bez żadnej dodatkowej logiki. Odwrotna kolejność
   zostawiałaby wpisy historii wskazujące na brakujące obiekty. Plik, którego nie udało się usunąć (na przykład zajęty
   przez inny program na Windowsie), jest liczony w `objectsFailed` i czeka na następny przebieg. Na końcu powstaje wpis
   `prune-history` w logu (`itemId` to stała `retention`, `note` niesie liczby, nigdy ścieżkę); awaria tego wpisu nie
   cofa przycięcia.
7. **Suchy przebieg to ta sama ścieżka bez zapisu.** Podgląd liczy dokładnie to, co zrobi wykonanie, na zapisanych
   ustawieniach, i zwraca liczbę wpisów, obiektów i bajtów. Wykonanie nie ufa podglądowi i przelicza wszystko od nowa pod
   blokadą, więc zmiana stanu między nimi daje inne liczby, ale nigdy usunięcie czegoś osiągalnego.
8. **Współbieżność: blokada wyłączna wspólna z odbudową indeksu** (`OperationLock.tryEnterExclusive`, ADR 0030). Zapis
   w toku wkłada obiekty do store'u, zanim dopisze wiersz logu, więc w tym oknie nowy obiekt wyglądałby na osierocony.
   Dlatego przebieg nie startuje, gdy trwa jakikolwiek zapis (`busy`), a zapisy w jego trakcie dostają `busy`. Biblioteka
   jest odczytywana w kolejce własnych zapisów `LibraryService`, więc nie widzi połowy zapisu elementu.
9. **System plików: tylko `<userData>/objects`, bez podążania za dowiązaniami.** Spis czyta katalog przez `lstat`: katalog
   `<aa>`, który jest dowiązaniem albo nie-katalogiem, i plik, który jest dowiązaniem albo nie zwykłym plikiem, są
   pomijane (`objectsSkipped`), a ich cel nie jest dotykany. Obiektem jest wyłącznie zwykły plik o nazwie 64 znaków hex w
   katalogu o jej dwuznakowym prefiksie. Usunięcie ponownie sprawdza `lstat` tuż przed `unlink` i odmawia dowiązania.
   Katalogu głównego, który jest dowiązaniem, spis odmawia. Pliki tymczasowe zapisu zostają po stronie `FsObjectStore`.
10. **Przebieg przy starcie tylko przy włączonym limicie i bez nadzoru**, po wypełnieniu indeksu biblioteki i zwolnieniu
    blokady startowej, w osobnym łańcuchu, żeby raport diagnostyczny nie czekał na czyszczenie. Zajęta blokada to
    pominięcie, nie błąd. Bez żadnego limitu przy starcie nie dzieje się nic. Bezpieczniki tego przebiegu:
    (a) jest pomijany, gdy w tym uruchomieniu indeks został utworzony, odbudowany albo odłożony do kwarantanny, bo
    jego log jest pusty albo niewiarygodny, a pusty log nie dowodzi, że obiekty są zbędne; (b) przy pustym logu i
    obiektach poza biblioteką nie czyści (`empty-log`), zrobić to może tylko jawne, potwierdzone wykonanie z ekranu;
    (c) odmawia, gdy plan usunąłby ponad 90% wpisów (`mass-prune`). Powód pominięcia albo odmowy zostaje w main do końca
    sesji i Diagnostyka pokazuje go przy sekcji (`startupNotice`).
11. **Granica IPC.** Cztery kanały `retention:get`, `retention:set`, `retention:preview`, `retention:apply`. Żaden nie
    przyjmuje ścieżki, hashy ani numerów wierszy: `set` jest walidowany w main (trzy znane pola plus `confirmed`), `apply`
    buduje wynik z dwóch pól (`confirmed`, `token`), a odpowiedź to liczby, bez tekstu błędów ze store'u. Kanały nie są w
    `WRITE_CHANNELS`, bo biorą blokadę wyłączną same; nowy kanał zapisujący obiekty albo wiersze logu musi tam trafić.
    **Zapis, który włącza albo zaostrza limit, wymaga `confirmed: true`**, bo przy najbliższym starcie usunąłby wpisy bez
    pytania; interfejs pokazuje wcześniej podgląd z liczbami dla nowych limitów. **Podgląd zwraca token** (hash liczb planu,
    czasu i soli, jednorazowy, ważny 5 minut, zapamiętany w main razem z limitami). `apply` musi go podać, odmawia przy
    zmianie zapisanych limitów od podglądu (`stale-plan`) i przerywa się przed usunięciem czegokolwiek (`plan-changed`),
    gdy przeliczony plan usuwa więcej wpisów albo obiektów, niż pokazał podgląd.
12. **Interfejs: sekcja na ekranie Diagnostyka**, obok ręcznej odbudowy indeksu, bo to ta sama klasa operacji (nieodwracalna
    po potwierdzeniu, pod wspólną blokadą). Aplikacja nie ma osobnego ekranu Ustawienia (kanały `settings:*` usunięto w
    Etapie 10). Formularz z trzema polami (puste znaczy brak limitu), przycisk zapisu, "Sprawdź, ile zwolni", plan z
    liczbami, pole potwierdzenia i "Wyczyść teraz". Podgląd jest dostępny dopiero po zapisie ustawień, bo liczy na
    zapisanych. Rozmiar store'u, którego widoczność obiecywał ADR 0027, jest w podglądzie ("zwolni X z Y").

## Konsekwencje

- Przycięcie wpisów jest nieodwracalne: log operacji nie wraca z plików (ADR 0014). Dlatego domyślnie nic nie jest
  przycinane, a ręczne czyszczenie wymaga podglądu i jawnego potwierdzenia. Przy włączonym limicie przycinanie przy
  starcie jest zamierzone i opisane w interfejsie.
- Po przycięciu wpisu jego operacji nie da się już cofnąć z Historii, a obiekty, które znały tylko ten wpis, znikają.
  Ostatnia operacja do cofnięcia zostaje zawsze.
- Katalog `backups/<id>/` nie jest czyszczony i zostaje poza zakresem tej decyzji: kopie przyciętych wpisów leżą dalej na
  dysku i da się z nich odzyskać pliki ręcznie, ale Historia ich już nie pokaże. Obiekty z ich `MANIFEST` przestają być
  chronione, bo są redundantne wobec samych plików kopii (rollback czyta z `backups/`, a z `objects/` tylko w obrębie
  trwającego zapisu). Czyszczenie `backups/`, `materialized/` i `quarantine/` wymaga osobnej decyzji.
- Wersja elementu, którą zna już tylko przycięty wpis, nie wróci. Przywracanie z `objects/` jest dziś jedynie akcją
  naprawy elementu niespójnego i używa wersji z `item.json`, więc ta wersja jest zawsze chroniona.
- Koszt przebiegu rośnie z liczbą wersji: raz odczytywany jest każdy korzeń (z deduplikacją po hashu). Przebieg liczy
  osiągalność od zera, bez trwałego licznika, który mógłby się rozjechać.
- Raport diagnostyczny (ADR 0053) nie mówi już, że aplikacja nie zapisuje ustawień; wymienia retencję, bez wartości.
- **Znane ograniczenie (fail closed):** jedno uszkodzone coś, czego użytkownik nie umie naprawić z aplikacji (element
  biblioteki bez czytelnego `item.json`, brakujący obiekt zachowanego wpisu, uszkodzony `MANIFEST`), blokuje czyszczenie
  w całości do czasu naprawy albo usunięcia elementu, a wpis z brakującym korzeniem znika dopiero po przycięciu go
  limitem. Wybrane świadomie: lepiej nie zwolnić miejsca niż usunąć obiekt, którego potrzeba nie została wykluczona.
  Ta sama zasada blokuje czyszczenie przy pustej bibliotece i niepustym logu (na przykład po usunięciu ostatniego
  elementu), dopóki w bibliotece nie pojawi się element.
- Zmieniony komunikat `busy` kanałów zapisujących: "Trwa odbudowa indeksu albo czyszczenie historii."

## Poza zakresem

Czyszczenie `backups/`, `materialized/` i `quarantine/`; cykliczne czyszczenie poza startem aplikacji; eksport historii
przed przycięciem; retencja logu aplikacji (`app.log` ma własną rotację).
