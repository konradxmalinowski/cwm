# ADR 0061: reguły bezpieczeństwa i zakresów MCP, jawny eksport serwerów

Status: zaakceptowane
Data: 2026-11-19
Zastępuje częściowo: ADR 0020 (brak automatycznej synchronizacji MCP), w części o imporcie i eksporcie
Dotyczy: ADR 0011 (segmenty TOML), ADR 0012 (`WriteGate`), ADR 0025 (decyzje w konflikcie), ADR 0054 (eksport ZIP), ADR 0055 (Gemini CLI), ADR 0059 (projekty), ADR 0060 (jednorazowy znacznik zgody)

## Kontekst

ADR 0020 zablokował serwery MCP w całości: import tylko do podglądu (w praktyce nigdy nie powstał), eksport i
synchronizacja zablokowane, profile bez MCP. Odblokowanie wymagało reguł zakresów i sekretów, bo serwer MCP różni się od
skilla trzema rzeczami:

- **Uruchamia program albo łączy się z adresem.** Wpis w `mcpServers` to polecenie wykonywane przy starcie sesji narzędzia.
- **Niesie dane logowania.** `env` i nagłówki HTTP mają tokeny wpisane wprost albo odniesienia do zmiennych.
- **Ma zakres.** Claude Code ma serwery użytkownika (`mcpServers` w `~/.claude.json`) i projektu (`.mcp.json`). Codex ma
  serwery wyłącznie globalnie (`[mcp_servers.<nazwa>]` w `config.toml`), a `[projects."..."]` trzyma tylko
  `trust_level` (ARCHITECTURE 1.3). Codex nie rozwija zmiennych w `mcp_servers.*.env` i nie przekazuje środowiska rodzica;
  zmienną przekazuje `env_vars = ["NAZWA"]`.

Formaty, na których stoi ta decyzja. [D] znaczy: potwierdzone w dokumentacji narzędzia albo na żywym pliku, [?] znaczy:
przyjęte, niepotwierdzone.

