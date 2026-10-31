# ADR 0012: `WriteGate` jako jedyna droga zapisu

Status: zaakceptowane, zmienione przez ADR 0028, zakres doprecyzowany przez ADR 0031
Data: 2026-10-20

> Doprecyzowanie zakresu wprowadzone przez ADR 0031: plan i jawne zatwierdzenie dotyczą zapisu
> poza `userData`, czyli konfiguracji narzędzi. Zapis własnych danych aplikacji w
> `userData/library/` idzie przez zapis katalogiem roboczym z zamianą, na wspólnych z `WriteGate`
> elementach prymitywu zapisu atomowego, i z warunkiem kopii (ADR 0028, 0031),
> a plan i zatwierdzenie są wymagane tylko przy usunięciu elementu. Reszta tego rekordu obowiązuje
> bez zmian.

> Zmiana wprowadzona przez ADR 0028: krok 2 (kopia dotykanego stanu) nie jest krokiem, który
> może się nie udać, tylko **twardym warunkiem wstępnym**. Jeśli kopia nie jest możliwa, operacja
> nie jest wykonywana, a brak możliwości kopii jest wykrywany już na etapie `plan`, nie przy
> zapisie. Reszta tego rekordu obowiązuje bez zmian.

## Kontekst

Wymagania mówią: aplikacja nie może po cichu nadpisywać istniejących plików, musi zapobiegać
path traversal i zapisowi poza dozwolonym katalogiem, przed operacjami destrukcyjnymi wykonywać
backup, i zapewnić odtworzenie plików po nieudanej synchronizacji.

Każde z tych wymagań dotyczy zapisu. Jeśli zapis dzieje się w wielu miejscach, każde z nich musi
spełnić wszystkie cztery, a wystarczy jedno przeoczenie w nowym adapterze, żeby gwarancja
przestała obowiązywać.

## Rozważane opcje

**Adaptery piszą same, z wytycznymi w dokumentacji.** Elastyczne i kruche. Gwarancja zależy
od tego, czy autor adaptera przeczytał dokumentację.

**Jedna bramka, przez którą przechodzi każdy zapis.** Adapter nie dostaje `fs`, dostaje bramkę
jako parametr `apply` (ADR 0013).

## Decyzja

`WriteGate` jest jedynym sposobem zapisu w całej aplikacji. Adaptery nie importują `node:fs`.
Każdy zapis przechodzi sześć kroków:

1. **Kanonizacja ścieżki i kontrola prefiksu.** `realpath` katalogu nadrzędnego, sprawdzenie,
   czy wynik leży pod zadeklarowanym rootem celu. Na Windowsie dodatkowo odrzucenie ścieżek UNC
   i `\\?\`. Odrzucenie nazw zarezerwowanych Windowsa, nazw z NUL i znakami kontrolnymi, nazw
   kończących się kropką lub spacją.
2. **Backup dotykanego stanu** do content store, z wpisem w logu operacji.
3. **Zapis przez plik tymczasowy z pidem w nazwie i `rename`,** z jawnym przepisaniem trybu
   pliku. `rename` daje nowy inode, więc bez przepisania trybu plik z `0600` wraca na `0644`.
   W generatorze zdegradował się tak `config.toml`, który trzymał sekret. Pid w nazwie, żeby
   dwa procesy nie walczyły o ten sam plik tymczasowy.
4. **Sprzątanie pliku tymczasowego przy błędzie,** inaczej po przerwanym zapisie zostaje śmieć,
   którego nic nie widzi.
5. **Weryfikacja:** odczyt z powrotem i porównanie z planem.
6. **Rollback z content store** przy niepowodzeniu weryfikacji.

Dodatkowo: bramka odmawia zapisu bez planu i bez jawnego zatwierdzenia. Nie ma trybu "zapisz
to teraz".

## Konsekwencje

Cztery wymagania bezpieczeństwa są spełnione w jednym miejscu i testowane raz. Nowy adapter
dziedziczy je, bo nie ma innej drogi.

Koszt: adapter nie może zrobić nic nietypowego z systemem plików bez rozszerzenia bramki.
To jest zamierzone ograniczenie, nie niedogodność. Jeśli nowe narzędzie wymaga operacji,
której bramka nie zna (na przykład ustawienia atrybutu rozszerzonego), rozszerzenie bramki
jest świadomą zmianą z własnym testem, a nie szczegółem ukrytym w adapterze.

Kroki 3 i 4 to bezpośredni port rozwiązań z generatora. Każdy naprawia błąd, który tam
realnie wystąpił.
