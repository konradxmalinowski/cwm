# ADR 0031: Zapis do biblioteki idzie przez zamianę katalogów elementu, plan i zatwierdzenie tylko przy usunięciu

Status: zaakceptowane (odpowiedź właściciela produktu na pytanie zadane przy starcie Etapu 2, 2026-10-30)
Data: 2026-10-30
Doprecyzowuje: ADR 0012 (zakres `WriteGate`: zapis poza `userData`, nie każdy zapis w aplikacji)
Opiera się na: ADR 0014 (układ `userData`), ADR 0018 (tryby plików), ADR 0019 i 0027
(content store), ADR 0028 (warunek kopii)
Źródło: Etap 2, kryterium 1 (potwierdzenie tylko przy operacji destrukcyjnej)
Uzupełnione 2026-10-31: mechanizm zapisu wielu plików elementu (dawna "Otwarta kwestia"),
dwie decyzje właściciela z 2026-10-30 (naprawa elementu niespójnego, limit ścieżki assetu)
i decyzja z 2026-10-31 (katalog roboczy i zamiana katalogów zamiast podmiany plików)

## Kontekst

ADR 0012 mówi, że `WriteGate` jest jedynym sposobem zapisu w całej aplikacji i że odmawia
zapisu bez planu i bez jawnego zatwierdzenia. Kontekst tego ADR to pliki konfiguracji
użytkownika: cudze pliki, leżące poza `userData`, które aplikacja zmienia na prośbę
i które ktoś inny (narzędzie, użytkownik w edytorze) może zmieniać równolegle.

Etap 2 wprowadza zapis innego rodzaju: elementów do `userData/library/items/<id>/`
(ADR 0014). To są własne dane aplikacji. Kryterium 1 Etapu 2 żąda potwierdzenia tylko przy
operacji destrukcyjnej. Literalne zastosowanie ADR 0012 oznaczałoby plan i kliknięcie
zatwierdzenia przy każdym zapisie w edytorze, czyli przy każdej poprawionej literówce
w opisie skilla. Użytkownik albo przestałby czytać te okna, albo przestałby edytować. Gwarancja,
którą okno miało chronić, byłaby warta mniej, nie więcej.

Jednocześnie samo "to są nasze dane" nie rozstrzyga sprawy. Obietnica "żadna edycja nie traci
poprzedniej wersji" jest dokładnie tym, co odróżnia ten produkt od edytora tekstu, więc
musi zostać zachowana także tutaj.

## Rozważane opcje

**1. Pełny `WriteGate` także dla biblioteki.** Jedna ścieżka, zero wyjątków do zapamiętania.
Odrzucone: plan z zatwierdzeniem przy każdym zapisie niszczy edycję jako czynność, a większość
kroków bramki (kontrola prefiksu względem roota celu, plan wpisów, sonda `recoverability`
dla cudzych plików) odpowiada na pytania, które dla katalogu, którego aplikacja jest jedynym
właścicielem, nie padają.

**2. Osobny, prostszy zapis biblioteki bez gwarancji.** Odrzucone, i to jest główny powód
tego ADR. Drugi mechanizm zapisu, który nie ma pliku tymczasowego z `rename`, przepisania
trybu ani sprzątania, powtórzyłby błędy, które generator już raz popełnił i naprawił (ADR 0012,
kroki 3 i 4). Do tego rozjeżdżałby się z `WriteGate` z każdą poprawką jednego z nich.

**3. Wspólny prymityw zapisu atomowego.** `WriteGate` w Etapie 5 i zapis biblioteki w Etapie 2
używają tego samego kodu w `src/infra/fs/atomic.ts`. Bramka dokłada nad nim to, czego wymagają
cudze pliki: plan, zatwierdzenie, kontrolę prefiksu. Biblioteka dokłada to, czego wymagają własne
dane: kopię poprzedniej wersji do `objects/`.

**3a. Zapis elementu przez podmianę plików w żywym katalogu `items/<id>`** (pierwsza wersja
implementacji: każdy plik osobno przez `writeFileAtomic`, `item.json` jako ostatni, sprzątanie
plików spoza nowego stanu). Odrzucone przez właściciela 2026-10-31. Powód: element to kilka
plików, a `rename` jest atomowy tylko dla jednego, więc każda osobliwość systemu plików
wymagała osobnej gałęzi. Zmiana pliku w katalog i katalogu w plik pod tą samą ścieżką,
zmiana samej wielkości liter nazwy na APFS i NTFS, nazwa zapisana w NFD obok tej samej w NFC,
dowiązanie podłożone w środku drzewa, sprzątanie plików, których nowy stan już nie zawiera: każdy
z tych przypadków dawał w tamtej wersji odrębny kod i odrębny test, a kolejne przeglądy kodu
zgłaszały następne. Katalog roboczy buduje nowy stan od zera, więc te przypadki nie mają jak
zajść.

