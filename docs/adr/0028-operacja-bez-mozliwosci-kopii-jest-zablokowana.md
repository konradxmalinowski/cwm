# ADR 0028: Operacja, której nie da się zabezpieczyć kopią, jest zablokowana na etapie planu

Status: zaakceptowane
Data: 2026-10-20
Zmienia: ADR 0012 (krok 2 przestaje być krokiem i staje się warunkiem wstępnym),
ADR 0013 (kontrakt adaptera zyskuje szósty element)
Źródło: korekta reguły koloru w `docs/DESIGN.md`, wpisy 22 do 24 w Decisions Log
Uzupełnione przez: ADR 0031 (kopia częściowa, decyzja właściciela z 2026-10-30)

> Uzupełnienie wprowadzone przez ADR 0031 (decyzja właściciela z 2026-10-30): operacja na elemencie
> biblioteki, którego nie da się w całości odczytać, ma trzeci wynik obok `recoverable` i `blocked`.
> Plan jest `partial`, gdy da się skopiować część czytelną: zawiera jawną listę `unrecoverable`
> (ścieżka względem katalogu elementu i przyczyna), a usunięcie wymaga osobnego potwierdzenia
> utraty tych plików, niezależnego od zwykłego zatwierdzenia. `applyDelete` ustala to z dysku
> w chwili zastosowania, nie z pól planu. Jeśli nie da się skopiować nawet części czytelnej, plan
> jest `blocked`, jak dotąd. Operacje, które nadpisują katalog elementu, nie mają planu, więc przy
> nieczytelnym wpisie po prostu się nie wykonują (`backup-failed`). Wykonuje to `LibraryService`
> (`planDelete`, `applyDelete`); gałęzie `partial` i `blocked` osiąga `tests/unit/library-salvage.test.ts`.
> Reszta tego rekordu obowiązuje bez zmian.

## Kontekst

Reguła czerwieni w systemie designu brzmiała "tego nie cofniesz". Była nieprawdziwa, bo
architektura gwarantuje kopię przed każdym zapisem (ADR 0012), więc usunięty plik da się odzyskać
z Historii. Poprawione brzmienie: czerwień znaczy "ta operacja usuwa coś, co istnieje teraz,
a przywrócenie wymaga osobnego, świadomego kroku".

Z tej korekty wyszedł przypadek, którego nie było w żadnym ADR i który nie jest sprawą designu:
**co robi aplikacja, kiedy nie potrafi zrobić kopii.** Czerwień ostrzega przed konsekwencją,
którą użytkownik może świadomie przyjąć. Brak możliwości odtworzenia nie jest konsekwencją
do przyjęcia, tylko warunkiem, którego nie spełniamy.

Przypadki, w których kopia jest niemożliwa, są konkretne i wszystkie wykrywalne odczytem:

- plik docelowy istnieje, ale jest nieczytelny (EACCES), więc nie da się skopiować jego treści,
- ACL na Windowsie daje prawo zapisu bez prawa czytania, czyli stan, w którym zapis by się udał,
  a kopia nie,
- plik jest zablokowany przez inny proces (na Windowsie naruszenie współdzielenia),
- cel jest symlinkiem prowadzącym poza root albo do czegoś nieczytelnego,
- cel nie jest zwykłym plikiem (urządzenie, FIFO, gniazdo),
- katalog docelowy leży na systemie plików tylko do czytania,
- w `userData` nie ma miejsca na obiekt kopii,
- plik przekracza limit rozmiaru obiektu w content store.

## Rozważane opcje

**Ostrzegać i wykonywać.** Odrzucone, bo zamienia gwarancję w obietnicę warunkową, o której
użytkownik dowiaduje się po fakcie. Cała wartość tego produktu stoi na tym, że zapis do
konfiguracji jest odwracalny.

**Wykrywać przy `apply`, przerywać operację.** Odrzucone, i to jest najważniejsze rozstrzygnięcie
tego ADR. W momencie zapisu część planu jest już wykonana, więc wykrycie problemu na trzecim
z siedmiu plików zostawia stan pośredni. To wprost łamie atomowość z ADR 0012. Dodatkowo
użytkownik zatwierdza wtedy plan, którego aplikacja nie jest w stanie wykonać, czyli zatwierdza
nieprawdę.

**Wykrywać na etapie `plan`, oznaczać wpis jako zablokowany, nie dopuszczać planu
do zastosowania.**

**Piąty stopień verdyktu `capabilities`.** Odrzucone, uzasadnienie niżej.

## Decyzja

### 1. Kopia przed zapisem jest twardym warunkiem wstępnym, nie krokiem

W ADR 0012 kopia była krokiem drugim z sześciu, czyli czymś, co się robi i co teoretycznie może
się nie udać. To było za słabe sformułowanie. Nowe: **jeśli kopia nie jest możliwa, operacja
nie jest wykonywana.** `WriteGate` nie ma ścieżki kodu, która zapisuje bez udanej kopii stanu
poprzedniego, a dla pliku, który dopiero powstaje, kopią jest zapis faktu nieistnienia, żeby
rollback miał co przywrócić (czyli usunięcie).

### 2. Wynik `recoverability` na każdym wpisie planu, ustalany w `plan`

