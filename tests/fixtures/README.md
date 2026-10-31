# Fixture'y

Korpus parserow obu narzedzi powstaje w Etapie 3. Na razie jest tu jedno drzewo:

`library-linux/` - biblioteka (`library/` i `objects/`) dla kryterium 10 Etapu 2. Nie jest
pisana recznie: generuje ja `LibraryService` ze specyfikacji w
`tests/integration/library-fixture-spec.ts`, zeby hashe byly prawdziwe. Regeneracja po zmianie
formatu: `UASM_WRITE_FIXTURE=1 npx vitest run tests/integration/library-fixture.test.ts`.
Bajty sa chronione przez `tests/fixtures/** -text` w `.gitattributes`.

Jedna regula obowiazuje tu od pierwszego pliku (ADR 0004): **zaden fixture nie
pochodzi z prawdziwej konfiguracji**. Wszystkie drzewa testowe sa pisane od zera
jako syntetyczne, nazwy w stylu `acme-*`, tresci bez znaczenia, zero sciezek do
czyjegokolwiek katalogu domowego i zero prawdziwych tokenow. Repozytorium jest
publiczne, a historia gitowa pamieta wszystko - anonimizacja po fakcie wymaga
przepisania historii, wiec taniej jest nigdy nie wpuscic tu nic realnego.

Dotyczy to takze fixture'ow "przykladowych" i zrzutow dolaczanych do zgloszen
bledow. Lista przypadkow do pokrycia jest w ARCHITECTURE sekcja 12.3.