## Decyzja

Wybrana jest opcja 3, w tym kształcie: ze wspólnego prymitywu biblioteka i `WriteGate` dzielą
elementy (patrz punkt 9), a element biblioteki zapisuje się jako całość, katalogiem (opcja 3a
odrzucona).

### 1. Element jest zapisywany w katalogu roboczym i podmieniany jako całość

`FsLibraryStore` (`src/infra/library/library-store.ts`, `item-swap.ts`) nie zapisuje plików
w żywym `items/<id>`. Zapis przebiega tak:

1. Cała walidacja ścieżek (`assertPlan`) przed pierwszym bajtem na dysku.
2. Nowy stan powstaje od zera w katalogu roboczym obok `items/<id>`. Pliki idą zwykłym zapisem
   z `fsync` (`open` z `wx`, tryb `0600`; katalogi `0700`, ADR 0018), bez pliku tymczasowego,
   bo katalog jest prywatny do chwili zamiany. `item.json` jest zapisywany jako ostatni.
3. **Oznaczenie kompletności.** Katalog budowany nazywa się `work`. Dopiero po `fsync`
   wszystkich plików i katalogów jeden `rename` zmienia jego nazwę na `ready`. Tylko `ready`
   kwalifikuje się do wejścia na miejsce elementu, więc przerwanie w trakcie zapisu pliku
   (np. pusty `item.json` tuż po `open`) nie może dać promocji niekompletnego stanu.
4. Stary `items/<id>` idzie na bok (`old`), `ready` wchodzi na jego miejsce, `old` jest usuwany.
   Usunięcie starego po udanej zamianie nie jest błędem zapisu.
5. **Nieudana zamiana** przebiega w stałej kolejności: cofnięcie `old` na miejsce, usunięcie
   `ready`, a gdy usunięcie zawiedzie, powrót `ready` do nazwy `work`, i dopiero potem błąd
   wraca do wywołującego. Dzięki temu zapis zgłoszony jako nieudany nie zostanie zatwierdzony
   później przez odzyskanie.
6. Na Windowsie każdy `rename` ponawia się pięć razy w odstępach 25 do 400 ms (antywirus
   i indekser trzymają pliki w środku). Po wyczerpaniu prób błąd ma przyczynę `busy`, a stan
   na dysku jest taki jak przed wywołaniem. Na POSIX nie ma ponowień.

**Granica gwarancji z punktu 5: poczwórna awaria dysku.** Zapis zgłoszony jako nieudany może
zostać zatwierdzony później tylko wtedy, gdy zawiodą cztery operacje z rzędu: `rename` `ready`
na miejsce, cofnięcie `old`, usunięcie `ready` i powrót `ready` do nazwy `work`. Wtedy
`items/<id>` nie istnieje, `ready` zostaje, a następne odzyskanie wprowadzi go jako element,
choć wywołujący dostał błąd. Mechanizm tego przypadku nie pokrywa i ten ADR go tak nazywa.
Dane nie przepadają (to nowy, kompletny stan), ale użytkownik, który zobaczył błąd, może
znaleźć zapisaną zmianę. Komentarz w `library-store.ts` nazywa to "podwójną usterką", licząc
tylko dwa ostatnie kroki; pełny warunek to cztery, bo bez nieudanego cofnięcia `old`
`items/<id>` by istniał i `ready` zostałby usunięty jako nadmiarowy.

**Blokada per `id`.** Zapis, usunięcie, naprawa i każdy odczyt tego samego elementu
(`read`, `readItemJson`, `readSalvage`) idą po kolei w blokadzie kluczowanej `id`, więc odczyt
czeka na trwającą zamianę tego elementu i nie zobaczy stanu między dwoma `rename`. Odczyty
innych elementów nie czekają. `list()` bierze blokadę tylko na czas naprawy każdego id, które ma
katalogi poboczne. Aplikacja ma blokadę pojedynczej instancji (`requestSingleInstanceLock`),
więc drugi proces nie zapisuje do tej samej biblioteki. `LibraryService` ma dodatkowo własną
kolejkę, ale port `LibraryStore` nie zakłada, że wywołujący serializuje.

**Nazwy katalogów pobocznych.** `.<id>.<work|ready|old>.<pid>.<12 znaków hex>`, np.
`.01J9ZQ3X8M5T7V2N4B6C0D1E2F.work.4242.a1b2c3d4e5f6`. Nazwa zaczyna się od kropki i kończy sufiksem, więc nie
jest poprawnym ULID ani nazwą elementu. `list()` je pomija i nie raportuje ich w `problems`.
Rozpoznaje je wyłącznie `parseSideDirName`. Id w nazwie mówi, do którego elementu katalog
należy, a pid z sufiksem rozdziela zapisy.

