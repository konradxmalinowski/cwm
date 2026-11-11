# ADR 0027: Historia trzyma pełne treści w content store z deduplikacją

Status: zaakceptowane (odpowiedź właściciela produktu na pytanie 7 z Etapu 0, 2026-10-20)
Data: 2026-10-20

Nazwa produktu zmieniona przez ADR 0035: kopie zapasowe zapisują od v0.2.0 `format: 'cwm-backup'`; odczyt przyjmuje też `uasm-backup` w wersji 1, zapisany przez v0.1.0.

## Kontekst

Wymagania: przeglądanie historii zmian, porównywanie wersji, przywracanie poprzedniej wersji,
cofnięcie operacji synchronizacji. Struktura danych pod to powstaje w Etapie 2, a interfejs
w Etapie 7 (ADR 0019), więc decyzja o tym, co historia przechowuje, była potrzebna wcześnie.

## Rozważane opcje

**Łańcuch różnic z limitem retencji.** Oszczędza miejsce. Przeciw: przywrócenie wersji wymaga
rekonstrukcji z łańcucha, czyli operacji, która może zawieść, i przestaje być możliwe po
przekroczeniu limitu. Wymóg "przywróć dowolną poprzednią wersję" staje się wtedy warunkowy,
a użytkownik dowiaduje się o warunku w momencie, w którym chce odzyskać dane.

**Pełne treści w content store adresowanym hashem, z deduplikacją.**

## Decyzja

Pełne treści. Każda wersja jest zapisana w `objects/<aa>/<sha256>` i adresowana hashem, więc
identyczna treść jest zapisana raz niezależnie od tego, w ilu wersjach i operacjach występuje.

Uzasadnienie rozmiaru: elementy to pliki tekstowe rzędu kilku kilobajtów, a deduplikacja usuwa
najczęstszy przypadek, czyli wersję różniącą się jedną linią od poprzedniej po stronie plików,
których ta zmiana nie dotyczy. Koszt jest znikomy wobec tego, co kupuje: przywrócenie dowolnej
wersji jest zapisem jednego obiektu, bez rekonstrukcji, i działa zawsze.

**Limit rozmiaru i czyszczenie są świadomie odroczone, nie przeoczone.** Decyzja o nich nie
zmieni modelu danych, tylko doda politykę nad istniejącym store'em: wybór, które obiekty wolno
usunąć, i kiedy. Dlatego nie blokuje Etapu 2 i nie musi być podjęta teraz. Pozycja jest w backlogu
po MVP.

## Konsekwencje

Content store rośnie monotonicznie w MVP. Settings pokazuje jego rozmiar, żeby wzrost był widoczny,
a nie odkrywany przy braku miejsca na dysku. To jedyny obowiązek, jaki ta decyzja nakłada
na MVP poza samym store'em.

Diff między dowolnymi dwiema wersjami jest porównaniem dwóch obiektów, bez przechodzenia historii.
To upraszcza moduł Diff and merge (Etap 6) i sprawia, że jego koszt nie rośnie z długością historii.

`objects/` i `library/items/<id>/snapshots/` zostają osobne, zgodnie z ADR 0019. Snapshot źródła
odtwarza oryginał bajt w bajt dla potrzeb normalizacji; content store trzyma wersje elementów
biblioteki i stany celów dla potrzeb cofania. Oba używają hashowania, ale hashują różne rzeczy
(snapshot bajty źródła, store treść znormalizowaną, ADR 0016) i łączenie ich dałoby nazwę,
która znaczy dwie rzeczy naraz.

Przyszła polityka czyszczenia musi uwzględnić, że obiekt może być referowany jednocześnie przez
wersję elementu i przez wpis operacji. Usuwanie wymaga więc liczenia referencji, nie wieku
obiektu. To jest jedyna rzecz, którą trzeba zapamiętać teraz, żeby odroczenie było tanie.
