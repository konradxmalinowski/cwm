# ADR 0051: lockfile projektu (`cwm lock`)

Status: zaakceptowane w zakresie planu (2026-11-16)
Data: 2026-11-16
Dotyczy: ADR 0036 (pkt 10, wersja silnika), ADR 0037 (deterministyczny resolver), ADR 0040 (zatwierdzenia, `cwm start`), ADR 0044 (pakiety, skróty członków), ADR 0047 (`cwm diff`), ADR 0048 (pluginy z git), ADR 0050 (workflow `orchestrated`)
Źródło: plan `plans/2026-11-16-cwm-lockfile.md` (lokalny, poza repozytorium); kod w `src/core/cwm/lockfile.ts`, `src/infra/cwm/lockfile.ts`, `src/infra/cwm/runtime-plan.ts`, `src/cli/lock-flow.ts`, `src/cli/commands/lock.ts`, `src/cli/commands/start.ts`, `src/cli/commands/diff.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

ADR 0037 zrobił z resolvera funkcję deterministyczną "jako warunek późniejszego lockfile", a ADR 0036 pkt 10
zapowiedział zapis wersji Claude Code przy projekcie. Do tej pory nic nie mówiło, że projekt dostaje dziś to samo,
co w zeszłym tygodniu: zasób w rejestrze, firma, plugin z git albo silnik mogły się zmienić bez śladu. Zatwierdzenia
(ADR 0040) odpowiadają na inne pytanie ("czy ten kod wolno uruchomić") i obejmują tylko zasoby z polami
wykonawczymi. Lockfile odpowiada na pytanie "czy to jest ten sam obraz co poprzednio", dla wszystkich zasobów,
bez sieci.

## Decyzje

1. **Format i miejsce.** `cwm.lock` obok manifestu projektu, w tym samym magazynie: `<projekt>/.cwm/cwm.lock`
   (`--store local`) albo `~/.cwm/companies/<firma>/projects/<id>.lock` (`--store home`; listing projektów czyta
   tylko `*.yaml`, więc plik `.lock` mu nie przeszkadza). JSON, `apiVersion: cwm.dev/v1`, `kind: Lock`, klucze
   posortowane (kolejność z `canonicalJson`), wcięcie 2 spacje, koniec pliku to nowy wiersz, zasoby posortowane po
   `rodzaj:id`. Zapis i odczyt przechodzą przez te same straże co manifest (`writeScopedFile` z `projectScope` albo
   `homeScope`: atomowo, `0600`, odmowa dla dowiązań; odczyt `readTextWithin`, limit 8 MiB). Dowiązanie, plik
   większy od limitu, nieczytelny JSON, obca wersja `apiVersion`, nieznane pole albo zduplikowany zasób to błąd
   `invalid`, nigdy cichy brak.
2. **Zawartość.** Firma, projekt, silnik (`{ name: claude-code, version }`) i lista zasobów efektywnych. Wpis:
   `id`, `kind`, `origin`, `layer`, `version`, `definition`, `content` oraz opcjonalnie `pins`, `git`,
   `marketplace`. Warstwy są w polu `layer` każdego wpisu (najniższa warstwa, z której zasób trafił do konfiguracji).
3. **Skróty (żadnych nowych funkcji skrótu).** Wszystkie to SHA-256 z istniejących pomocników: `canonicalJson`
   (ADR 0040) dla `definition`, `treeSha256` i `sha256Hex` z `runtime-sources.ts` dla `content`, ten sam skrót drzewa,
   który plan liczy dla zatwierdzeń pluginów i pakietów (APR-03, ADR 0044). `content` liczy się z bajtów źródłowych
   **przed** przepisywaniem odwołań do natywnego katalogu, więc nie zawiera ścieżki profilu i jest taki sam na
   każdej maszynie:

   | Rodzaj | `content` |
   |---|---|
   | skill, files | `treeSha256` drzewa z rejestru |
   | agent, command | SHA-256 pliku źródłowego |
   | workflow | SHA-256 wygenerowanej komendy (ta sama treść, którą zatwierdzenie bierze jako `source.sha256`; dla `orchestrated` zawiera nazwy agentów, ADR 0050) |
   | plugin | `treeSha256` drzewa pluginu; dla git dodatkowo `git: { commit, tree }`, dla marketplace'u `marketplace: { name, version }` (wersja z wpisu katalogu) |
   | mcp | SHA-256 pliku polecenia, gdy polecenie jest ścieżką; inaczej `null` |
   | settings | `null` |

   `pins` to skrót posortowanej listy skrótów skryptów hooków, które plan przypina (bez ścieżek); jest tylko tam,
   gdzie coś przypięto. `definition` to skrót kanonicznego JSON definicji z manifestu bez `nativeDir` (ścieżka
   bezwzględna katalogu importu); wartości `env` wpisane wprost i nazwy `envRef` wchodzą do skrótu (pkt 4). Pola
   `version` i `marketplace` są walidowane wzorcami przy odczycie, a wypisywane różnice są czyszczone ze znaków
   sterujących i skracane.
4. **Czego nie ma w pliku.** Czasu, nazwy hosta, ścieżek bezwzględnych (`nativeDir`, ścieżka projektu, profilu i
   silnika), adresów URL i jawnych wartości `env` czy argumentów: są tylko nazwy, wersje i skróty. Wartości `env`
   wpisane wprost w `Settings` **wchodzą do skrótu definicji**: zasób z taką wartością przeszedł już
   `classifyEnvValue` (polityka odrzuca wartości wyglądające na sekret), a zmiana np. `ANTHROPIC_MODEL` ma być
   dryfem. `envRef` wchodzi jako nazwa zmiennej. Skrót nie jest tajny (zob. Konsekwencje): to nie HMAC.
5. **`cwm lock [--check] [--json]`.** Liczy lockfile z `prepareRun` (to samo rozwiązanie, ten sam plan i te same
   błędy co `cwm start`; nic nie jest generowane ani zatwierdzane, brak sieci: `denyNetwork`). Wersję silnika daje
   `detectEngineVersion`: `resolveEngineBinary` (ta sama ścieżka i kontrola właściciela co przy starcie) i
   `queryEngineVersion` (`claude --version`, minimalne środowisko, pusty katalog tymczasowy 0700, limit 5 s, 4 KiB
   wyjścia); brak bezpiecznego pliku, nieudana próba i każdy wyjątek to `null`. Katalog tymczasowy jest systemowy
   (jak w `--dry-run`), bo `cwm lock` i `cwm diff` nie tworzą katalogu firmy; `cwm start` używa katalogu firmy. Bez `--check`: zapis tylko, gdy bajty się różnią;
   uszkodzonego lockfile nie nadpisuje (mógł powstać w nowszej wersji CWM), odsyła do ręcznego usunięcia. Z `--check`:
   kod `0` zgodny, `1` dryf, `2` brak, uszkodzenie lub błąd ustawienia (ta sama konwencja co `cwm diff`, gdzie `1`
   znaczy różnicę).
6. **Porównanie** (`compareLocks`, czysta funkcja w rdzeniu): zasób dodany, usunięty albo zmieniony (lista pól:
   `origin`, `layer`, `version`, `definition`, `content`, `pins`, `git`, `marketplace` z opisem skróconych skrótów i
   commitów), inna firma lub projekt, inna wersja silnika. Wersja silnika różni się tylko wtedy, gdy znane są obie
   (`null` po jednej stronie to brak informacji, nie dryf). Wynik jest posortowany.
7. **`cwm start` i `cwm run`** (wspólny `launchPrepared`): po rozwiązaniu i ustaleniu wersji silnika, przed
   `loadApprovalState` i przed pytaniami. Uszkodzony lockfile bez frozen to ostrzeżenie z podpowiedzią usunięcia
   pliku (praca nie jest blokowana), we frozen odmowa. Dryf zasobów to ostrzeżenie z podsumowaniem i podpowiedzią (`cwm lock --check`,
   `cwm lock`), start idzie dalej. **Inna wersja silnika to zawsze tylko ostrzeżenie**, także we frozen (ADR 0036
   pkt 10; ponowne sprawdzenia V-01..V-08 z spike'a przy innej wersji pozostają poza zakresem: ostrzeżenie o wersji
   innej niż przetestowana już istnieje). Tryb **frozen** (`--frozen` albo `spec.lock: frozen` w `project.yaml`)
   zamienia dryf zasobów i tożsamości w odmowę z kodem `1` przed jakimkolwiek pytaniem lub zapisem; w tym trybie także
   brak i uszkodzenie lockfile są odmową z podpowiedzią. `cwm lock` nadal nie nadpisuje uszkodzonego pliku, a
   `cwm lock --check` kończy się kodem `2`. `--dry-run` pokazuje stan i
   powody jako `blockers`, `--json` dodaje `lock { state, frozen, error, drift, blockers, warnings }`
   (`state`: `absent`, `match`, `drift`, `invalid`).
8. **`cwm diff`** dostaje tę samą ocenę jako sekcję (jedna linia stanu i lista różnic). Sam dryf nie zmienia kodu
   wyjścia (diff odpowiada na pytanie "co zmieni start w profilu"); odmowa startu z powodu lockfile (uszkodzony,
   frozen z dryfem lub brakiem) wchodzi do `blockers` i daje kod `1`. `--frozen` jest też opcją `cwm diff`, żeby
   dało się sprawdzić to, co zrobi `cwm start --frozen`. Diff uruchamia `claude --version` (to jedyny proces, `null`
   przy niepowodzeniu), bo bez niego nie porówna wersji silnika.
9. **Warstwy.** Rdzeń (`src/core/cwm/lockfile.ts`): typy, `buildLock`, `formatLock`, `parseLock`, `compareLocks`,
   `lockDefinition`, `lockPinsHash`, bez wejścia i wyjścia (tylko `node:crypto`, jak `approval.ts`). Infra
   (`src/infra/cwm/lockfile.ts`, `runtime-plan.ts`): ścieżka, odczyt, zapis oraz `lockFacts` w `RuntimePlan` (skróty
   treści zbierane tam, gdzie plan i tak czyta bajty zasobu). CLI (`src/cli/lock-flow.ts`, `commands/lock.ts`, zmiany
   w `start.ts`, `run.ts`, `diff.ts`): ocena, wypisywanie, opcje.

## Konsekwencje i ryzyko szczątkowe

- **Lockfile nie jest zatwierdzeniem ani granicą bezpieczeństwa.** Kto może zmienić zasoby, może zapisać też
  lockfile (`cwm lock`); frozen to wykrywanie dryfu, nie ochrona integralności: chroni przed przypadkową zmianą i
  różnicami między maszynami, nie przed złośliwym autorem projektu. Zgody na kod nadal dają wyłącznie zatwierdzenia.
- **Skróty nie są tajne.** Skrót definicji (kanoniczny JSON bez HMAC) pozwala zgadnąć krótki sekret, który
  przeszedł klasyfikator, ale leży w `args` serwera MCP, w poleceniu hooka albo w wartości `env`, jeśli lockfile
  trafi do repozytorium. Nie commituj lockfile projektów, których zasoby osadzają dane uwierzytelniające w `args` albo
  hookach (zamiast tego użyj `envRef`). HMAC celowo poza zakresem.
- **Lockfile ujawnia nazwy.** Zawiera id zasobów (także prywatnych), id firmy i projektu, więc jego udostępnienie
  ujawnia te nazwy.
- `cwm diff` i `cwm lock` uruchamiają `claude --version` (pkt 5, 8), czego diff z ADR 0047 wcześniej nie robił.
- `<projekt>/.cwm/` jest zwykle ignorowane przez git, więc lockfile lokalnego projektu nie trafia do zespołu, dopóki
  ktoś nie wyłączy ignorowania samego `cwm.lock`. Udostępnianie jest decyzją użytkownika; CWM nie zmienia `.gitignore`.
- Skrót `pins` zależy od treści skryptów w miejscu, na które wskazuje polecenie hooka (`~`, `$HOME`); inna kopia
  skryptu na innej maszynie to dryf, co jest zamierzone, ale nie odróżnia "zmieniono" od "inaczej zainstalowano".
- Zasób `marketplace` i `local` ma skrót treści z katalogu, który leży poza rejestrem; to ten sam skrót, który plan
  liczy dla zatwierdzeń, ale lockfile nie przechowuje samego katalogu.
- Dwa równoległe `cwm lock` nie biorą blokady: zapis jest atomowy, wygrywa późniejszy.
- Zmiana kształtu pól (`LockEntry`) wymaga nowej wersji formatu: obecny odczyt odrzuca nieznane pola i obcy
  `apiVersion` zamiast je zgadywać.

## Weryfikacja

Testy jednostkowe tylko w istniejących plikach (`tests/unit/cwm-approval-hash.test.ts`: determinizm bajtów i
niezależność od kolejności, `nativeDir`, `pins`, round-trip i odrzucenia `parseLock`, porównanie z dodanym,
usuniętym i zmienionym zasobem, zmiana commitu pluginu z git, wersja silnika, tożsamość, odrzucenie błędnej wersji i
nazwy marketplace'u; `tests/unit/cwm-settings-env-secrets.test.ts`: wartość `env` wpisana wprost nie trafia do
dokumentu, ale zmienia skrót definicji).
Ręcznie, z fałszywymi `HOME` i `CWM_HOME`, atrapą `claude` w `PATH` i istniejącym fixture'em pluginów z git (kopie
lokalne, bez sieci): zapis, `--check` zgodny, zmiana zasobu, zmiana commitu pluginu z git, zmiana wersji atrapy
silnika, frozen (flaga i `spec.lock`) z odmową przed pytaniami, `cwm run --frozen`, brak lockfile, uszkodzony, obcy,
dowiązanie i zbyt duży plik, determinizm (usunięcie i ponowny zapis dają te same bajty), magazyn `home`.
