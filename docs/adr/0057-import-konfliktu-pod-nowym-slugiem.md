# ADR 0057: kandydat z konfliktem nazwy wchodzi pod nowym slugiem

Status: zaakceptowane
Data: 2026-11-17
Dotyczy: ADR 0017 (kolizje wielkości liter), ADR 0026 (slug kontra `declaredName`), ADR 0019 (historia), ADR 0030 (blokada zapisu)

## Kontekst

ADR 0017 rozstrzyga kolizję `lower(slug)` plus typ przy zapisie do biblioteki i przy imporcie
masowym wskazuje drogę: element kolidujący jest raportowany jako wymagający rozstrzygnięcia,
a nie importowany z cichym sufiksem. W praktyce rozstrzygnięcie sprowadzało się do jednego:
pomiń i zmień nazwę w źródle. Źródłem jest konfiguracja narzędzia, której import nigdy nie
modyfikuje, więc użytkownik, który chciał mieć element w bibliotece, nie miał jak go przyjąć.
Znane ograniczenie, wpisane w `docs/ROADMAP.md`.

## Rozważane opcje

**Automatyczny sufiks przy imporcie.** Odrzucone w ADR 0017 i nadal odrzucone: to cicha zmiana
nazwy elementu.

**Zmiana nazwy w źródle.** Wymaga edycji konfiguracji narzędzia, której import nie rusza.

**Nowy slug podany przez użytkownika w kreatorze.** Zmiana nazwy jest jawna, widoczna przed
zapisem i zawsze wynika z decyzji użytkownika.

## Decyzja

Kandydat ze statusem `conflict` można zaznaczyć w kreatorze i zaimportować pod nowym slugiem.

1. **Kreator.** Przy konflikcie pojawia się pole "Nowa nazwa (slug)" z podpowiedzią (`slug-2`,
   `slug-3`, pierwsza wolna). Podpowiedź jest tylko wartością pola: do biblioteki nic nie trafia,
   dopóki użytkownik nie zaznaczy elementu. Pole jest walidowane na bieżąco tymi samymi regułami
   co `validate.ts` (ASCII, długość, nazwy zastrzeżone Windowsa) oraz brakiem kolizji z biblioteką
   i z innymi elementami tej partii. Import z błędnym polem się nie rozpoczyna.
2. **IPC.** `import:apply` przyjmuje `renames`: mapę `candidateId` na slug. Klucze muszą należeć
   do `candidateIds`, a wartości mają limit długości; resztę sprawdza serwis. `import:scan` zwraca
   `librarySlugs`, czyli zajęte nazwy z chwili skanu, tylko do podpowiedzi i walidacji na żywo.
3. **Main nie ufa rendererowi.** `ImportService.apply` waliduje każdy nowy slug od nowa
   (`validateSlug`, kolizja z biblioteką czytaną w chwili zapisu i z innymi kandydatami partii).
   Kandydat zapisywany pod własną nazwą ma pierwszeństwo przed kandydatem przemianowanym,
   niezależnie od kolejności w żądaniu. Błędna nazwa daje `failed` z kodem (`slug-invalid`,
   `slug-reserved`, `slug-collision`) i nie zużywa kandydata. `rename` dla kandydata, który nie
   jest konfliktem, daje pominięcie `rename-not-allowed`. Kanał `import:apply` działa pod
   wspólną blokadą zapisu (ADR 0030), a ostatnie słowo ma kolejka `LibraryService` z własnym
   sprawdzeniem kolizji tuż przed zapisem, więc wyścig z innym zapisem kończy się błędem, nie
   nadpisaniem.
4. **Tożsamość.** Nazwa ze źródła trafia do `identity.aliases`, a `declaredName` zostaje bez
   zmian (ADR 0026), więc rozjechanie sluga i `declaredName` pokazuje się zwykłym ostrzeżeniem.
5. **Historia.** Wpis `create` niesie notatkę `slug-z=<nazwa ze źródła>`, a Historia pokazuje
   "Utworzono element X (nazwa ze źródła: Y)".

## Konsekwencje

Użytkownik może przyjąć element, który wcześniej był tylko pomijany, a każda zmiana nazwy jest
jawna i udokumentowana w aliasach i w historii. Biblioteka nadal jest przenośna między systemami
plików, bo kolizja `lower(slug)` dalej blokuje zapis.

Ponowny skan po takim imporcie widzi ten sam konflikt, bo źródło się nie zmieniło. Aplikacja nie
rozpoznaje jeszcze, że element o tej treści już wszedł pod inną nazwą (alias), więc ponowny import
pod kolejną nazwą utworzy drugi element. Zostaje do osobnej decyzji.
