# ADR 0019: Historia na content store i logu operacji, Git jako warstwa opcjonalna

Status: zaakceptowane
Data: 2026-10-20

Nazwa produktu zmieniona przez ADR 0035: kopie zapasowe zapisują od v0.2.0 `format: 'cwm-backup'`; odczyt przyjmuje też `uasm-backup` w wersji 1, zapisany przez v0.1.0.

## Kontekst

Wymagania: przeglądanie historii zmian, porównywanie wersji, przywracanie poprzedniej wersji,
cofnięcie operacji synchronizacji, informacja kiedy i do jakiego narzędzia wyeksportowano
konfigurację. Plus wprost: "Najpierw prosty lokalny mechanizm historii. Integracja z Git jako
dodatkowa warstwa; aplikacja nie może wymagać ręcznej obsługi Git do podstawowych operacji".

## Rozważane opcje

**Git jako silnik historii.** Darmowe wersjonowanie, diffy i przywracanie. Przeciw: wymaga Gita
w systemie, repozytorium w katalogu danych, i rodzi pytania, na które użytkownik nie chce
odpowiadać (konflikt merge w katalogu, który sam nie otwiera). Cofnięcie operacji synchronizacji
dotyczy plików **poza** tym repozytorium (konfiguracji narzędzi), więc Git tego i tak nie
rozwiązuje.

**Event Sourcing z pełnym strumieniem zdarzeń.** Daje historię z definicji, ale to duża
złożoność w zamian za funkcję, która sprowadza się do "pokaż poprzednie wersje i przywróć".

**Content-addressed store plus log operacji.**

## Decyzja

Dwie struktury:

1. **`objects/<aa>/<sha256>`** - content-addressed store. Każda wersja treści jest zapisana raz,
   pod hashem. Deduplikacja jest darmowa, porównanie dwóch wersji to porównanie dwóch obiektów,
   przywrócenie to zapis obiektu z powrotem.
2. **Log operacji w `index.sqlite`** - każda operacja (import, eksport, synchronizacja, edycja,
   usunięcie) ma wpis z czasem, zakresem, celem, listą plików przed i po (jako hashe) oraz
   wynikiem. To odpowiada na "kiedy i do jakiego narzędzia wyeksportowano", a jednocześnie jest
   podstawą cofania.

Rollback synchronizacji: odczyt wpisu operacji, pobranie stanu sprzed z content store, zapis
przez `WriteGate` (ADR 0012). Rollback jest zwykłą operacją zapisu, z własnym backupem i wpisem
w logu, więc cofnięcie cofnięcia też działa.

Backup katalogowy w `backups/<timestamp>/` z plikiem MANIFEST zostaje obok content store jako
forma czytelna bez aplikacji. To port rozwiązania z generatora i jego wartość jest w tym, że
użytkownik może odzyskać pliki ręcznie, gdyby aplikacja odmówiła uruchomienia.

Git jest w backlogu po MVP jako warstwa dodatkowa: opcjonalne commitowanie katalogu `library/`,
nigdy jako wymaganie do podstawowych operacji.

## Konsekwencje

Content store rośnie. Pytanie o retencję zostało rozstrzygnięte przed Etapem 2, bo dotyczyło
modelu danych, a nie widoku historii: store trzyma pełne treści z deduplikacją, a limit
i czyszczenie są świadomie odroczone (ADR 0027).

Historia w MVP istnieje jako warstwa danych bez interfejsu: Etap 5 potrzebuje backupu,
weryfikacji i cofania, więc struktura powstaje wcześnie. Etap 7 dodaje do niej widok. To jest
celowa kolejność, bo odwrotna oznaczałaby dorabianie historii pod istniejący już mechanizm zapisu.

`objects/` i `library/snapshots/` pełnią różne role i nie wolno ich łączyć. Snapshot źródła
odtwarza oryginał bajt w bajt dla potrzeb normalizacji. Content store trzyma wersje elementów
biblioteki i stany celów dla potrzeb cofania.