**Twarde linki dla niezmienionych plików.** Plik, którego bajty (i tryb `0600`) zgadzają się ze
starym, nie jest kopiowany, tylko dowiązany twardym linkiem z poprzedniego katalogu. Jest to
bezpieczne, bo plik nigdy nie jest modyfikowany w miejscu: każdy zapis tworzy nowy plik.
`item.json` nigdy nie jest współdzielony. Gdy linku nie da się założyć (inny wolumin, FAT,
SMB, limit linków), plik jest po prostu zapisany od nowa. Efekt jest ten sam, tylko droższy.

**Reguła odzyskania po przerwaniu** (`recoverItem`). Wykonuje ją `FsLibraryStore`, nie serwis
i nie UI, pod blokadą `id`:

- przy `write` (przed zapisem), przy `list()` (dla id, które mają katalogi poboczne) i przy
  `read`, `readItemJson` oraz `readSalvage`, ale tylko gdy `items/<id>` nie istnieje,
- `remove` nie naprawia, tylko usuwa katalogi poboczne elementu przed samym elementem, żeby po
  przerwanym usuwaniu nie wróciły jako "naprawa" skasowanego elementu.

Reguła:

- `items/<id>` istnieje: jest kompletny (stary albo już nowy), bo wchodzi na miejsce dopiero
  z nazwy `ready`. Wszystkie katalogi poboczne (`work` porzuconego budowania, `ready`
  nieudanej zamiany, `old` po udanej) są nadmiarowe i są usuwane.
- `items/<id>` nie ma (przerwanie między dwoma `rename`): wchodzi najnowszy `ready`; gdy go nie
  ma, wraca najnowszy `old`. `work` nigdy nie wchodzi, bo mógł zostać przerwany w połowie
  zapisu pliku.

Dlaczego nie traci danych: `ready` powstaje dopiero po zapisie i `fsync` wszystkiego, a `old`
jest nietkniętym starym stanem, którego treść jest dodatkowo w `objects/` od
`LibraryService.update`. Usuwane jest tylko to, co nie zostało wybrane, i dopiero po udanym
przywróceniu. Dwa `rename` nie są jedną operacją na żadnym z trzech systemów, więc okno między
nimi istnieje zawsze; reguła zamienia je z "element zniknął" w "element wrócił".

**Ścieżki a MAX_PATH.** Do chwili zamiany pliki leżą w katalogu roboczym, którego nazwa jest
o około 30 znaków dłuższa niż samo id. Limit ścieżki assetu (punkt 7) nie wlicza tej różnicy
osobno, a pomiaru na Windowsie z długim `userData` nie wykonano; to jedna z rzeczy, które
mają potwierdzić czteroplatformowa macierz CI (sekcja "Czego nie sprawdzono na macOS").

### 2. Element dokumentuje spójność: `item.json` niesie hashe pozostałych plików

`item.json` jest zapisywany jako ostatni i zawiera `bytesHash` każdego assetu i pliku snapshotu,
`version.contentHash` (hash `body.md` po normalizacji do LF, ADR 0016) oraz `versionRecordHash`
(niżej). Odczyt (`inspectStoredItem` w `item-codec.ts`) porównuje je z tym, co leży na dysku.
Rozbieżność (inny hash, brakujący plik, `body.md` niebędące UTF-8) jest **niespójnością**
(`integrity-mismatch`), a nie elementem czytanym jako poprawny: `get` odmawia, `list()` zwraca
element w osobnej grupie `inconsistent`, a nie w `items` ani w `problems`.

Po przejściu na zamianę katalogów przerwanie własnego zapisu nie zostawia już mieszanki starych
i nowych plików. Hashe zostają, bo chronią przed tym, czego zamiana nie widzi: ręczna edycja
`body.md` w edytorze, niepełne kopiowanie katalogu między komputerami, antywirus, który coś
zmienił. Plik CRLF po `checkout` z `autocrlf` czyta się jak LF i niespójnością nie jest.
Pliki na dysku, których `item.json` nie wymienia, niespójności nie powodują; przyjmuje je
`adoptDisk`.

### 3. Niespójny element ma dwie akcje naprawy i zawsze da się go usunąć

Decyzja właściciela z 2026-10-30. Użytkownik nie zostaje z elementem, którego nie da się
ani otworzyć, ani naprawić:

- **`adoptDisk`**: bajty z dysku stają się nową rewizją (pliki są prawdą, ADR 0014). Treść
  z `body.md` jest normalizowana do LF, assety z dysku wchodzą do `item.json`, wymienione
  w nim a brakujące znikają. Odmawia, gdy `body.md` nie jest UTF-8, gdy asset ma niedozwoloną
  nazwę albo gdy slug koliduje z innym elementem. Pliki systemowe (`.DS_Store`, `Thumbs.db`,
  `desktop.ini`) i osierocone pliki tymczasowe nie są przyjmowane jako assety.
