# ADR 0034: Sieroty są tylko raportowane, a usunięcie pliku w narzędziu jest możliwe wyłącznie przy cofnięciu operacji

Status: zaakceptowane (odpowiedź właściciela produktu na pytanie 4 z Etapu 0, 2026-11-03)
Data: 2026-11-03
Doprecyzowuje: ADR 0012 (akcje `WriteGate`), ADR 0025 (los bloku instrukcji po usunięciu elementu),
ADR 0028 (kopia jest warunkiem także dla usunięcia)
Opiera się na: ADR 0019 (cofnięcie jako zwykła operacja zapisu)
Źródło: ARCHITECTURE 15.1, pytanie 4; ROADMAP Etap 5, kryterium 4

## Kontekst

Wymagania żądają "jawnej polityki usuwania i potwierdzenia", ale nie mówią której. Pytanie
brzmiało: czy aplikacja nigdy nie usuwa i tylko raportuje sieroty (pliki w narzędziu, których
biblioteka już nie realizuje), czy usuwa to, co sama wcześniej utworzyła. Drugi wariant wymaga
wstrzykiwania do plików docelowych znacznika własności. To zmienia treść eksportu: skill
z dopisanym komentarzem nie jest już bajt w bajt tym, co użytkownik trzyma w bibliotece,
a plik bez znacznika, utworzony ręcznie, nigdy nie byłby uznany za własny, więc polityka
chroniłaby tylko część przypadków.

## Rozważane opcje

**Usuwanie własnych plików ze znacznikiem własności.** Pozwala posprzątać po elemencie
usuniętym z biblioteki. Koszt: zmiana treści każdego eksportowanego pliku, nowa klasa błędów
(znacznik skopiowany do innego pliku, znacznik usunięty edycją) i pierwsza w aplikacji
operacja, która kasuje coś, czego użytkownik nie kazał skasować w tym kliknięciu.

**Usuwanie na podstawie `sync_state` bez znacznika.** Aplikacja zna ścieżki z ostatniej
synchronizacji. Ale plik pod tą ścieżką mógł zostać w międzyczasie zastąpiony cudzym, a hash
sprzed zapisu nie rozstrzyga, kto jest jego autorem.

**Wyłącznie raport.**

## Decyzja

Aplikacja nigdy sama nie usuwa plików w narzędziu i nie dopisuje do nich znaczników własności.
Plik, którego biblioteka już nie realizuje, jest sierotą: trafia do `WritePlan.orphans`
i do `SyncStatusDto.orphans`, a użytkownik widzi go w widoku Synchronizacja. Blok instrukcji
globalnej bez elementu w zbiorze też jest sierotą, nie usunięciem (ADR 0025). Znaczniki
bloku z ADR 0025 nie są znacznikami własności w sensie tej decyzji: wyznaczają zakres edycji
jednego pliku i nie służą do rozstrzygania, co wolno skasować.

Jedyny przypadek usunięcia to cofnięcie operacji aplikacji z historii. `history:rollback`
buduje plan z `backups/<id>/MANIFEST`: dla pliku, który przed operacją nie istniał, wpis ma
akcję `delete`; dla dowiązania, które operacja zastąpiła, akcję `restore-link`. Plan przechodzi
zwykłą drogą (`export:apply`) z sondą, jawnym zatwierdzeniem i własną kopią (ADR 0019, 0028).

Trzy odpowiedzi z ARCHITECTURE 2.4:

- **Kto to wykonuje.** Wpisy `delete` i `restore-link` powstają wyłącznie w
  `HistoryService.rollback` (`src/core/services/history/history-service.ts`). Zapisuje je
  `WriteGate` (`src/infra/fs/write-gate.ts`), jedyna droga zapisu do plików narzędzi
  (ADR 0012). Regułę, że nic poza bramką nie usuwa, wymusza lint: `rm`, `unlink` i pokrewne
  są zakazane poza listą `FS_WRITE_ALLOWED` w `eslint.config.mjs`, a `npm run test:boundaries`
  wstawia taką próbę i wymaga, by lint padł.
- **Co się dzieje, gdy się nie da.** `delete` jest zablokowany (`blocked`) w planie, gdy
  nie da się zrobić kopii pliku albo gdy cel nie jest zwykłym plikiem; plik zmieniony między
  planem a zastosowaniem unieważnia plan. Plik zmieniony po cofanej operacji dostaje
  ostrzeżenie w planie ("Cofnięcie nadpisze późniejsze zmiany; przed zapisem powstanie
  kopia"). Zapis zmieniający dowiązanie do katalogu w katalog z plikami nie jest cofany
  automatycznie, tylko zgłaszany jako konflikt z odesłaniem do `backups/`.
  `delete` usuwa też puste katalogi do roota, ale nie dotyka katalogu, w którym leżą inne pliki.
- **Czy da się do tego dojść.** Tak, testami z pominięciem interfejsu:
  `tests/integration/write-gate-delete.test.ts` (akcje `delete` i `restore-link`),
  `tests/integration/sync-flow.test.ts` (cofnięcie eksportu usuwa utworzony plik, cofnięcie
  cofnięcia eksportuje go z powrotem), `tests/contract/export-contract.ts` (sierota nie jest
  nigdy wpisem planu eksportu, blok bez instrukcji w zbiorze jest sierotą).

## Konsekwencje

Element usunięty z biblioteki zostawia swoje pliki w narzędziu do czasu, aż użytkownik sam je
usunie. Widok Synchronizacja je pokazuje, ale nie ma przycisku "usuń sieroty". Użytkownik
płaci tym, że sprząta ręcznie, a w zamian aplikacja nie kasuje pliku, który mógł już uznać
za swój.

Kryterium 4 Etapu 5 ("żaden plik docelowy nie jest usuwany tylko dlatego, że nie ma go
w bibliotece") staje się własnością typu: akcja `delete` istnieje w planie, ale tylko z
cofnięcia, więc nie ma ścieżki od sieroty do usunięcia.

Pytanie otwarte z ADR 0025 ("obowiązująca polityka usuwania") jest zamknięte: blok zostaje
i jest raportowany. W widoku planu zapisu wpis `delete` jest czerwony zgodnie z
`docs/DESIGN.md`, a `restore-link` neutralny; kopia istnieje, więc operacja nie jest
zablokowana (ADR 0028).
