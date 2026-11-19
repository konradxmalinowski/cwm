# ADR 0063: natywne okno potwierdzenia operacji wysokiego ryzyka w main

Status: zaakceptowane
Data: 2026-11-19
Zamyka pozycję otwartą z: ADR 0056 (retencja), ADR 0060 (zgoda na elementy prywatne w Git), ADR 0061 i ADR 0062 (eksport serwerów MCP)
Dotyczy: ADR 0008 (granica IPC), ADR 0030 (blokada operacji), ARCHITECTURE 8.2 (main kontra renderer)

## Kontekst

Operacje, których skutku nie da się łatwo odwrócić albo które uruchamiają program, mają dziś potwierdzenie złożone z
dwóch części: pola w rendererze i jednorazowego znacznika wydawanego przez main (token podglądu retencji, znacznik zgody
wersjonowania, znacznik planu MCP). Main sprawdza znacznik, więc renderer nie wykona takiej operacji jednym wywołaniem
bez odczytu planu. Znacznik trafia jednak do renderera razem z planem, więc skompromitowany renderer (wstrzyknięcie w
treści importowanej, błąd w sanityzacji Markdownu) może przeczytać plan i od razu go potwierdzić. ADR 0060 i 0061
zapisały to wprost jako ograniczenie, a potwierdzenie natywnym oknem w main jako pozycję otwartą.

Inwentarz miejsc z jednorazowym znacznikiem albo jawną zgodą:

| Operacja | Kanał i znacznik | Skutek | Okno natywne |
|---|---|---|---|
| Zapis serwerów MCP | `export:apply` z `mcpConfirmation` (ADR 0061) | narzędzie uruchomi polecenie przy starcie albo wyśle nagłówki pod adres; cofnięcie z Historii zablokowane | tak |
| Serwer globalny do projektu | `mcpGlobalToProject` w tym samym wywołaniu | jak wyżej, plik w repozytorium projektu | tak, w tym samym oknie |
| Czyszczenie historii | `retention:apply` z tokenem podglądu (ADR 0056) | trwałe usunięcie wpisów historii i obiektów | tak |
| Włączenie albo zaostrzenie limitu retencji | `retention:set` z `confirmed: true` | przebieg przy następnym starcie usuwa bez pytania | tak |
| Elementy prywatne w historii Git | `versioning:set` z `acknowledged` i znacznikiem (ADR 0060) | treść zostaje w historii, której aplikacja nie przepisuje | tak |
| Odbudowa indeksu | `diagnostics:rebuild-index-apply` z `confirmed` (ADR 0030) | stary plik idzie do kwarantanny, nic nie jest usuwane | nie |
| Usunięcie elementu, import, eksport bez MCP, synchronizacja, cofnięcie | plan z `planId` | kopia w content store albo kopia zapasowa pliku i cofnięcie z Historii | nie |
| Archiwum ZIP | `export:zip-save`, ścieżka z systemowego okna zapisu (ADR 0054) | plik poza aplikacją; okno zapisu jest już gestem w main | nie |

## Rozważane opcje

**Zostawić znaczniki.** Odrzucone: chronią przed pomyłką i przed zapisem jednym wywołaniem, nie przed przejętym
rendererem, a to jest główny model zagrożenia aplikacji, która trzyma treść z niezaufanych źródeł.

**Własne okno potwierdzenia (drugi `BrowserWindow`) z treścią z main.** Odrzucone: to nadal renderer z HTML, wymaga
osobnego preloadu i kanału odpowiedzi, a dostępność trzeba by budować od nowa. Okno systemowe ma ją za darmo.

**Okno natywne dla wszystkich operacji zapisu.** Odrzucone: operacje z kopią zapasową i cofnięciem w Historii są
odwracalne, a drugie okno po każdym eksporcie uczy klikania bez czytania, co osłabia okno tam, gdzie jest potrzebne.

**Okno natywne (`dialog.showMessageBox`) dla operacji z inwentarza oznaczonych "tak", z treścią z danych main.** Wybrane.

## Decyzja