- **`restoreVersion`**: wraca wersja wskazana przez `item.json`, odczytana z `objects/` pod
  hashem `versionRecordHash`. Edycja z dysku nie przepada, bo przed nadpisaniem trafia do
  `objects/` (punkt 5).

**`versionRecordHash`** to hash rekordu wersji w content store: pełnego opisu elementu razem
z treścią (`encodeVersionRecord`), zapisanego przed `item.json`. Dzięki niemu `restoreVersion`
jest odczytem jednego obiektu plus bajtów assetów i snapshotów pod ich hashami, bez rekonstrukcji.
Elementy zapisane bez tego pola dają `version-record-missing` i rozpoznany komunikat zamiast
cichej porażki.

Obie akcje odmawiają dla elementu spójnego (`not-inconsistent`). Usunięcie niespójnego elementu
idzie zwykłym planem, a gdy `item.json` jest nieczytelny, plan ma `kind`, `slug` i `title`
równe `null`, ale się buduje.

### 4. Nadpisanie wymaga udanego zapisu poprzedniej wersji do `objects/`

Przed nadpisaniem plików istniejącego elementu poprzednia wersja trafia do content store
(`objects/<aa>/<sha256>`, ADR 0019 i 0027). Warunek kopii z ADR 0028 obowiązuje bez wyjątku:
**bez udanego zapisu poprzedniej wersji nadpisanie nie zachodzi.** Nie ma ścieżki kodu, która
zapisuje element, gdy store odmówił.

Tworzenie też ma swój odpowiednik: `create` zapisuje do `objects/` rekord i bajty nowej wersji
przed zapisem na dysk, a awaria store'u blokuje `create`. To nie jest kopia poprzedniej wersji
(jej nie ma, ADR 0028 dla pliku, który powstaje, mówi o "fakcie nieistnienia"), tylko warunek,
by każda wersja na dysku miała rekord, do którego `restoreVersion` może wrócić. Rollback
tworzenia to usunięcie katalogu, które aplikacja zna z własnej struktury.

Odpowiedź `ObjectStore` nie jest przyjmowana na słowo: hash zwrócony przez `put` jest
porównywany z hashem policzonym lokalnie, a obiekt większy niż `MAX_OBJECT_BYTES` jest
odrzucany przed zapisem. Każdy hash trafia do store'u najwyżej raz w obrębie operacji.

### 5. Kopia obejmuje całe drzewo katalogu elementu, nie tylko to, co zna model

Przed każdą operacją, która nadpisze lub usunie katalog elementu (`update`, `adoptDisk`,
`restoreVersion`, `applyDelete`), serwis zapisuje do `objects/` surowe bajty wszystkiego, co
leży w katalogu: pliki w korzeniu, assety i snapshoty spoza `item.json`, snapshoty nieznanych
narzędzi, pliki systemowe i pliki o nazwie jak tymczasowa. Źródłem jest `LibraryStore.readSalvage`,
które nie idzie za dowiązaniami i nie rzuca na pojedynczym pliku, tylko wpisuje go do
`unreadable`. Manifest (lista ścieżek i hashy) też trafia do `objects/` i jest stanem "przed"
w logu operacji. Powód: zamiana katalogów i `remove` kasują wszystko, co w nim leży, więc kopia
tylko tego, co zna `item.json`, byłaby kopią niepełną (SEC-002 z audytu bezpieczeństwa).

Jeśli czegoś w katalogu nie da się odczytać (dowiązanie, brak uprawnień, drzewo głębsze niż
`MAX_TREE_DEPTH`, plik specjalny, plik większy niż limit), operacja nadpisująca (`update`,
`adoptDisk`, `restoreVersion`) nie zachodzi i zwraca `backup-failed` z listą wpisów. Usunięcie
działa inaczej, patrz punkt 6.

### 6. Plan i jawne zatwierdzenie tylko przy usunięciu elementu

Usunięcie to jedyna operacja na bibliotece, po której element przestaje istnieć jako plik,
a przywrócenie wymaga osobnego, świadomego kroku (to jest definicja z reguły czerwieni,
ADR 0028). Przechodzi więc przez dwa kroki:

- `planDelete` buduje plan: który element, w jakiej wersji (`revision`, hash treści), czy jest
  spójny, odcisk stanu dysku (`stateHash`, hash manifestu surowych plików) i `recoverability`
  w kształcie z ADR 0028,
- `applyDelete` wykonuje plan po zatwierdzeniu.

`recoverability` ma trzy wartości. `recoverable`: kopia całego drzewa jest możliwa. `blocked`:
kopii nie da się zapisać (store odmawia, element nie daje się w ogóle odczytać), plan nie jest
wykonywalny (`applicable: false`). `partial`: kopia obejmie tylko to, co da się odczytać,
a plan zawiera jawną listę `unrecoverable` (ścieżka względem katalogu elementu i przyczyna).
Decyzja właściciela z 2026-10-30: element, którego nie da się w całości odczytać, nie jest
przez to nieusuwalny, ale utrata nieczytelnych plików wymaga osobnego potwierdzenia
(`acknowledgeUnrecoverable`), niezależnego od zwykłego zatwierdzenia usunięcia. Jeśli nie da się
skopiować nawet części czytelnej, plan jest `blocked`. Szczegóły w uzupełnieniu ADR 0028.