```ts
type RecoverabilityStatus = 'recoverable' | 'blocked';

interface RecoverabilityVerdict {
  status: RecoverabilityStatus;
  reason: string | null;        // tekst dla uzytkownika, nie kod bledu
  probedAt: Timestamp;          // wynik sondy, wiec ma date waznosci
}

interface WritePlanEntry {
  targetPath: string;
  action: 'create' | 'modify' | 'delete' | 'link';
  recoverability: RecoverabilityVerdict;
  // ...
}

interface WritePlan {
  entries: WritePlanEntry[];
  applicable: boolean;          // false, gdy ktorykolwiek wpis jest blocked
  // ...
}
```

`plan` sonduje możliwość kopii dla każdego dotykanego pliku: czy istnieje, czy da się go
przeczytać, czy jest zwykłym plikiem, czy mieści się w limicie, czy w `userData` jest miejsce.
Sonda jest odczytem, nigdy zapisem.

### 3. Plan z choćby jednym zablokowanym wpisem nie jest wykonywalny

`apply` odmawia uruchomienia planu, w którym `applicable` jest `false`. Nie wykonuje części.
To wynika z atomowości: plan jest budowany w całości przed pierwszym zapisem, więc wykonanie
części planu jest dokładnie tym stanem, którego ADR 0012 zabrania.

Użytkownik ma dwie drogi i obie prowadzą przez nowy plan, nie przez obejście starego: usunąć
przyczynę (nadać uprawnienia, zwolnić plik, zwolnić miejsce) albo wyłączyć zablokowany element
z zakresu. Każda z nich przelicza plan od nowa.

### 4. Interfejs pokazuje to jako stan bez koloru, nie jako czerwień ani błąd

Zgodnie z `docs/DESIGN.md`: pasek w kolorze tekstu, słowo "Zablokowane" i powód. Nie czerwień,
bo czerwień jest zarezerwowana na usunięcie. Nie stan błędu, bo nic się nie zepsuło: aplikacja
poprawnie odmówiła.

## Dlaczego osobna własność, a nie piąty stopień `capabilities`

Zgadzam się z tezą, że są to rzeczy ortogonalne, ale decydujący argument jest techniczny,
nie pojęciowy.

**`capabilities(item)` jest funkcją czystą i synchroniczną.** Taka jest jej sygnatura w ADR 0013
i to nie jest przypadek: dzięki temu zestaw testów kontraktowych uruchamia się bez systemu
plików, a interfejs może wyliczyć verdykt dla całej listy elementów bez dotykania dysku.
Piąty stopień wymagałby sondy konkretnej ścieżki, czyli zmiany `capabilities` na asynchroniczne
i zależne od stanu dysku. Straciłbym czystość funkcji, na której stoi cała tania część testów.

**Granulacja się nie zgadza.** Zgodność opisuje element, a możliwość kopii opisuje plik. Agent
eksportowany do Codeksa to dwa pliki (plik agenta i wpis rejestracyjny w `config.toml`,
ADR 0013). Jeden z nich może być niemożliwy do skopiowania, a drugi nie. Verdykt na elemencie
nie ma jak tego wyrazić.

**Trwałość jest inna.** `CompatibilityVerdict` zmienia się tylko wtedy, gdy zmieni się element,
więc wolno go cache'ować do następnej edycji. `RecoverabilityVerdict` jest zdjęciem stanu dysku
i traci ważność sam z siebie, bo inny proces może zablokować plik minutę później. Dlatego ma
`probedAt`, a `verify` po zapisie jest nadal potrzebna: sonda planu zmniejsza ryzyko, ale nie
usuwa wyścigu.

**Znaczenie produktowe jest inne.** Zgodność to odpowiedź na "czy to się da wyrazić w formacie
celu", a odpowiedź `unsupported` kończy sprawę: element nie pojedzie i nic tego nie zmieni.
Możliwość kopii to odpowiedź na "czy wolno mi tego teraz dotknąć", a `blocked` jest stanem
usuwalnym: nadanie uprawnień zmienia odpowiedź bez zmiany elementu. Zlanie tych dwóch w jedną
skalę dałoby użytkownikowi jeden komunikat na dwa zupełnie różne problemy, z których jeden
da się naprawić, a drugi nie.

## Konsekwencje

Kontrakt adaptera ma sześć elementów, nie pięć. `plan` dostaje nowy obowiązek i staje się
droższy, bo wykonuje sondę na każdym dotykanym pliku. Przy liczbie plików tego produktu
(dziesiątki, nie tysiące) to koszt nieistotny, a wykonuje się w procesie roboczym razem ze
skanowaniem.

Pojawia się nowa klasa testów, wymagająca fixture'ów trudnych do zrobienia przenośnie: plik
nieczytelny, plik zablokowany przez inny proces, katalog tylko do czytania, cel niebędący
zwykłym plikiem. Część z nich ma sens tylko na jednym systemie (naruszenie współdzielenia
na Windowsie, ACL z zapisem bez czytania), więc idą do macierzy CI, a nie do testów lokalnych.
Test dla braku miejsca w `userData` wymaga podstawienia portu, nie realnego zapełnienia dysku.

Zablokowany wpis nie jest błędem w logu operacji. Jest wynikiem planowania i wchodzi do historii
jako plan niewykonany z powodem, żeby użytkownik mógł do niego wrócić po usunięciu przyczyny.

To ADR zamyka lukę, której nie zauważyłem w Etapie 0: ADR 0012 obiecywał odtworzenie plików po
nieudanej synchronizacji, nie mówiąc, co się dzieje, gdy odtworzenie jest niemożliwe z góry.
Obietnica była więc warunkowa bez zapisanego warunku.
