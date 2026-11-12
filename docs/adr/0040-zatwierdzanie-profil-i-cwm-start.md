# ADR 0040: Zatwierdzanie, profil firmy i `cwm start`

Status: zaakceptowane w zakresie decyzji właściciela (2026-11-12); właściciel potwierdził izolację od konta claude.ai domyślnie włączoną (opt-out `runtime.isolation: false`) i usuwanie `SSH_AUTH_SOCK` domyślnie (powrót przez `runtime.env.passthrough`); pozostałe punkty z sekcji „Do potwierdzenia przez właściciela” czekają
Data: 2026-11-12
Uzupełnienie: [ADR 0041](0041-import-prawdziwej-konfiguracji-pliki-wspolne-i-odwolania.md) dodaje rodzaj `Files` do profilu i przepisywanie odwołań do natywnego katalogu w kopiach zasobów
Dotyczy: ADR 0012 (WriteGate), ADR 0020 (brak automatycznej synchronizacji MCP), ADR 0036 (zachowanie Claude Code), ADR 0037 (model zasobów), ADR 0038 (fundament CLI), ADR 0039 (Settings, Command, import)
Źródło: plan etapów, model zagrożeń (sekcje 2, 3, 4, 5, 7, 9) i wyniki weryfikacji silnika V-01 do V-08 z 2026-11-12 (pliki w `plans/`, lokalne, poza repozytorium); kod w `src/core/cwm/{approval,canonical-json,child-env,cleanup-paths,engine-argv,runtime-config}.ts`, `src/infra/cwm/{approvals,engine-process,runtime-*}.ts`, `src/cli/commands/{start,approvals}.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

Etap A (ADR 0039) wypełnia rejestr. Etap B zamienia rozwiązaną konfiguracją projektu w działającą
sesję Claude Code. To granice zaufania G2 (rejestr -> zatwierdzenie -> profil) i G3 (profil
i środowisko -> proces silnika). Ekran zatwierdzania jest jedyną bramką przed wykonaniem kodu z
rejestru (hooki, serwery MCP i pluginy z `--plugin-dir` silnik uruchamia bez własnego pytania,
ADR 0036), więc każde pole, które decyduje o wykonaniu, musi wejść do skrótu.

## Decyzje właściciela (2026-11-12)

1. Zatwierdzanie w CLI, zapamiętane po skrócie w `~/.cwm/approvals/<firma>.yaml`. Zmiana pola
   wykonawczego wywołuje ponowne pytanie. Bez terminala odmowa, chyba że już zatwierdzone.
2. Nazwy w wariancie mieszanym: zasoby `mandatory` w pluginie CWM (`--plugin-dir`, z
   przedrostkiem, nie do zasłonięcia przez projekt), `optional` pod zwykłymi nazwami w profilu,
   serwery MCP zawsze jako `cwm-<firma>-<nazwa>`.
3. Profil per firma w `~/.cwm/runtime/<firma>/claude` jako `CLAUDE_CONFIG_DIR`, z blokadą per firma
   (PRF-01, wariant minimalny) i plikami per uruchomienie w `sessions/<skrót-projektu>/`.
4. Klucze izolacji od zasobów konta claude.ai domyślnie w pliku `--settings`.
5. Testy jednostkowe tylko dla czterech czystych funkcji Etapu B: skrót zatwierdzenia z
   kanonizacją, walidacja ścieżek sprzątania, budowa środowiska, budowa argumentów silnika
   (`tests/unit/cwm-*.test.ts`). Wykrywanie sekretów w `env` pokrywa test z Etapu A. Reszta bez testów.

## Decyzje

**Skrót zatwierdzenia (APR-01, APR-02).** SHA-256 z `cwm-approval-v1\n` i kanonicznego JSON
(styl RFC 8785: klucze po jednostkach UTF-16, bez białych znaków, liczby ES, `undefined` jest
błędem) dokumentu `{v, engine, company, kind, id, fields}`. Wersja zasobu nie wchodzi do skrótu.
Pola (po przeglądzie, SEC-01, 04, 06, 12):

- **MCP:** `transport`, `command`, `args`, `url`, `env`, katalog projektu (`projectDir`), plik
  polecenia po `realpath` (`commandPath`) i jego `sha256`. Klucz to `mcp:<id>@<skrót-projektu>`
  (16 znaków skrótu ścieżki projektu), ale tylko gdy `command` jest ścieżką (zawiera `/`): wtedy
  `projectDir` wchodzi do skrótu, bo ten sam plik względny w innym projekcie to inny kod. Dla
  polecenia z `PATH` (`npx`, `node`) `projectDir` w polach to `null`, klucz nie ma przyrostka, a
  zatwierdzenie nie skacze między projektami. Przy zapisie zatwierdzeń przyrostek jest zdejmowany
  przed sprawdzeniem, czy zasób nadal jest w rejestrze (sprzątanie wpisów). Polecenie ze znakiem `/`
  musi dać się przypiąć, inaczej plan kończy się błędem (nigdy skrót `null`). Wygenerowany `mcp.json`
  zawiera bezwzględną ścieżkę po `realpath` (ten sam plik, który został zahaszowany), nie ścieżkę
  względną z manifestu. Względne rozwiązujemy względem
  projektu i po `realpath` cel musi leżeć w projekcie (dowiązanie na zewnątrz to odmowa;
  dowiązanie do wnętrza jest dozwolone i haszowany jest cel). Skrót liczony strumieniowo, bez limitu 1 MiB.
  Goły `npx` idzie przez `PATH` i ma tylko ostrzeżenie o braku wersji pakietu.
- **Plugin `local`:** `source`, skrót drzewa, lista plików `{path, sha256}`, polecenia hooków,
  definicje serwerów MCP i LSP wyciągnięte z `hooks/hooks.json`, `.mcp.json`, `.lsp.json` i
  `.claude-plugin/plugin.json` (także z plików, na które wskazuje manifest), hooki innych typów,
  pliki z nieczytelnym JSON, przypięcia skryptów spoza `${CLAUDE_PLUGIN_ROOT}` oraz odwołania
  manifestu (`manifestRefs`: `hooks`, `mcpServers`, `lspServers` i ścieżki `commands`, `agents`,
  `skills`, `outputStyles`; razem ze ścieżkami po normalizacji). Nazwy tych czterech plików są
  dopasowywane bez rozróżniania wielkości liter (APFS i NTFS tak je widzą). Fail closed, plugin jest
  odrzucany, gdy: odwołanie wychodzi poza drzewo pluginu (ścieżka bezwzględna, `..`, `$`, `\`),
  wskazuje brakujący plik, ma zły typ wartości, albo `plugin.json` zawiera nieznany klucz (poza
  metadanymi `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`,
  `keywords`). Różnica „było/jest” wymienia zmienione pliki.
- **`Settings`:** całe `hooks`, `permissions`, `env`, `enforce`, `sha256` skryptów z poleceń hooków.
- **Skill, agent, komenda:** flagi, `tools`, pełna wartość `allowed-tools`, pełna lista wstawek `!`,
  `model` i skrót treści (z plików, nie z `contentFlags`). Ekran pokazuje je w całości.
- **Para projekt-firma (APR-09, SEC-06):** ścieżka projektu, firma i posortowana lista zasobów
  włączonych przez warstwę projektu (`kind:id` + skrót definicji). Klucz to skrót ścieżki
  (`project:<sha256>`); ścieżka jest w polach i na ekranie.
- **Firma (SEC-12):** `company:<id>` z `runtime.claude.path` (po `realpath`), `env.passthrough` i `isolation`.

Wpis zapisuje też pola, żeby pokazać różnicę.

**Ostrzeżenia (SEC-13).** Przed pytaniami `cwm start` wypisuje ostrzeżenia planu oraz ostrzeżenia
zasobów już zatwierdzonych (`Ostrzeżenie (zatwierdzone ...)`), żeby odpowiadający widział pełny
obraz; ostrzeżenia zasobów do zatwierdzenia są na ich ekranie.

**Kolejność (APR-04).** `buildRuntimePlan` buduje w pamięci wszystkie bajty (profil, pliki
uruchomienia, migawki pluginów) i skróty z tych samych obiektów. Po zatwierdzeniu `applyPlan`
zapisuje dokładnie te bajty, czyta je z powrotem i porównuje ze skrótami planu, a dopiero potem
następuje `spawn`. Między planem a zapisem nie ma ponownego odczytu rejestru ani źródeł.

**Zatwierdzenia na dysku (APR-05, SEC-09).** Plik jest czytany ponownie i scalany pod mutexem tuż
przed zapisem, a dokument przechodzi walidator odczytu przed zapisem (limit 500 wpisów, klucze do
512 znaków). Przy zapisie usuwane są wpisy zasobów, których nie ma już w rejestrze, i par
projekt-firma, których katalog nie istnieje; lista jest raportowana. `revoke` też działa pod mutexem.

**Odwołanie (APR-08, SEC-05).** `revoke` usuwa pliki profilu z manifestu o zgodnym skrócie. Gdy
silnik zmienił `settings.json`, CWM zapisuje kopię w `generated/revoked/` i usuwa z pliku tylko klucze
`hooks`, `permissions` i `env`; jeśli czegoś z CWM nie da się usunąć, polecenie kończy się kodem 1.

**Profil (PRF-02..PRF-06, PRF-09).** Zapis i usuwanie tylko w `src/infra/cwm/runtime-fs.ts`
(nowy zakres zapisu `runtimeScope` z PRF-04): lista dozwolonych ścieżek względnych
(`validateCleanupPath`), bez dowiązań na ścieżce, właściciel równy bieżącemu użytkownikowi, tryby
0700/0600. Profil traktujemy jako dane CWM, ale z regułami kopii i weryfikacji z ARCHITECTURE 8.3.
Zmiana plik po pliku (`writeFileAtomic`), poprzednie wersje w `generated/prev/`, manifest zapisany
jako ostatni. Błąd w środku przywraca pliki, usunięte pliki i poprzedni manifest. Usuwanie wyłącznie według manifestu: ścieżka
przechodzi walidację, skrót pliku równa się skrótowi z manifestu, `lstat` + `unlink`, `rmdir`
pustych katalogów, nigdy `rm -r`. Katalog `staging/` z PRF-03 pominięto: plan jest w pamięci, a
odczyt kontrolny po zapisie daje tę samą gwarancję.

**Blokada (PRF-01, SEC-07, SEC-08, SEC-15).** Mutex `.lock` na czas generowania i zapisu
zatwierdzeń: treść trafia do pliku tymczasowego, a `link()` publikuje go atomowo (zamek nigdy nie
jest widoczny pusty). Pusty lub nieczytelny zamek młodszy niż 10 s jest trzymany; przejęcie
nieaktualnego (martwy PID albo starszy pusty) odbywa się pod strażniczym plikiem `.lock.guard`
(`O_EXCL`) z ponownym sprawdzeniem stanu, więc dwaj czekający nie usuną po sobie świeżego zamka.
Znaczniki trwających sesji `active/<pid>.json` niosą też PID procesu silnika i listę migawek
pluginów; sesja żyje, dopóki żyje któryś z PID. Start odmawia, gdy trwa sesja firmy z innym
`profileHash`, albo sesja tego samego projektu z innym `sessionHash`; `sessionHash` obejmuje pliki
`sessions/<projekt>/` i migawki pluginów. Nieaktualne migawki pluginów, z których nie korzysta
żadna trwająca sesja, są sprzątane według manifestu. Ten sam plan: start bez zmian na dysku
(porównywana jest treść i tryb pliku).

**Podział ustawień (V-03, V-05).** Cała polityka z `enforce: true` oraz klucze izolacji idą do
jedynego pliku `--settings` uruchomienia (czytany raz przez silnik, więc niezmienny w sesji).
`Settings` bez `enforce` idą do `settings.json` profilu (poziom użytkownika, niższy priorytet niż
projekt), który jest minimalny i zmieniany tylko pod blokadą. Hooki `enforce` ustawiają jawnie
`disableAllHooks: false`; ekran zatwierdzania ostrzega, że to włącza też hooki projektu.
Użytkownikowa flaga `--settings` jest odrzucana (druga flaga zastępuje pierwszą w całości).

**Argumenty (SPN-03, V-06).** Flagi CWM, wielowartościowe w formie `--flaga=wartość`, na końcu
`--settings <plik>`, potem argumenty użytkownika. Odrzucane są flagi zarządzane i obchodzące
politykę oraz każdy argument pozycyjny będący podpoleceniem silnika (nie tylko pierwszy, bo CWM nie
wie, które opcje biorą wartość): `agents`, `attach`, `auth`, `auto-mode`, `config`, `doctor`,
`gateway`, `import`, `install`, `kill`, `logs`, `mcp`, `plugin`, `plugins`, `purge`, `respawn`,
`rm`, `setup-token`, `stop`, `ultrareview`, `update`, `upgrade` (lista z `claude --help` 2.1.322,
z aliasami; `engine-argv.ts`). Separator `--` jest dodawany tylko wtedy, gdy
wszystkie argumenty użytkownika są tekstem promptu; przy opcjach (`-p`, `--model`) byłby błędem,
bo zamieniłby je w tekst promptu, a wielowartościowe flagi nie mogą ich połknąć dzięki formie `=`.

**Środowisko (SPN-02, SEC-03, SEC-11) i silnik (SPN-01).** Zob. `docs/CLI.md`. Funkcja
`buildChildEnv` jest czysta i nie zwraca wartości w listach nazw. Nazwy wyglądające na sekret, ale
będące ścieżkami albo identyfikatorami terminala (`PATH`-podobne, `PWD`, `NODE_EXTRA_CA_CERTS`,
`*_SESSION_ID`), są dziedziczone. `SSH_AUTH_SOCK` jest usuwany (kanał wycieku z PRF-08) i wraca przez
`runtime.env.passthrough` (potwierdzone przez właściciela). `envRef` innych firm to wszystkie `envRef`
z rejestru poza użytymi przez tę firmę w tym uruchomieniu. Wartości o kształcie sekretu (prefiksy
dostawców, JWT, PEM, `://user:pass@`) są usuwane, chyba że to `envRef` tej firmy albo `passthrough`;
z `PATH` znikają też elementy w katalogu projektu. Probe `claude --version` działa w pustym
katalogu tymczasowym 0700 (jest też `CLAUDE_CONFIG_DIR` próby), a katalog firmy (0700) powstaje przed
nią w trybie bez `--dry-run`.