**`applyDelete` nie ufa planowi.** Plan przyjdzie w kawałku C z renderera przez IPC, więc jest
niezaufanym wejściem (ARCHITECTURE 7.2, reguła 2). Z planu `applyDelete` bierze wyłącznie
`itemId` i `stateHash`. Status, listę nieczytelnych wpisów, potrzebę potwierdzenia i to, czy
element jest spójny, wyznacza ponowny odczyt dysku w momencie zastosowania. Plan `partial`
przerobiony na `recoverable` nadal wymaga potwierdzenia; plan `blocked` przerobiony na
`applicable` nadal nie usuwa niczego bez kopii; `itemId`, który nie jest ULID, daje `not-found`
i nie dociera do magazynu. Zmiana jakiegokolwiek bajtu w katalogu elementu między planem
a zastosowaniem (także ręczna edycja `body.md` spójnego elementu) przeterminowuje plan
(`stale-plan`). Przed usunięciem treść trafia do `objects/` (punkt 5). Niemożność zapisu kopii
blokuje plan już w `planDelete` (ADR 0028), a nie przerywa usuwanie w połowie.

### 7. Limity rozmiaru i głębokości

Źródło: `src/core/model/library-limits.ts`, wspólne dla walidatora (core) i magazynu (infra),
żeby zapis nie przyjął niczego, czego odczyt potem nie przeczyta. Elementy to pliki tekstowe
rzędu kilobajtów (ADR 0027), więc limity są hojne dla użytkownika i ciasne dla importowanego
repozytorium (ARCHITECTURE 8.1).

| Limit | Wartość | Uzasadnienie |
|---|---|---|
| `MAX_ASSET_PATH_LENGTH` | 120 znaków | `userData` na Windowsie plus `library/items/<id>/assets/` zjadają ponad połowę `MAX_PATH` = 260, a reszta musi starczyć też narzędziom użytkownika, które czytają skopiowany plik. Decyzja właściciela z 2026-10-30; wcześniejsza propozycja 220 znaków przekraczała 260 już przy samym `userData`. |
| `MAX_ASSET_PATH_SEGMENTS` | 16 | Z prefiksem `snapshots/<tool>/` sięga około jednej czwartej `MAX_TREE_DEPTH`, więc zapis nie wyprodukuje drzewa, którego odczyt nie przejdzie. |
| `MAX_TREE_DEPTH` | 64 | Najgłębsze drzewo, jakie magazyn potrafi odczytać i posprzątać; chroni przed zawieszeniem na drzewie podłożonym z zewnątrz. |
| `MAX_ASSETS_PER_ITEM`, `MAX_SNAPSHOT_FILES_PER_TOOL` | po 200 | Zapis kosztuje około 15 ms na plik (`fsync`, odczyt kontrolny), więc 200 plików to około 3 s w kolejce zapisów. |
| `MAX_FILE_BYTES` | 5 MiB | Pojedynczy plik pomocniczy lub źródłowy; skill z obrazkami mieści się z dużym zapasem. |
| `MAX_ITEM_BYTES` | 25 MiB | Suma `item.json`, `body`, assetów i snapshotów jednego elementu, kilkanaście razy więcej niż realny skill. |
| `MAX_ITEM_JSON_BYTES` | 4 MiB | `item.json` niesie metadane i `unmappedKeys`; więcej oznacza śmieci albo atak. |
| `MAX_OBJECT_BYTES` | 16 MiB | Rekord wersji zawiera `body` w JSON, a escapowanie znaków sterujących (`\u0000`, 6 bajtów) może go powiększyć sześciokrotnie, więc zapis sprawdza rozmiar zakodowanego rekordu. Skutek: `body` złożone ze znaków sterujących jest odrzucane od około 2,5 MiB. |

Przekroczenie limitu przy zapisie to błąd walidacji z komunikatem po polsku i z podaną wartością
limitu (`limit-exceeded`, `asset-path-too-long`). Przy odczycie z dysku to rozpoznany błąd
magazynu (`too-large`, `path-too-deep`), nie alokacja. Limit ścieżki jest jedynym, który chroni
cały magazyn, nie tylko jeden element: ścieżka assetu, której odczyt nie przejdzie, blokowała
w pierwszej wersji zapisy w całej bibliotece (SEC-001).

### 8. Kolizje slugów a awarie magazynu

Sprawdzenie kolizji `lower(slug)` + typ (ADR 0017) czyta `item.json` wszystkich elementów
(`existingSlugs`). Błąd odczytu jednego z nich może znaczyć dwie różne rzeczy, więc serwis je
rozróżnia po `failureCode`:

