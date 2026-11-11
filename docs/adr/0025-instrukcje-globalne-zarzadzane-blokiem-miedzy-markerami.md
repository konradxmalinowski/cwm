# ADR 0025: Instrukcje globalne zarządzane blokiem między markerami

Status: zaakceptowane (odpowiedź właściciela produktu na pytanie 2 z Etapu 0, 2026-10-20)
Data: 2026-10-20

Nazwa produktu zmieniona przez ADR 0035: marker zapisu to od v0.2.0 `<!-- cwm:start -->` i `<!-- cwm:end -->`; odczyt rozpoznaje też `ai-skills-manager:start` i `ai-skills-manager:end` z poniższego uzupełnienia. Zasada stabilnego markera z decyzji poniżej obowiązuje: stary marker nie przestaje być rozpoznawany.

> Uzupełnienie (2026-11-11):
>
> **Markery.** Faktyczne markery to `<!-- ai-skills-manager:start -->` i
> `<!-- ai-skills-manager:end -->` (`BLOCK_START` i `BLOCK_END` w
> `src/adapters/shared/marker-block.ts`), każdy sam w linii. Markery `antislop:*` z kontekstu
> powyżej są obce: aplikacja ich nie rusza i nie zapisuje swojego bloku w ich środku.
>
> **Rozstrzygnięcie reguły 3.** Import bierze cały plik jako treść elementu, więc po edycji
> elementu stara treść w pliku różni się od nowej i heurystyka "ta sama treść już jest w pliku"
> jej nie łapie. Rozpoznanie opiera się na snapshocie źródła: jeśli element ma snapshot z tego
> samego narzędzia i tego samego pliku, a plik (bez markerów aplikacji) zawiera tekst ze
> snapshotu (porównanie po normalizacji końców linii), to jest to treść zarządzana bez markerów.
> Plan nie dopisuje wtedy bloku po cichu. Ma konflikt (`PlanConflict`) z dwiema decyzjami,
> które użytkownik podaje w `resolutions` żądania `export:plan`:
> `replace-fragment` ("zamień ten fragment na blok aplikacji": fragment ze snapshotu zostaje
> zastąpiony blokiem z markerami i nową treścią, reszta pliku bajt w bajt) i `append-block`
> ("dopisz blok na końcu": dawne zachowanie, stary tekst zostaje w pliku). Zamiana jest oferowana
> tylko wtedy, gdy fragment występuje w pliku dokładnie raz. Bez decyzji plan nie jest
> wykonywalny. Przypadek bez snapshotu zostaje przy heurystyce i konflikcie bez decyzji
> (użytkownik oznacza treść markerami ręcznie).

## Kontekst

`~/.claude/CLAUDE.md` i `~/.codex/AGENTS.md` to pojedyncze pliki na narzędzie. Eksport instrukcji
globalnej nie jest więc kopiowaniem pliku, tylko wstawieniem treści do pliku, który użytkownik
pisze ręcznie i w którym ma własną treść.

Istnieje mocny precedens na tej samej maszynie: tak wczoraj zainstalowano antislop w obu plikach,
przez znaczniki `<!-- antislop:start -->` i `<!-- antislop:end -->`. Potwierdzone odczytem
2026-10-20: oba pliki mają marker otwierający w linii 1 i zamykający w linii 13 (`CLAUDE.md`)
oraz 14 (`AGENTS.md`).

Zysk z tego wzorca jest konkretny i nie teoretyczny: przyszła oficjalna instalacja tego samego
narzędzia **podmieni blok zamiast dodać drugi**, bo jej instalatory piszą te same znaczniki.
Bez markerów te same treści wylądowałyby w pliku dwa razy.

## Rozważane opcje

**Zarządzanie całym plikiem.** Proste w implementacji i nie do przyjęcia: pierwszy eksport
nadpisałby treść pisaną ręcznie przez użytkownika, czyli dokładnie to, przed czym ten produkt
ma go chronić (założenie 7 z wymagań).

**Scalanie semantyczne po nagłówkach Markdown.** Bez markerów trzeba zgadywać, które sekcje
są zarządzane. Zgadywanie w pliku, który narzędzie AI czyta jako instrukcję, oznacza ciche
zmiany zachowania narzędzia.

**Blok między własnymi markerami.**

## Decyzja

Aplikacja zarządza wyłącznie blokiem między własnymi markerami i nie dotyka reszty pliku.
Markery są komentarzami Markdown, więc są niewidoczne w renderowanej treści i obojętne dla
narzędzia, które plik czyta.

Cztery reguły zachowania:

1. **Blok istnieje** - jego treść jest podmieniana, reszta pliku zostaje bez zmian, razem
   z formatowaniem i pustymi liniami.
2. **Brak markerów w pliku** - blok jest **dopisywany na końcu**. Nigdy przepisanie pliku.
3. **Istnieje blok treści bez markerów** (użytkownik wklejał ręcznie to, co aplikacja chce teraz
   zarządzać) - wymaga decyzji użytkownika. Aplikacja pokazuje, co znalazła, i proponuje
   oznaczenie tego bloku markerami albo dopisanie nowego. Nie zgaduje.
4. **Plik nie istnieje** - jest tworzony z samym blokiem.

Markery są przestrzenią nazw aplikacji i są stabilne, bo ich zmiana oznaczałaby, że starszy blok
przestaje być rozpoznawany i powstaje duplikat. Aplikacja respektuje też markery obcych narzędzi
w tym sensie, że nigdy nie zapisuje swojego bloku w ich środku.

Reguła niesymetryczna, którą trzeba nazwać: usunięcie elementu z biblioteki usuwa blok wyłącznie
wtedy, gdy obowiązująca polityka usuwania na to pozwala (pytanie otwarte, blokuje Etap 5).
Domyślnie blok zostaje i jest raportowany jako sierota.

## Konsekwencje

Poziom zgodności dla typu `global-instruction` przestaje być zablokowany i staje się `partial`
z konkretnym powodem: zarządzany jest blok, nie plik, więc treść poza blokiem nie jest ani
eksportowana, ani kontrolowana. To jest uczciwy opis, a nie ograniczenie do obejścia.

Ryzyko R6 (scalanie instrukcji globalnych) spada z poziomu średniego, bo nadpisanie treści
użytkownika przestaje być możliwe: zapis dotyczy wyłącznie zakresu między markerami, a brak
markerów prowadzi do dopisania, nie przepisania.

Diff dla tego typu elementu porównuje wyłącznie zawartość bloku. Zmiana poza blokiem nie jest
dryfem i nie wywołuje synchronizacji.

Wzorzec jest ten sam, co w `SegmentTomlEditor` (ADR 0011): minimalizacja zakresu zarządzanego
jest podstawowym mechanizmem ochrony plików, których aplikacja nie jest autorem. Tu jest tańszy,
bo granica zakresu jest jawna w pliku, a nie wnioskowana z jego struktury.