**Sygnały (SPN-05).** Silnik dziedziczy grupę procesów terminala i sam dostaje SIGINT oraz SIGHUP,
więc CWM ich nie przekazuje (sesja dostałaby je dwa razy), tylko przeżywa. Przekazywany jest SIGTERM
wysłany do samego procesu CWM. `SIGINT` wysłany tylko do procesu CWM (bez grupy) go nie zatrzymuje.

**Procesy w kodzie (SEC-16).** `node:child_process` wolno importować tylko w `engine-process.ts` i
`gitignore.ts` (reguły ESLint, także `require` i `import()`, z próbami w `test:boundaries`).

## Do potwierdzenia przez właściciela

0. **Potwierdzone przez właściciela (przegląd):** (a) izolacja od zasobów konta claude.ai jest
   domyślnie włączona, a wyłącza ją `runtime.isolation: false` w manifeście firmy; (b)
   `SSH_AUTH_SOCK` jest domyślnie usuwany ze środowiska silnika, a opt-in to
   `runtime.env.passthrough`.
1. **`runtime.isolation` domyślnie `true`.** Pliki `--settings` ustawiają `syncClaudeAiPlugins:
   false`, `syncClaudeAiSkills: false`, `disableClaudeAiConnectors: true`. Skutek: sesja firmy nie
   widzi pluginów, skilli i konektorów konta claude.ai. Opt-out per firma: `runtime.isolation:
   false`. Opcja `runtime` w manifeście firmy (`isolation`, `claude.path`, `env.passthrough`) jest
   rozszerzeniem spoza specyfikacji.