- **przejściowe** (`busy`, `no-space`, `unknown`): zapis jest przerywany błędem `store-failed`.
  Pominięcie elementu mogłoby ukryć kolizję i dopuścić drugi element o tym samym slugu.
- **trwałe** (`symlink`, `permission-denied`, `path-too-deep`, `not-a-file`, `too-large`,
  `invalid-path`): element jest pomijany. Inaczej jeden uszkodzony element blokowałby zapisy
  w całej bibliotece (SEC-001). Trafia do `list().problems` i da się go usunąć planem `partial`.
  Kody `too-large` (plik ponad limit) i `invalid-path` (nazwa lub ścieżka odrzucona przez
  magazyn: wyjście w górę, nazwa tymczasowa, nieprzenośna nazwa) doszły po rundzie 6;
  wcześniej magazyn mapował je na `unknown`, czyli na przyczynę przejściową, i nieczytelny
  element blokował wszystkie zapisy. `path-conflict` (plik i katalog pod tą samą ścieżką) ma
  teraz kod `not-a-file`.

Koszt, przyjęty świadomie: pominięty element nie chroni już swojego sluga, więc do czasu
naprawy lub usunięcia da się utworzyć drugi o tym samym slugu. Element z przeczytanym, ale
nieparsowalnym `item.json` też nie blokuje. Natomiast element niespójny, ale z parsowalnym
`item.json`, blokuje slug jak każdy inny. Odczyt wszystkich `item.json` przy każdym zapisie jest
liniowy; indeks slugów w kawałku B (ROADMAP) go zastąpi.

### 9. Zakres ADR 0012 zostaje doprecyzowany

Plan i zatwierdzenie dotyczą **zapisu poza `userData`**, czyli konfiguracji narzędzi. Zapis
własnych danych aplikacji w `userData/library/` idzie przez katalog roboczy i zamianę katalogów
(punkt 1), z wspólnymi z `WriteGate` elementami `src/infra/fs/atomic.ts` (`rename` z ponowieniami,
`fsync` katalogu, nazwy plików tymczasowych) i z warunkiem kopii. Plan i zatwierdzenie wymaga
tylko usunięcie. Sam `writeFileAtomic` (plik tymczasowy, `rename`, przepisanie trybu, sprzątanie,
odczyt kontrolny; ADR 0012, kroki 3 i 4) używa dziś `ObjectStore`, a w Etapie 5 użyje go
`WriteGate`. Zdanie "`WriteGate` jest
jedynym sposobem zapisu w całej aplikacji" z ADR 0012 należy czytać jako "jedynym sposobem
zapisu do plików, których aplikacja nie jest właścicielem". Adaptery nadal nie dostają `node:fs`
i nadal nie mogą pisać same.

## Obietnica "żadna edycja nie traci poprzedniej wersji": trzy pytania z ARCHITECTURE 2.4

To zdanie gwarantuje coś w czasie teraźniejszym, więc podlega regule z sekcji 2.4.

**Kto to wykonuje.** `LibraryService`, przed wywołaniem zapisu, przez port `ObjectStore`.
Nie robi tego prymityw atomowy ani `LibraryStore` (nie znają content store i nie wiedzą, czym
jest wersja elementu). Kolejność jest wymuszona w jednym miejscu: serwis zapisuje poprzednią
wersję, dostaje potwierdzenie, dopiero wtedy woła zapis.

**Co się dzieje, gdy się nie da.** Zapis jest przerywany przed dotknięciem plików elementu.
Użytkownik dostaje błąd z rozpoznaną przyczyną (store niedostępny, brak miejsca, brak
uprawnień), a nie ogólny komunikat o nieudanym zapisie. Element na dysku pozostaje taki,
jaki był. Edytowana treść nie jest tracona po stronie interfejsu, bo błąd wraca do wywołującego
przed jakąkolwiek zmianą stanu.

**Czy da się do tego przypadku dojść.** Tak, i jest na to test, nie założenie. Test wymusza
awarię store'u przez atrapę portu `ObjectStore`, która odmawia `put`, wywołuje edycję
istniejącego elementu i sprawdza, że pliki elementu są bajt w bajt takie jak przed próbą.
To kryterium A2 w planie Etapu 2. Bez tego testu gałąź "store odmawia" byłaby kodem, którego
nikt nie uruchomił, czyli dokładnie tym, przed czym ostrzega sekcja 2.4 (czwarty nawrót,
ADR 0029 punkt 4).

## Pozostałe gwarancje tego ADR: trzy pytania z ARCHITECTURE 2.4

Każde zdanie z punktów 1 do 8, które coś gwarantuje, ma niżej swoje trzy odpowiedzi. Kolumna
"Jak dojść" wskazuje test, który doprowadza kod do tej gałęzi, a nie tylko opisuje ją.