1. **Port w main.** `ConfirmPort` (`src/main/services/native-confirm.ts`) z jedną metodą `confirm(request)`, gdzie
   `request` to pytanie, szczegóły i czasownik przycisku zgody. Implementacja Electron
   (`src/main/bootstrap/native-confirm.ts`) pokazuje `dialog.showMessageBox` typu `warning`, modalne do okna aplikacji,
   z przyciskami "Anuluj" i czasownikiem, `defaultId` i `cancelId` na "Anuluj", `noLink`. Esc i zamknięcie okna to
   odmowa, błąd okna też. Okna idą jedno po drugim w kolejce. Usługi (`RetentionRunner`, `LibraryGitRunner`, handler
   eksportu) dostają port jako wymaganą zależność, bez wartości domyślnej.
2. **Kolejność: znacznik, potem okno.** Pole w rendererze i znacznik zostają jako pierwszy krok: bez ważnego znacznika
   main odmawia jak dotąd i okno się nie pokazuje, więc renderer nie wywoła okna bez planu. Okno jest drugim,
   autorytatywnym krokiem; zgoda w nim jest warunkiem wykonania niezależnie od pól w ładunku.
3. **Treść z danych main.** Treść okna nie zawiera żadnego pola z ładunku renderera:
   - MCP: przy wydaniu znacznika w `export:plan` main zapamiętuje obok niego listę serwerów z raportu planu, narzędzie i
     nazwę projektu (`McpConfirmations.issue`). `take` zwraca tę listę tylko dla ważnego znacznika. Okno: "Zapisać N
     serwerów MCP do <narzędzie>[, projekt <nazwa>]?", zdanie o tym, co robią serwery stdio i http, i po linii na serwer
     (nazwa, transport, polecenie albo adres w całości), nagłówki jako nazwa i zmienna, zdania o hostach z ADR 0062,
     nazwy zmiennych i znak, że serwer globalny trafi do projektu. Przycisk "Zapisz serwery MCP".
   - Czyszczenie: liczby wpisów, obiektów i bajtów z podglądu zapisane w main przy wydaniu tokenu. "Usunąć trwale N
     wpisów historii i M obiektów?", przycisk "Usuń wpisy historii".
   - Zaostrzenie limitu: obecne limity z pliku ustawień i nowe po walidacji w main, tylko zmienione, w postaci
     "stare -> nowe". Przycisk "Zapisz limity".
   - Zgoda Git: liczba elementów wykluczonych dziś wyłącznie jako prywatne albo projektowe, z nowego skanu biblioteki w
     main (`LibraryGit.status(false, true)`), nie z odczytu stanu w rendererze. Przycisk "Dołącz do historii". Okno
     pokazuje się po sprawdzeniu dostępności `git`, więc brak `git` daje najpierw powód.
4. **Redakcja i limity.** Każda linia przechodzi zamianę znaków sterujących, separatorów linii, znaków niewidocznych i
   znaków kierunku tekstu na spację (nazwa ani polecenie nie złamie układu okna i nie odwróci tekstu), potem
   `redactSecrets`. Ścieżek okno nie redaguje: polecenie serwera stdio ma być widoczne w całości, tak jak w planie.
   Linia ma najwyżej 300 znaków, dłuższa kończy się "... (i N znaków więcej)". Lista serwerów ma najwyżej 24 linie;
   pierwszy serwer jest zawsze, kolejne tylko w całości, a reszta to "i N serwerów więcej".
5. **Anulowanie.** Znacznik, token i znacznik zgody są zużyte także po anulowaniu, tak jak po każdej innej próbie.
   Nic nie jest zapisane ani usunięte, a odpowiedź to `confirmation-cancelled` z komunikatem. Plan MCP zostaje w
   serwisie do wygaśnięcia, ale bez znacznika jego zapis kończy się `mcp-confirmation-required`, więc ponowienie wymaga
   nowego planu; podgląd retencji wymaga nowego podglądu; zgoda Git nowego odczytu stanu (renderer pobiera go sam po
   błędzie). Wybrane, bo nie ma stanu, w którym raz pokazane i odrzucone potwierdzenie da się przyjąć później bez
   ponownego przejścia przez plan.