2. **Gdzie leżą `Settings` bez `enforce`:** w `settings.json` profilu (poziom użytkownika), nie w
   `--settings`. Zachowuje semantykę „domyślne, projekt może przesłonić”, ale wymaga blokady
   profilu. Wariant „wszystko w `--settings`” zrobiłby z `enforce: false` to samo co `true`.
3. **Zasób staje się częścią pluginu CWM tylko, gdy jego pochodzenie to `mandatory`.**
   Zależności zasobu `mandatory` (pochodzenie `dependency`) dostają zwykłe nazwy w profilu.
4. **`settings.json` profilu zmieniony przez silnik** (np. przez `/config`) jest zastępowany przy
   każdym starcie, który zmienia jego treść, z kopią i listą nazw zmienionych kluczy. Zmiany
   silnika w tym pliku nie przetrwają, dopóki w profilu są `Settings` bez `enforce`.
5. **Odwołanie unieważnia cały wygenerowany profil firmy**, nie pojedynczy zasób, bo
   `settings.json`, `mcp.json` i plugin są agregatami.
6. **`cwm start` z podkatalogu projektu** uruchamia silnik w katalogu z manifestem (SPN-04), nie w
   podkatalogu.
7. **Pominięte w tym kroku:** HMAC zatwierdzeń (APR-05 [P]), `approve --hash` (APR-07 [P]), dziennik
   (APR-10), tryb `scrub`, `--allow-engine-flag`, pluginy `marketplace` i `git`, Windows.
