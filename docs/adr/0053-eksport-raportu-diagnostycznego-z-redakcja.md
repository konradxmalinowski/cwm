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
   katalogu, nigdy ścieżkę. Powtórne otwarcie okna w ciągu 1,5 s dostaje ten sam podgląd, a równoległe wywołania dzielą
   jeden odczyt.
2. **Ścieżkę wybiera main systemowym oknem zapisu**, z filtrami `.md` i `.txt` (inne rozszerzenie dostaje `.md`). Zapis idzie
   prymitywem atomowym (`writeFileAtomic`, ADR 0012 kroki 3 i 4), nowy plik ma tryb 0600, istniejący zachowuje swój. Gdy
   okno zapisu zwróciło nazwę bez `.md` i `.txt`, a plik z dopisanym `.md` już istnieje, zapis jest odrzucony
   (`target-exists`), bo system nie pytał o jego nadpisanie. Raport nie zapisuje się w katalogach konfiguracji narzędzi,
   w `~/.agents`, `~/.cwm`, w katalogu danych aplikacji ani w katalogach z `CLAUDE_CONFIG_DIR` i `CODEX_HOME`
   (`forbidden-location`); sprawdzane są ścieżka i jej postać po `realpath` katalogu nadrzędnego. Zapis nie
   jest kanałem zapisującym w sensie `WRITE_CHANNELS`: nie dotyka biblioteki ani indeksu, więc nie czeka na blokadę
   odbudowy. Aplikacja niczego nie wysyła przez sieć; blokada sieci wychodzącej zostaje bez zmian.
3. **Redakcja jest czystą funkcją w `core`** (`createReportRedactor`), a `redactHomeInText` z `infra/logging/redact.ts`
   wchodzi jako wstrzyknięta funkcja, bo `core` nie importuje `infra`. Jedna instancja redaguje cały tekst raportu
   (poza nagłówkiem z listą reguł), więc nowa sekcja nie może jej ominąć. Zasada: gdy nie wiadomo, redaguj. Kolejność
   reguł jest częścią kontraktu:
   1. katalog domowy na `~` (`redactHomeInText`): zapis z `/`, `\`, podwojonym `\\` (JSON) i zakodowany procentowo;
      po nazwie konta musi być granica (`/Users/janusz` to nie `/Users/jan`), przed nią nie może stać litera, cyfra ani
      kropka; na Windowsie i macOS bez rozróżniania wielkości liter;
   2. adres URL w całości: autorytet (dane logowania, host, port) na `<host>`, każdy segment ścieżki według reguły
      segmentów (punkt 9), zapytanie na `?<query>`, fragment na `#<fragment>`; `file:` jest ścieżką; `app://bundle` zostaje;
   3. zdalny adres scp (`git@host:org/repo.git`) w całości na `<host>`;
   4. adresy e-mail na `<email>`;
   5. nazwy elementów biblioteki (slug, tytuł, nazwa zadeklarowana, aliasy; od 4 znaków) na `<skill-1>`, `<agent-2>` i tak
      dalej: jeden znacznik na element, numer rośnie per rodzaj w kolejności listy, więc jest stabilny w obrębie
      raportu. Granicą słowa są tylko litery, cyfry, `<` i `>`, więc `acme-deploy-v2` daje `<skill-1>-v2`, a nazwa równa
      nazwie znanego katalogu (`skills`) też jest ukrywana. Najdłuższe nazwy najpierw. Powyżej 5000 nazw lista jest
      obcinana, a raport mówi o tym ostrzeżeniem na początku;
   6. nazwa konta systemowego na `<user>` (od 3 znaków, bez rozróżniania wielkości liter);
   7. sekrety tym samym klasyfikatorem co logger (`redactSecrets`): znane formaty kluczy, nazwa klucza, ciągi o wysokiej
      entropii, bloki kluczy prywatnych;
   8. adresy sieciowe poza URL: IPv6 (w nawiasach, pełny i skrócony zapis) i IPv4 z portem na `<ip>`; nazwy domenowe z
      końcówką z listy (`com`, `org`, `dev`, `internal`, `corp`, `local`, `test` i podobne) oraz `host:port` na `<host>`.
      Liczba wyglądająca jak adres IPv4 po słowie `Chrome`, `Chromium`, `Electron`, `Node`, `version` albo `wersja` to
      wersja i zostaje;
   9. ścieżki z początkiem (`~/`, `/`, `C:\`, także tuż po dwukropku): każdy segment spoza listy znanych nazw
      (`KNOWN_SEGMENTS`: katalogi konfiguracji narzędzi, `Library`, `AppData`, `skills`, `index.db`, `app.log` i podobne)
      na `<path-N>`; segment może zawierać spacje, jeśli po nim idzie separator; znacznik z wcześniejszych reguł jest
      znanym segmentem, więc ścieżka po `<user>` redaguje się dalej;
   10. ścieżki względne z separatorem, gdy mają co najmniej dwa separatory, rozszerzenie z literą albo zaczynają się od
      kropki (`projects/x/src/a.ts`, `../../klient/x`); `TCP/IP` i `3/4` zostają.
   Lista kategorii jest wypisana na początku raportu, razem z zastrzeżeniem, że redakcja jest automatyczna i nie daje
   gwarancji.
4. **Zawartość raportu:** wersje aplikacji, Electrona, Chromium i Node; system i architektura; stan startu indeksu, baza i
   migracja danych (wyniki tego samego raportu co ekran Diagnostyka, zbudowanego tą samą funkcją
   `diagnosticsSnapshot`); liczby elementów per rodzaj bez nazw; wykryte lokalizacje narzędzi (rodzaj, czy są, czy
   narzędzie je czyta); ostatnie 200 linii logu (z bieżącego pliku, a gdy brakuje, dopełnione z `app.log.1`; linia
   redagowane jako jeden tekst, dopiero potem skracane do 600 znaków, żeby cięcie nie zostawiło początku sekretu; logger już zredagował je raz, raport robi to ponownie; plik jest czytany tylko jako zwykły plik, ostatnie 256 KiB). Brak biblioteki albo nieudane
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
- Pola spoza bloku logu (powód i komunikat indeksu, komunikat migracji, etykiety narzędzi) są w znacznikach kodu: raport
  trafia do publicznego zgłoszenia jako Markdown i bez tego `@nazwa`, `#123` czy odnośnik tworzyłyby wzmianki i linki.
- Pozostałe ryzyko redakcji: nazwa domenowa z końcówką spoza listy, adres w niestandardowym zapisie (liczbowym,
  szesnastkowym), nazwa elementu krótsza niż 4 znaki, nazwa konta krótsza niż 3 znaki, ścieżka względna z jednym
  separatorem i bez rozszerzenia (`klient/x`), sama nazwa pliku bez katalogu, dane osobowe w treści komunikatu, których
  żadna reguła nie rozpoznaje. W drugą stronę reguły potrafią zredagować niewinny tekst (nazwa pliku zgodna z końcówką
  domeny, `a/b.c`). Redakcja jest automatyczna, więc nagłówek raportu każe go przeczytać przed wysłaniem.
- Nie ma zapisu do schowka ani otwarcia strony zgłoszenia: oba wymagałyby nowego kanału, a ręczne dołączenie pliku
  działa bez nich.
- Szablon `.github/ISSUE_TEMPLATE/bug_report.yml` ma pole na raport i instrukcję, skąd go wziąć.