| Narzędzie | Plik | Zakres | Odniesienie do zmiennej | Stan |
|---|---|---|---|---|
| Claude Code | `~/.claude.json`, klucz `mcpServers` | użytkownik | `"NAZWA": "${NAZWA}"` w `env` | [D] |
| Claude Code | `.mcp.json` w korzeniu projektu, klucz `mcpServers` | projekt | jak wyżej | [D] |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json` przy ustawionej zmiennej | użytkownik | jak wyżej | [?] |
| Codex | `config.toml`, `[mcp_servers.<nazwa>]` | tylko globalny | `env_vars = ["NAZWA"]` | [D] |
| Gemini CLI | `settings.json` (globalny i projektu), klucz `mcpServers` | oba | `$NAZWA` w `env` | [?] poza zakresem |

CLI (`cwm start`) ma już własny model serwera MCP (`core/cwm/resource.ts`): `env` to wyłącznie `envRef`, wartość wpisana
wprost jest odrzucana, a `$` w `command`, `args` i `url` jest zabroniony, bo silnik rozwija `${...}`. Aplikacja nie
przejmuje tego modelu (manifest CWM to inny byt niż natywna konfiguracja narzędzia, ADR 0059), ale dzieli z nim reguły:
tę samą listę zmiennych zabronionych (`MCP_ENV_DENYLIST`), ten sam test sekretu w tekście (`textHasSecret`) i tę samą zasadę
"tylko odniesienie, nigdy wartość".

## Rozważane opcje

**Synchronizacja MCP jak innych elementów.** Odrzucone z tych samych powodów co w ADR 0020: synchronizacja działa bez
podglądu poszczególnych serwerów, a każdy z nich uruchamia program.

**Eksport z kopiowaniem `env`.** Odrzucone. Wartość z `~/.claude.json` trafiłaby do `config.toml` albo do `.mcp.json`
w repozytorium, czyli do Gita.

**Jawny eksport z regułami w core, zapisem odniesień i potwierdzeniem egzekwowanym w main.** Wybrane.

## Decyzja

1. **Import.** Serwer MCP to jeden element `tool-setting`. Źródła: `mcpServers` z `~/.claude.json` (nowy root `mcp`,
   plik w katalogu domowym, z `CLAUDE_CONFIG_DIR` w tym katalogu), `mcpServers` z `.mcp.json` w projekcie (nowy root
   projektowy) i `[mcp_servers.<nazwa>]` z `config.toml` Codeksa (ten sam root co rejestr agentów). Z tych plików czytany
   jest wyłącznie ten klucz. Element ma klucz `mcpServers.<nazwa>` albo `mcp_servers.<nazwa>` i wartość z polami
   `transport`, `command`, `args`, `url`, `env` (lista `{ name, ref }`) i `headers` (same nazwy). `ref` to zmienna u
   użytkownika: dla `"${INNA}"` w Claude Code to `INNA`, dla każdej innej wartości to sama nazwa. **Wartości zmiennych i
   nagłówków nie trafiają do biblioteki nigdy**; import dodaje ostrzeżenie, że zostały tylko nazwy. Pola bez odpowiednika
   (`timeout`, `oauth`, `startup_timeout_sec`) trafiają do `unmappedKeys` jako same nazwy z wartością `null`, bo wartości
   mogą nieść dane logowania. Serwer, którego polecenie, argument albo adres wygląda na sekret (`textHasSecret`), nie
   jest importowany wcale (pominięcie z powodem), bo inaczej sekret wszedłby do biblioteki. Snapshot to `server.json` z tym
   samym opisem bez wartości.
2. **Zakres.** Reguły z ADR 0059 obowiązują bez zmian: serwer z `.mcp.json` jest przypięty do projektu i trafia tylko do
   konfiguracji projektowej tego samego projektu; serwer globalny trafia do katalogu globalnego, a do projektu tylko z
   jawnym "Dołącz elementy globalne", nigdy jako element prywatny albo z wykryciem sekretu. Import ustawia zakres
   prywatny, więc serwer globalny trafia do repozytorium dopiero po świadomej zmianie zakresu w formularzu. **Codex nie
   ma zakresu projektowego dla MCP**, więc eksport serwera do projektu w Codeksie jest odmową z tym powodem. Projekt w
   Gemini CLI jest poza tym zakresem.
3. **Sekrety.** Eksport zapisuje odniesienia, nie wartości: Claude Code `"NAZWA": "${REF}"` w `env`, Codex
   `env_vars = ["NAZWA"]`. Zmienna, której nie da się wyrazić odniesieniem, jest pomijana z ostrzeżeniem w planie: w
   Codeksie zmienna biorąca wartość z innej (`ref` różny od nazwy), w obu narzędziach zmienna z listy zabronionych
   (`PATH`, `NODE_OPTIONS`, `*_PROXY` itd.) i zmienna przy transporcie innym niż stdio. Serwer HTTP z nagłówkami jest
   odmową: wartości nagłówków to zwykle dane logowania, a serwer bez nich nie zadziała, więc pominięcie dałoby zepsutą
   konfigurację. Polecenie, argument albo adres ze znakiem `$` jest odmową (narzędzia rozwijają zmienne różnie, więc
   zmienne przechodzą tylko przez `env`), tak samo jak tekst wyglądający na sekret.
4. **Transport.** stdio: polecenie i argumenty są pokazane w całości w ostrzeżeniu wpisu i w podglądzie potwierdzenia, ze
   zdaniem "uruchamia program na tym komputerze". http i sse: tylko `https`, a `http` wyłącznie dla `localhost`,
   `127.0.0.1` i `[::1]`; adres bez danych logowania. sse do Codeksa jest odmową (Codex obsługuje stdio i http).
5. **Zapis do plików wspólnych tylko istniejącymi mechanizmami.** `~/.claude.json` i `.mcp.json`: edycja klucza
   najwyższego poziomu `mcpServers` (`setTopLevelKey`, zakres `json-key`), po której wynik jest parsowany i porównywany z
   wejściem: poza `mcpServers` drzewo musi być identyczne, a w `mcpServers` zmienione są tylko serwery z planu. Klucz jest
   zapisywany na nowo jako całość, więc formatowanie innych serwerów w tym kluczu może się zmienić, ale ich treść nie.
   `config.toml`: segmenty `[mcp_servers.<nazwa>]` (nowy edytor obok segmentów agentów, ta sama trójka z ADR 0011:
   preflight, edycja tylko własnych bloków, weryfikacja niezależnym parserem). Agenci i serwery MCP z jednego planu
   edytują ten sam tekst i dają jeden wpis `config.toml`.
6. **Nadpisanie tylko jawnie, z różnicą.** Serwer o tej samej nazwie i tej samej definicji (transport, polecenie,
   argumenty, adres, nazwy zmiennych) daje wpis `unchanged`. Inna definicja to konflikt z opisem różnic w powodzie
   (polecenie i zmienne teraz i po zamianie, bez wartości) i jedną opcją `replace-server`. Plan jest niewykonywalny do
   decyzji; po niej wpis pokazuje pełny diff pliku z redakcją sekretów. Blok Codeksa z podtabelami (np.
   `[mcp_servers.<nazwa>.env]`) albo w postaci tabeli inline nie jest zastępowany: odmowa z prośbą o ręczną zmianę.
7. **Potwierdzenie egzekwowane w main.** Plan, który zapisze serwer MCP (wpis inny niż `unchanged`), ma w raporcie
   listę serwerów (`mcp`: nazwa, transport, polecenie albo adres, nazwy zmiennych, ostrzeżenia). Kanał `export:plan`
   wydaje dla takiego planu jednorazowy znacznik (24 bajty losowe, ważny tyle co plan) i wysyła go z podglądem.
   `export:apply` zużywa znacznik przy każdej próbie (`timingSafeEqual`), a `ExportService.apply` niezależnie odmawia
   zapisu planu z serwerem MCP bez `mcpConfirmed` (`mcp-confirmation-required`); plan jest wtedy zużyty. Synchronizacja i
   cofnięcie z Historii wołają `apply` bez potwierdzenia: pierwsza nie dostaje serwerów MCP wcale, drugie przywraca kopię
   pliku i nie jest eksportem MCP.
8. **Synchronizacja, ZIP i profile zostają zablokowane.** `SyncService` daje serwerom MCP stan `unsupported` i pomija je
   w planie z powodem (`MCP_SYNC_REFUSAL`). Archiwum ZIP odmawia serwerów MCP w planie (archiwum służy do przekazania
   dalej). Profile (moduł Profiles, ARCHITECTURE 6) nadal nie mogą zawierać serwerów MCP. CLI ma własny model MCP w
   manifestach (`envRef`, zatwierdzanie przy `cwm start`) i nie czyta biblioteki aplikacji.
9. **Interfejs.** Plan eksportu z serwerami MCP ma sekcję "Serwery MCP w tym planie": nazwa, transport, polecenie albo
   adres w całości, zmienne ze środowiska, oraz pole "Sprawdziłem polecenia i adresy serwerów MCP i chcę je zapisać". Pole
   jest przypięte do znacznika planu, więc nowy plan wymaga nowego zaznaczenia. Przycisk zapisu nie jest blokowany (spis
   kontrolek E2E zabrania kontrolek zawsze zablokowanych): bez zaznaczenia zapis kończy się błędem przy polu
   (`role="alert"`, `aria-invalid`, `aria-describedby`) i fokusem na nim. Odmowy mają powód w liście odmów planu jak
   każdy inny element. Konflikt nadpisania korzysta z istniejącego widoku decyzji z sygnałem "Nadpisze".
10. **IPC.** Bez nowych kanałów. `ExportPlanDto` dostaje opcjonalne `mcp: { confirmation, servers }`, `export:apply`
    opcjonalne `mcpConfirmation` (szesnastkowo, 16 do 128 znaków), a `ConflictResolutionDto` wartość `replace-server`
    (tylko eksport, walidacja synchronizacji jej nie przyjmuje). `RootKind` dostaje `mcp`.

## Konsekwencje

Serwer MCP da się przenieść między Claude Code i Codeksem w zakresie globalnym oraz zapisać z powrotem do `.mcp.json`
swojego projektu, z podglądem polecenia, bez kopiowania sekretów i z kopią zapasową pliku przed zapisem. Element
importowany z jednego narzędzia ma w bibliotece wyłącznie nazwy zmiennych, więc po eksporcie serwer potrzebuje tych zmiennych
w środowisku, w którym narzędzie startuje. Plan mówi to wprost.

Koszty, na które się godzimy:

- Edycja `~/.claude.json` zapisuje cały klucz `mcpServers` na nowo. Claude Code przepisuje ten plik często; bramka zapisu
  porównuje bajty z planem i przy zmianie odmawia (`gate-plan-changed`), więc trzeba przygotować plan jeszcze raz.
- Pola bez odpowiednika (limity czasu, `oauth`, `enabled_tools`) nie przechodzą eksportu. Werdykt `partial` je wymienia.
- Zastąpienie serwera Codeksa z podtabelą `env` wymaga ręcznej zmiany pliku.
- Serwer z `$` w argumencie albo adresie (np. `${HOME}`) nie przechodzi eksportu, nawet do tego samego narzędzia.

## Otwarte (poza tym zakresem)

- Gemini CLI: import i eksport `mcpServers` z `settings.json` (globalnie i w projekcie, z odniesieniem `$NAZWA` po
  potwierdzeniu formatu w dokumentacji), z tymi samymi regułami. Wtedy reguła "projekt tylko do tego samego projektu w
  innym narzędziu" dostaje drugie narzędzie z zakresem projektowym.
- Nagłówki HTTP jako odniesienia (`env_http_headers` w Codeksie, `${NAZWA}` w nagłówkach Claude Code), z mapowaniem nazwy
  nagłówka na nazwę zmiennej podanym przez użytkownika.
- Serwery zakresu `local` Claude Code (`projects.<ścieżka>.mcpServers` w `~/.claude.json`) i flagi
  `enabledMcpjsonServers`/`disabledMcpServers`.
- Zastępowanie bloku Codeksa z podtabelami i usuwanie serwera z narzędzia (dziś aplikacja niczego nie usuwa).
- Formularz edycji serwera MCP w bibliotece (dziś opis zmienia tylko import).
- Synchronizacja MCP: wymaga osobnej decyzji o potwierdzeniu per serwer w Centrum synchronizacji.