8. **Workflow** nie jest generowany do silnika (brak odpowiednika); `cwm start` zgłasza to w notatce.

## Ryzyko szczątkowe

- Proces tego samego użytkownika jest poza modelem: może zmienić profil po odczycie kontrolnym,
  zatwierdzenia lub manifest. Zabezpieczenia to higiena (tryby 0600/0700, walidacja, skróty).
- Skrypt hooka (poza pluginem) jest przypięty skrótem w chwili planu, ale nie skopiowany (IMP-08 [P]):
  zmiana po odczycie, a przed uruchomieniem, nie jest wykrywana. To samo dotyczy pliku polecenia MCP
  (haszowany po `realpath`, nie kopiowany) i skryptów poza `${CLAUDE_PLUGIN_ROOT}` w pluginach.
- Wstawki i hooki pluginu wyciągamy heurystycznie z JSON-ów, które znamy; deklaracje w innych
  formatach lub zbudowane w czasie działania pluginu nie są widoczne w zatwierdzeniu.
- Znacznik sesji opiera się na PID (CWM i silnika): ponowne użycie PID przez inny proces po awarii
  może dać fałszywą blokadę (do usunięcia pliku w `active/`); zabity `-9` CWM zostawia znacznik, który
  żyje, dopóki żyje silnik, a potem jest czyszczony przy następnym starcie.