6. **Blokady.** Okno retencji pokazuje się przed wejściem w blokadę wyłączną, a wykonanie i tak przelicza plan z sufitem
   z podglądu (`plan-changed`), więc zmiana stanu w trakcie decyzji nie usunie więcej, niż pokazało okno. Okno zgody Git
   pokazuje się przed kolejką synchronizacji. Okno MCP pokazuje się w handlerze `export:apply`, który trzyma wspólną
   blokadę zapisu: inne zapisy przechodzą, a odbudowa indeksu i czyszczenie odpowiadają `busy`, dopóki okno jest otwarte.
7. **Testowalność bez furtki w produkcji.** Zmienna środowiskowa `CWM_TEST_CONFIRM` (`accept` albo `cancel`) zastępuje
   okno stałą odpowiedzią, wyłącznie gdy `app.isPackaged === false`. Zapakowana aplikacja ignoruje zmienną i zawsze
   pokazuje okno. Zmienną czyta main przy starcie z `process.env`; renderer działa w sandboksie bez dostępu do
   środowiska i nie ma kanału, który by ją ustawił albo zmienił. Użycie odpowiedzi testowej zostawia ostrzeżenie w logu
   aplikacji. Harness E2E (`tests/e2e/launch.ts`) ustawia `accept` przy każdym uruchomieniu, bo okno systemowe
   zawiesiłoby przebieg bez ekranu. Testy jednostkowe wstrzykują atrapę portu bezpośrednio.
8. **Dostępność.** Okno systemowe jest obsługiwane przez czytniki ekranu i klawiaturę bez pracy po stronie aplikacji.
   Pytanie ma jedno zdanie, przycisk zgody to konkretny czasownik, a domyślny przycisk to "Anuluj".

## Konsekwencje

Skompromitowany renderer nie zapisze serwera MCP, nie usunie historii, nie zaostrzy limitu i nie włączy elementów
prywatnych do Gita bez kliknięcia użytkownika w oknie, którego treści nie kontroluje. Pole w rendererze zostaje, więc
spis kontrolek E2E i komunikaty przy polach się nie zmieniają.

Koszty, na które się godzimy:

- Jedno kliknięcie więcej dla każdej z pięciu operacji. "Zapisz i wyczyść teraz" z zaostrzonym limitem pokazuje dwa
  okna po sobie: zapis limitu (skutek przy następnym starcie) i czyszczenie teraz, bo to dwie różne decyzje.
- Przejęty renderer może wywoływać okna wielokrotnie (każde wymaga nowego planu albo podglądu). To uciążliwość, nie
  obejście: bez kliknięcia nic się nie dzieje.
- Okno MCP trzyma wspólną blokadę zapisu, więc odbudowa indeksu i czyszczenie czekają na decyzję.
- **Ryzyko szczątkowe odpowiedzi testowej:** aplikacja uruchomiona z kodu źródłowego (`electron .`, `npm run dev`) z
  ustawionym `CWM_TEST_CONFIRM=accept` przyjmuje potwierdzenia bez okna. Ustawić zmienną dla procesu main może tylko
  ktoś, kto już uruchamia programy jako użytkownik, więc granica się nie przesuwa; ostrzeżenie w logu pokazuje, że tryb
  był aktywny. Wydania są zawsze zapakowane (`app.isPackaged === true`), a zamiana paczki na wersję niezapakowaną
  wymaga zmiany plików aplikacji na dysku.
- Okno nie zastępuje oceny użytkownika: polecenie i adres są pokazane w całości, ale to on decyduje, czy im ufa.

## Otwarte (poza tym zakresem)

- Eksport hooków do narzędzi (klucz `hooks`) też uruchamia polecenia, ale ma kopię zapasową i cofnięcie z Historii;
  okno natywne dla hooków wymaga osobnej decyzji.
- Zgoda na elementy prywatne i z sekretem w archiwum ZIP (`confirmedItemIds`) jest dziś tylko w rendererze; okno zapisu
  wybiera ścieżkę w main, ale nie wymienia tych elementów.
- Synchronizacja MCP z potwierdzeniem per serwer (ADR 0061) przejmie ten sam port.
