# ADR 0053: eksport raportu diagnostycznego z redakcją

Status: zaakceptowane w zakresie planu (2026-11-16)
Data: 2026-11-16
Dotyczy: ADR 0004 (higiena publicznego repozytorium, backlog "raport z wyredagowanymi ścieżkami"), ADR 0008 (granica IPC), ADR 0012 (zapis przez bramkę), ADR 0030 (widok Diagnostyka)
Źródło: plan `plans/2026-11-16-diagnostic-report.md` (lokalny, poza repozytorium); kod w `src/core/services/diagnostics/`, `src/main/services/diagnostic-report.ts`, `src/main/bootstrap/diagnostic-report.ts`, `src/infra/logging/read-tail.ts`, `src/renderer/app/features/diagnostics/report-dialog.component.*`

## Kontekst

ADR 0004 zapowiedział, że zgłoszenie błędu z prawdziwej konfiguracji wymaga redakcji, i obiecał raport, który robi to
za użytkownika. Do tej pory szablon zgłoszenia prosił o "raport z usuniętymi prywatnymi ścieżkami i nazwami", czyli o
ręczną anonimizację, którą łatwo zrobić połowicznie. Repozytorium jest publiczne, więc pomyłka jest widoczna dla
wszystkich.

## Decyzje

1. **Raport składa i redaguje main, renderer go tylko pokazuje i zleca zapis.** Dwa nowe kanały (`diagnostics:report-preview`,
   `diagnostics:report-save`) trzymają się czterech reguł granicy IPC. Podgląd nie przyjmuje niczego. Zapis przyjmuje
   wyłącznie `previewId` (`^[A-Za-z0-9-]{1,64}$`); parser buduje wynik z jednego pola, więc `text`, `path` czy `fileName`
   z renderera przepadają. Treść do pliku to ta, którą main zapamiętał przy podglądzie (do 4 podglądów, 10 minut,
   jednorazowo po udanym zapisie), więc użytkownik zapisuje dokładnie to, co widział. Odpowiedzi niosą nazwę pliku bez
   katalogu, nigdy ścieżkę.
2. **Ścieżkę wybiera main systemowym oknem zapisu**, z filtrami `.md` i `.txt` (inne rozszerzenie dostaje `.md`). Zapis idzie
   prymitywem atomowym (`writeFileAtomic`, ADR 0012 kroki 3 i 4), tryb 0644, bo plik ma być udostępniany. Raport nie
   zapisuje się w `~/.claude`, `~/.codex`, `~/.cwm` ani w katalogu danych aplikacji (`forbidden-location`). Zapis nie
   jest kanałem zapisującym w sensie `WRITE_CHANNELS`: nie dotyka biblioteki ani indeksu, więc nie czeka na blokadę
   odbudowy. Aplikacja niczego nie wysyła przez sieć; blokada sieci wychodzącej zostaje bez zmian.
3. **Redakcja jest czystą funkcją w `core`** (`createReportRedactor`), a `redactHomeInText` z `infra/logging/redact.ts`
   wchodzi jako wstrzyknięta funkcja, bo `core` nie importuje `infra`. Jedna instancja redaguje cały tekst raportu
   (poza nagłówkiem z listą reguł), więc nowa sekcja nie może jej ominąć. Kolejność reguł jest częścią kontraktu:
   1. katalog domowy na `~`;
   2. adres URL: autorytet (dane logowania, host, port) na `<host>`, ścieżka zostaje; `app://bundle` zostaje;
   3. adresy e-mail na `<email>` (przed nazwą konta, żeby ta nie zjadła domeny);
   4. nazwa konta systemowego na `<user>` (od 3 znaków, bez rozróżniania wielkości liter);
   5. nazwy elementów biblioteki (slug, tytuł, nazwa zadeklarowana, aliasy; od 4 znaków, nie nazwa znanego katalogu) na
      `<skill-1>`, `<agent-2>` i tak dalej: jeden znacznik na element, numer rośnie per rodzaj w kolejności listy, więc
      jest stabilny w obrębie raportu. Dopasowanie tylko całych słów (granicą są litery, cyfry, `_`, `-`, `<`, `>`), najdłuższe
      nazwy najpierw;
   6. sekrety tym samym klasyfikatorem co logger (`redactSecrets`): znane formaty kluczy, nazwa klucza, ciągi o wysokiej
      entropii, bloki kluczy prywatnych;
   7. segmenty ścieżek spoza listy znanych nazw (`.claude`, `.codex`, `Library`, `AppData`, `skills`, `index.db`, `app.log`
      i podobne) na `<path-N>`: tak znikają nazwy projektów i katalogów klientów. Lista jest krótka i jawna
      (`KNOWN_SEGMENTS`), a błąd idzie w stronę nadmiarowej redakcji.
   Lista kategorii jest wypisana na początku raportu, razem z zastrzeżeniem, że redakcja jest automatyczna i nie daje
   gwarancji.
4. **Zawartość raportu:** wersje aplikacji, Electrona, Chromium i Node; system i architektura; stan startu indeksu, baza i
   migracja danych (wyniki tego samego raportu co ekran Diagnostyka, zbudowanego tą samą funkcją
   `diagnosticsSnapshot`); liczby elementów per rodzaj bez nazw; wykryte lokalizacje narzędzi (rodzaj, czy są, czy
   narzędzie je czyta); ostatnie 200 linii logu (z bieżącego pliku, a gdy brakuje, dopełnione z `app.log.1`; linia
   skrócona do 600 znaków; logger już zredagował je raz, raport robi to ponownie). Brak biblioteki albo nieudane
   wykrywanie lokalizacji raport zapisuje wprost, zamiast pominąć sekcję.
5. **Ustawienia aplikacji:** ta wersja nie ma trwałych ustawień (kanały `settings:*` zostały usunięte, ADR 0008 w Etapie 10),
   więc sekcja mówi to jednym zdaniem. Gdy ustawienia wrócą, trafią do raportu przez ten sam redaktor.
6. **Interfejs:** sekcja "Raport do zgłoszenia błędu" na ekranie Diagnostyka, przycisk "Eksportuj raport" i skrót `e`
   (jak `/` w bibliotece: bez modyfikatorów, poza polami tekstowymi i oknami). Okno dialogowe w trzech stanach (zbieranie,
   błąd z ponowieniem, podgląd z zapisem), potem potwierdzenie zapisu. Podgląd to przewijany region z fokusem
   klawiatury; Escape zamyka okno i oddaje fokus temu, kto je otworzył. Anulowanie okna systemowego wraca do podglądu
   z informacją, że nic nie zapisano.

## Konsekwencje

- Lista `KNOWN_SEGMENTS` i minimalne długości nazw (4 i 3 znaki) to kompromis: krótsza nazwa elementu (na przykład `qa`)
  nie jest redagowana jako nazwa, bo zjadałaby zwykłe słowa. Taki element widać tylko jako liczbę w sekcji biblioteki,
  ale jego slug może pojawić się w logu. Użytkownik ma podgląd właśnie po to.
- Adresy IPv4 nie mają własnej reguły: numer wersji (`140.0.0.0`) wygląda jak adres, a raport musi go zachować. Adres w URL
  jest redagowany jako host.
- Nie ma zapisu do schowka ani otwarcia strony zgłoszenia: oba wymagałyby nowego kanału, a ręczne dołączenie pliku
  działa bez nich.
- Szablon `.github/ISSUE_TEMPLATE/bug_report.yml` ma pole na raport i instrukcję, skąd go wziąć.