- Strażnik przejęcia zamka starszy niż 10 s jest usuwany bez dalszych sprawdzeń: bardzo wolny
  proces trzymający strażnika mógłby dać dwóm czekającym zamek naraz (okno rzędu milisekund).
- Sekrety `envRef` tej firmy są widoczne dla natywnych hooków i MCP projektu oraz dla modelu przez
  Bash (SPN-02). Usuwa to dopiero pośrednik sekretów (`cwm mcp-exec`, [P]).
- Wykrywanie kolizji z natywnym `.claude/` jest ograniczone do cwd, katalogów nadrzędnych, `--add-dir`
  i dwóch poziomów w głąb; skille leżące głębiej nie są wykrywane.
- Działająca sesja nie traci wczytanych hooków ani serwerów MCP po `approvals revoke`.
- `--dry-run` uruchamia `claude --version` (w pustym katalogu tymczasowym), żeby podać wersję.
- Wersja silnika inna niż 2.1.322 daje ostrzeżenie, nie odmowę.

### Ryzyko szczątkowe po ponownej weryfikacji bezpieczeństwa

- Odwołania manifestu pluginu do katalogów (`commands`, `agents`, `skills`, `outputStyles`) są
  sprawdzane tylko pod kątem istnienia i położenia w drzewie pluginu. Zawartość tych katalogów (np.
  wstawki `!` w komendach pluginu) nie jest analizowana; chroni ją wyłącznie skrót drzewa i lista
  plików w zatwierdzeniu.
- `SIGINT` wysłany tylko do procesu CWM (`kill -INT <pid>`, bez grupy procesów terminala) nie
  zatrzymuje silnika, bo CWM go nie przekazuje; silnik działa dalej, a CWM czeka na jego koniec.
- Wyścig o plik strażniczy `.lock.guard` jest znany i zapisany (akapit wyżej o strażniku starszym
  niż 10 s): okno rzędu milisekund, bez dalszego zabezpieczenia w tym kroku.
- Treść skilla, agenta, komendy lub pliku `.md` w `Files`, która po pierwszym frontmatterze zaczyna
  się od `---` albo `...`, jest odrzucana (drugi blok frontmattera trafiłby do silnika bez analizy).
  Wynik odtworzenia nigdy nie ma pustego bloku frontmattera i jest sprawdzany ponownie (ADR 0041).