| Gwarancja | Kto to wykonuje | Co się dzieje, gdy się nie da | Jak dojść do tego przypadku |
|---|---|---|---|
| Przerwany zapis zostawia cały stary albo cały nowy element, nigdy mieszankę (pkt 1) | `FsLibraryStore.write`: budowa w katalogu roboczym, potem dwa `rename` | Błąd zapisu z przyczyną (`busy`, `no-space`, `permission-denied`), katalog roboczy sprzątany, stary stan na miejscu | `library-store-swap.test.ts`: szew `rename` wymusza awarię w kolejnych punktach zamiany, w tym cofnięcie, które też zawodzi |
| Stan między dwoma `rename` jest naprawiany (pkt 1) | `recoverItem` w `FsLibraryStore`, przy `write`, `list` i odczytach | Gdy naprawa sama zawiedzie (np. `rename` zwraca `busy`), błąd wraca do wywołującego, a katalogi poboczne zostają do następnej operacji; dane są w nich nietknięte | `library-store-swap.test.ts`, "odzyskanie po przerwaniu": stan zbudowany ręcznie, po jednym teście na każdą gałąź reguły i na każdy rodzaj odczytu |
| Katalog poboczny nigdy nie jest elementem (pkt 1) | `FsLibraryStore.list` przez `parseSideDirName` | Bez filtra katalog poboczny trafiłby do `problems` jako element o niepoprawnym id | `library-store-swap.test.ts`, "format nazw katalogów pomocniczych": `list()` pomija je, a serwis nie widzi ich w `problems` |
| Niezmieniony plik jest linkiem, a gdy link niemożliwy, kopią (pkt 1) | `shareUnchanged` w `FsLibraryStore` | Każdy błąd `link` przechodzi w zwykły zapis pliku, bez błędu dla użytkownika | `library-store-hardening.test.ts`, "niezmienione pliki": inode zachowany dla niezmienionego, nowy dla zmienionego, a szew `link` z `EXDEV` wymusza gałąź kopii |
| Rozbieżność plików z hashami w `item.json` jest niespójnością (pkt 2) | `inspectStoredItem` w core, wołany przez `get`, `list`, mutacje | `get` odmawia z `integrity-mismatch`, `list` pokazuje element w `inconsistent`; nic nie jest zwracane jako poprawne | `library-repair.test.ts`, "list: element niespójny"; `library-acceptance-fs.test.ts`: zapis przerwany przed `item.json` na prawdziwym dysku |
| Naprawa niespójnego elementu zachowuje stan z dysku (pkt 3) | `LibraryService.adoptDisk` i `restoreVersion` | Odmowa z rozpoznanym powodem (`version-record-missing`, `integrity-mismatch`, `backup-failed`), dysk bez zmian | `library-repair.test.ts`: awaria `ObjectStore`, brak i uszkodzenie rekordu, element bez wskaźnika |
| Nic z katalogu elementu nie ginie bez kopii (pkt 5) | `LibraryService.archiveSalvage` przez `readSalvage` | Nieczytelny wpis blokuje `update`, `adoptDisk` i `restoreVersion` (`backup-failed`), a usunięcie schodzi do planu `partial` | `library-round3.test.ts`, SEC-002; `library-store-hardening.test.ts`, `readSalvage` |
| `applyDelete` nie wykonuje niczego na podstawie pól planu poza `itemId` i `stateHash` (pkt 6) | `LibraryService.applyDelete`, ponowny odczyt dysku | `plan-blocked`, `stale-plan` albo `unrecoverable-unacknowledged`; magazyn nie dostaje `remove` | `library-round4.test.ts`: plan przerobiony na `recoverable` albo `applicable`, `itemId` niebędący ULID |
| Zapis nie przyjmie niczego, czego odczyt nie przeczyta (pkt 7) | `checkSizeLimits`, `validateAssetPaths` w core; limity z tego samego pliku w infra | Błąd walidacji z komunikatem i wartością limitu, przed pierwszym bajtem na dysku | `library-hardening.test.ts` i `library-round3.test.ts`: dla każdego limitu wartość graniczna przechodzi, wartość + 1 nie |
| Awaria odczytu jednego elementu nie ukrywa kolizji ani nie blokuje biblioteki (pkt 8) | `existingSlugs` w `LibraryService`, po `failureCode` | Przejściowa przerywa zapis (`store-failed`), trwała pomija element do `problems` | `library-round3.test.ts`: `it.each` po `busy`, `no-space` i po czterech kodach trwałych |

## Czego nie sprawdzono na macOS i co potwierdzi macierz CI

Implementację napisano i uruchomiono na macOS. Trzy zachowania dotyczą innych systemów
plików i nie mają dowodu z tej maszyny:

1. **`rename` katalogu z otwartym plikiem w środku na Windowsie** (do potwierdzenia przez macierz CI). Oczekiwane `EPERM` albo
   `EBUSY`, przeczekiwane ponowieniami do około 775 ms, potem `busy` ze starym stanem na miejscu.
   Test jednostkowy wymusza te kody szwem i symuluje `platform: 'win32'`, więc dowodzi logiki
   ponowień, nie zachowania NTFS. Potwierdzi go przebieg na `windows-latest`.
2. **Junction.** Test dowiązań tworzy na Windowsie junction zamiast symlinku (bo symlink wymaga
   uprawnień), więc gałąź odrzucenia dowiązania dostanie prawdziwy dowód dopiero na
   `windows-latest`. Zakładamy, że `lstat` zgłasza junction jako dowiązanie; to założenie, nie
   odczyt.
3. **Twarde linki na FAT i SMB.** Gałąź kopii zapasowej jest sprawdzona szwem `link`
   wymuszającym `EXDEV`, nie prawdziwym woluminem. Macierz CI (`ubuntu-latest`, `macos-15`,
   `macos-15-intel`, `windows-latest`) nie ma woluminu FAT ani SMB, więc dla nich dowodu nie
   będzie ani z lokalnej maszyny, ani z CI. Gdy link się nie uda, kod zapisuje plik od nowa
   (wynik ten sam, koszt wyższy); gdy link uda się, a system plików go źle raportuje, to jest
   luka, której ten ADR nie zamyka.

Status: kryterium 10 Etapu 2 (element zapisany na Linuksie otwiera się na macOS i Windowsie)
oraz `rename` katalogu na Windowsie są **do potwierdzenia przez macierz CI**. Lokalnie
kryterium 10 jest spełnione, ale nie jest to jeszcze dowód ostateczny.

## Konsekwencje

Edycja w edytorze zapisuje od razu, bez okna zatwierdzenia. Czerwień i potwierdzenie
pojawiają się tylko przy usunięciu, co zgadza się z regułą koloru z `docs/DESIGN.md`:
intensywność rośnie z wagą konsekwencji.

Prymityw zapisu atomowego (`src/infra/fs/atomic.ts`) powstaje w Etapie 2, a nie w Etapie 5.
Etap 5 nie pisze go od nowa, tylko go używa, więc część ryzyka tego etapu jest zdjęta
z wyprzedzeniem, ale poprawki w nim muszą być zgodne z zapisem biblioteki (`renameWithRetry`,
`syncDirectory` i nazwy plików tymczasowych są wspólne). Test prymitywu jest jeden
(`tests/integration/atomic.test.ts`); zapis biblioteki ma własne testy w `tests/integration/library-store*.test.ts`.

Zapis elementu jest droższy niż podmiana jednego pliku: powstaje cały katalog, a niezmienione
pliki są dowiązywane, nie kopiowane. Przy elementach rzędu kilobajtów i limicie 200 plików
(punkt 7) koszt jest akceptowalny; zapis jest w kolejce, więc nie przeplata się z innym.
Odczyt wszystkich `item.json` przy każdym zapisie (punkt 8) rośnie liniowo z liczbą elementów
i przechodzi do indeksu w kawałku B.

Edycja wykonuje dodatkowy zapis do `objects/`, więc content store rośnie przy każdej zmianie
treści (ADR 0027: rośnie monotonicznie, rozmiar widoczny w Settings, deduplikacja usuwa
przypadek zmiany jednej linii w niezmienionych plikach). Koszt jest znikomy przy plikach
rzędu kilku kilobajtów.

**Log operacji nie obejmuje jeszcze edycji i usunięć.** ADR 0019 przewiduje wpis w logu
dla każdej edycji i usunięcia. Log żyje w `index.sqlite` i powstaje w kolejnym kawałku
Etapu 2, a nie w tym. Do tego czasu wersje w `objects/` istnieją (warunek kopii działa już
teraz), ale wpisów logu, który mówi, kiedy i która wersja została zastąpiona, nie ma. Edycje
i usunięcia wykonane w tym okresie będą miały treść do odzyskania, ale nie będą miały
historii zdarzeń. Z natury logu (ADR 0014: nieodtwarzalny z plików) tej luki nie da się
wypełnić wstecz, więc jest to świadomie przyjęty koszt kolejności prac, nie przeoczenie.
Wersje w `objects/` nie są przy tym osierocone w sensie czyszczenia: czyszczenia nie ma
(ADR 0027), a przyszła polityka liczy referencje, nie wiek obiektu.

Testy: A2 (awaria store'u, element nietknięty), A3 (usunięcie wymaga planu, `apply` odmawia
planu przeterminowanego, treść trafia do `objects/` przed usunięciem), test negatywny
i pozytywny prymitywu oraz zapisu biblioteki (ARCHITECTURE 12.5) i testy z tabeli gwarancji
powyżej, w tym niespójny element po przerwanym zapisie.
