# ADR 0052: sprawdzenie nowej wersji silnika (`cwm engine check`)

Status: zaakceptowane w zakresie planu (2026-11-16)
Data: 2026-11-16
Dotyczy: ADR 0036 (pkt 10, wersja silnika; V-01 do V-08), ADR 0040 (`cwm start`, silnik i jego środowisko), ADR 0051 (lockfile, wersja silnika)
Źródło: plan `plans/2026-11-16-cwm-engine-check.md` (lokalny, poza repozytorium); kod w `src/core/cwm/engine-check.ts`, `src/core/cwm/engine-argv.ts`, `src/core/cwm/child-env.ts`, `src/infra/cwm/engine-process.ts`, `src/infra/cwm/engine-checks.ts`, `src/cli/engine-flow.ts`, `src/cli/commands/engine.ts`, `src/cli/commands/start.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

ADR 0036 pkt 10 zapowiedział, że przy innej wersji runtime CWM powtórzy sprawdzenia metadanych ze spike'a i ostrzeże
przy różnicy. Claude Code aktualizuje się sam, a stała `EXPECTED_ENGINE_VERSION` (2.1.322) zmienia się tylko razem z
kodem CWM, więc każde wydanie silnika dawało to samo ostrzeżenie ("wersja różni się"), bez żadnej informacji, czy
flagi, na których CWM stoi, nadal istnieją. ADR 0051 pkt 7 zostawił to poza zakresem. Ten ADR zamyka lukę dla
interfejsu wiersza polecen; zachowanie sesji z modelem (V-01 do V-08) zostaje spike'iem robionym ręcznie.

## Decyzje

1. **Co jest sprawdzane.** Cztery polecenia metadanych pliku silnika, po kolei: `--version`, `--help`,
   `plugin --help`, `mcp --help`. Nic więcej: bez `-p`, bez logowania, bez modelu, bez żadnego innego podpolecenia.
   Ocena dotyczy tylko tekstu pomocy.
2. **Ta sama binarka i to samo środowisko co start.** Plik silnika wybiera `resolveEngineBinary` (`runtime.claude.path`
   firmy albo bezwzględne elementy `PATH`, po `realpath`, kontrola właściciela i uprawnień); nie ma drugiego sposobu
   szukania. Każde polecenie dostaje środowisko z jednej funkcji rdzenia `buildEngineProbeEnv` (tylko `PATH` bez
   elementów względnych **i bez elementów w katalogu projektu**, żeby shim `#!/usr/bin/env node` nie dostał interpretera
   z repozytorium; `HOME`; `CLAUDE_CONFIG_DIR` wskazujący pusty katalog tymczasowy 0700, który jest też katalogiem
   roboczym; `DISABLE_AUTOUPDATER=1` i `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`), `shell: false`, limit czasu (5 s dla
   `--version`, 10 s dla pozostałych) i limit wyjścia (4 KiB i 256 KiB). Katalog projektu znają `launchPrepared` i
   `cwm engine` (bez projektu: bieżący katalog). Proces startuje w **własnej grupie procesów** (`detached`), a
   przekroczenie czasu lub rozmiaru oraz samo zakończenie procesu kończą całą grupę (`SIGKILL` na `-pid`), więc żaden
   wnuk (proces w tle skryptu powłoki) nie przeżywa próby. Po **dwóch przekroczeniach czasu** w jednym sprawdzeniu
   reszta poleceń nie jest uruchamiana (zawieszony silnik nie wstrzymuje startu o cztery timeouty). `queryEngineVersion` używa tej samej funkcji, więc `--version` ze startu i ze
   sprawdzenia nie mogą się rozjechać. Katalog próby jest usuwany po sprawdzeniu. CWM nie nawiązuje połączeń sieciowych
   (`denyNetwork`); to, co samo polecenie pomocy robi wewnątrz silnika, jest poza kontrolą CWM (próba na 2.1.322 i
   2.1.323 kończy się w kilkaset milisekund, ale to obserwacja, nie gwarancja).
3. **Ocena jest czystą funkcją rdzenia** (`evaluateEngineHelp`, `src/core/cwm/engine-check.ts`). Parser czyta flagi
   i podpolecenia tylko z wierszy definicji w sekcjach `Options:` i `Commands:` (wcięcie 2 spacje); opisy i ciągi
   dalsze mają większe wcięcie, więc wzmianka o `--settings` w opisie innej flagi nie liczy się jako flaga. Wynik:
   - **`missing-flags`:** którejś z flag z `REQUIRED_ENGINE_FLAGS` nie ma w pomocy. Lista to dokładnie flagi, które
     `buildEngineArgv` podaje silnikowi (`--settings`, `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`); test
     pilnuje, żeby lista i argv się nie rozjechały. To jedyny wynik, który blokuje start.
   - **`unverified`:** nie ma wersji, pomocy albo znanego układu pomocy (brak sekcji `Options:`), albo `--version` z
     sprawdzenia różni się od wersji ustalonej przed nim (podmiana pliku, aktualizacja w trakcie). Nie jest sukcesem i
     nie blokuje: CWM nie umie ocenić, więc ostrzega i nie zapisuje wyniku. **To jest świadome fail-open**: silnik, który
     nie da się sprawdzić (albo celowo psuje pomoc), uruchamia się z ostrzeżeniem; odmowa dotyczy tylko udowodnionego
     braku flagi.
   - **`ok`** z dopiskami. Nowe podpolecenia spoza `ENGINE_SUBCOMMANDS` to ostrzeżenie, bo `cwm start -- <podpolecenie>`
     jest blokowane tylko dla znanych. Nowe flagi spoza `MANAGED_FLAGS`, `REFUSED_FLAGS` i bazy `SUSPICIOUS_FLAG_BASELINE`
     o nazwie pasującej do `dangerous|permission|bypass|yolo|trust|allow|sandbox|add-dir|hook|config|setting|plugin|mcp|skip`
     to ostrzeżenie z nazwą flagi (CWM przekazuje je po `--` bez zmian). Wzorzec jest szeroki, więc baza zawiera flagi
     pasujące do niego, które są już w `--help` 2.1.322 i 2.1.323 (`--add-dir`, `--allowedTools`, `--allowed-tools`,
     `--disallowedTools`, `--disallowed-tools`, `--include-hook-events`, `--permission-mode`, `--permission-prompts`;
     wyprowadzona z zapisanego wyjścia `--help` obu wersji): ostrzega się tylko o nowych względem bazy. Flagi z obu list, których silnik już nie ma, to tylko informacja (`goneFlags`), bo silnik sam
     odrzuci taką flagę. Brak wyniku `plugin --help` lub `mcp --help` to też informacja: nie wpływa na wynik.
   Wzorzec łapie również nieszkodliwe flagi; to świadomie czuła heurystyka z ostrzeżeniem do przejrzenia, nie z
   odmową. Po sprawdzeniu nowej wersji, której nowe flagi okażą się nieszkodliwe, trzeba je dopisać do bazy.
4. **Zapis wyniku** w `~/.cwm/runtime/engine-checks.json` (wspólny dla firm). JSON `cwm.dev/v1`, `kind: EngineChecks`,
   klucze to wersje `x.y.z`; wpis ma `binary` (`path` po `realpath`, `size`, `mtimeMs` pliku silnika), `checkedAt`,
   skróty SHA-256 trzech tekstów pomocy (`--help`, `plugin --help`, `mcp --help`; `null`, gdy polecenie nie
   zadziałało) i listy `newSubcommands` oraz `suspiciousFlags` (żeby `cwm engine status` pokazywał to, co ostrzeżenie
   pokazało raz). Nie ma tam tekstu pomocy ani nazwy hosta; jest bezwzględna ścieżka pliku silnika. **Wynik wiąże się
   z plikiem:** ta sama wersja, ale inna ścieżka, rozmiar albo czas modyfikacji to stan `other-binary`, traktowany jak
   niesprawdzony (start sprawdza ponownie i nadpisuje wpis tej wersji; `diff`, `lock` i `--dry-run` ostrzegają).
   Tożsamość pliku jest brana przed sprawdzeniem; jeśli plik zmienił się w trakcie, wpisu nie ma. Wersja
   przetestowana (`EXPECTED_ENGINE_VERSION`) nie jest wiązana z plikiem. Zapis idzie przez `writeScopedFile` z
   `homeScope` (atomowo, `0600`, odmowa dla dowiązań, katalog `runtime` 0700), odczyt przez `readTextWithin` (limit
   64 KiB) i ścisły parser: obca wersja formatu, nieznane pole w dokumencie, zły skrót, ścieżka niebezwzględna lub ze
   znakami sterującymi, nazwa spoza wzorca albo ponad 32 wersje to błąd. Uszkodzony plik jest traktowany jak pusty (CWM
   sprawdza częściej, nie zawodzi); najstarsze wpisy ponad 32 wypadają. Zapisywane jest tylko sprawdzenie ze statusem
   `ok`. **To sprawdzenie zgodności z uczciwym dryfem (aktualizacja, inna wersja), a nie obrona przed wrogim plikiem
   silnika**: kto może podmienić plik i jego rozmiar oraz czas modyfikacji, a także wygenerować pasującą pomoc, obejdzie
   sprawdzenie. Obroną przed podmianą pliku pozostaje kontrola właściciela i uprawnień z `resolveEngineBinary`.
5. **Kiedy co się dzieje** (`src/cli/engine-flow.ts`):

   | Wersja silnika | `start`/`run` | `start --dry-run`, `run --dry-run`, `diff`, `lock` |
   |---|---|---|
   | równa `EXPECTED_ENGINE_VERSION` | bez ostrzeżenia i bez sprawdzenia | bez ostrzeżenia |
   | ma zapisane udane sprawdzenie tego samego pliku | bez ostrzeżenia |
   | ma zapisane sprawdzenie, ale dla innego pliku (`other-binary`) | jak niesprawdzona | bez ostrzeżenia |
   | inna, niesprawdzona | sprawdzenie samo (kilka sekund), zapis przy `ok`; `missing-flags` to odmowa kodem `1` przed pytaniami i zapisem profilu; `unverified` to ostrzeżenie (z podpowiedzią) i start idzie dalej, bez zapisu, więc następny start powtórzy sprawdzenie | tylko ostrzeżenie z podpowiedzią `cwm engine check`; nic nie jest uruchamiane ani zapisywane (poza `claude --version`, jak dotąd) |
   | nieustalona (`--version` nie działa) | dotychczasowe ostrzeżenie | bez zmian |

   Ostrzeżenia ze sprawdzenia (nowe podpolecenia, podejrzane flagi) są pokazane raz, przy sprawdzeniu, potem w
   `cwm engine status`. W `--dry-run --json` pole `engine.check` to `expected`, `checked` albo `unchecked`; w
   `lock --json` i `diff --json` ostrzeżenie jest w `warnings`.
6. **`cwm engine check [--project <katalog>] [--json]`** uruchamia sprawdzenie ręcznie (także dla wersji
   przetestowanej: pokazuje, co jest w pomocy, i zapisuje wynik). Kod `0` przy `ok`, `1` przy `missing-flags` albo
   `unverified`. **`cwm engine status`** pokazuje plik, wersję, stan (przetestowana, sprawdzona z datą i skrótem pomocy,
   niesprawdzona) i listę sprawdzonych wersji; tylko odczyt, kod `0`. Plik silnika: firma projektu (bieżący katalog i
   wyżej albo `--project`), a bez projektu `PATH`.
7. **Granice.** Sprawdzenie nie dowodzi, że silnik zachowuje się tak jak w 2.1.322: nie obejmuje kolejności hooków,
   pierwszeństwa `--mcp-config`, przeładowania ustawień, izolacji `CLAUDE_CONFIG_DIR` ani wstawek `!` (V-01 do V-08).
   Dowodzi tylko, że flagi, które CWM podaje, istnieją, i że lista podpolecen nie urosła bez wiedzy CWM. Nie wykrywa
   zmiany znaczenia istniejącej flagi.

## Wynik na prawdziwych binarkach

Tylko metadane, `CLAUDE_CONFIG_DIR` w pustym katalogu 0700, fałszywe `HOME` i `CWM_HOME`, bez sieci po stronie CWM.

| Wersja | Wynik | Uwagi |
|---|---|---|
| 2.1.322 | `ok` | wszystkie 4 flagi obecne, brak nowych podpolecen i podejrzanych flag, `plugin --help` i `mcp --help` zadziałały |
| 2.1.323 | `ok` | to samo; jedyna różnica w `--help` względem 2.1.322 to opis `rm <id>` |

## Konsekwencje i ryzyko szczątkowe

- **Pierwszy start po aktualizacji silnika trwa o kilka sekund dłużej** (cztery krótkie procesy). Nieudane
  sprawdzenie (`unverified`) nie jest zapisywane, więc ten koszt wraca przy każdym starcie, dopóki pomoc nie da się
  przeczytać; to świadomy wybór zamiast cichego uznania nieznanego silnika za sprawdzony.
- **Parser zależy od układu pomocy commandera** (wcięcia, sekcje `Options:` i `Commands:`). Zmiana układu daje
  `unverified` z ostrzeżeniem, nie fałszywy sukces ani odmowę; parser trzeba wtedy poprawić.
- **Lista `REQUIRED_ENGINE_FLAGS` musi nadążać za `buildEngineArgv`.** Dodanie nowej flagi do argv bez dopisania jej tu
  jest wychwytywane przez test (zbiór flag w argv musi równać się liście).
- **Lockfile bez zmian** (ADR 0051): wersja silnika w `cwm.lock` nadal tylko ostrzega. Sprawdzenie flag jest
  osobnym wymiarem: lockfile mówi "inny silnik niż poprzednio", sprawdzenie "ten silnik zna flagi CWM".
- **Fail-open dla `unverified`** (pkt 3): nieczytelna albo celowo zniekształcona pomoc nie blokuje startu. Blokada
  wymagałaby uznania parsera za nieomylny, a wtedy każda zmiana układu pomocy unieruchamiałaby wszystkich użytkowników.
- Wynik jest związany z plikiem przez ścieżkę, rozmiar i czas modyfikacji (pkt 4), co wykrywa uczciwy dryf, ale nie
  wrogi plik (zob. pkt 4).
- Sprawdzenie nie zastępuje ręcznego spike'a przy zmianie, która może dotyczyć zachowania (pkt 7). Podniesienie
  `EXPECTED_ENGINE_VERSION` nadal wymaga powtórzenia V-01 do V-08.

## Weryfikacja

Testy jednostkowe tylko w istniejących plikach: `tests/unit/cwm-engine-argv.test.ts` (parser pomocy, komplet flag,
brak flagi, nowe podpolecenie, nowa podejrzana flaga, zniknięta flaga z listy odmów, nieznany układ, brak wyniku
`plugin --help`, zgodność `REQUIRED_ENGINE_FLAGS` z argv), `tests/unit/cwm-approval-hash.test.ts` (plik wyników:
determinizm, odrzucenia, limit wersji, stan wersji), `tests/unit/cwm-child-env.test.ts` (środowisko próby; atrapa
silnika: brak sekretów, katalog roboczy, kod wyjścia, limit rozmiaru i czasu, cztery polecenia, sprzątanie, zapis
0600, dowiązanie), `tests/unit/cwm-cleanup-paths.test.ts` (plik wyników nie jest ścieżką profilu),
`tests/unit/cwm-settings-env-secrets.test.ts` (dokument bez tekstu pomocy).
Ręcznie, z fałszywymi `HOME`, `CWM_HOME` i `TMPDIR` oraz atrapą `claude` z konfigurowalną wersją i pomocą: wersja
przetestowana bez sprawdzenia; nowa wersja sprawdzona i zapisana przy starcie, drugi start bez ostrzeżenia i bez
ponownego sprawdzenia; `--dry-run`, `diff` i `lock` ostrzegają i niczego nie zapisują; brak flagi odmawia, silnik się
nie uruchamia i nic nie jest zapisane; nowe podpolecenie i podejrzana flaga ostrzegają; nieznany układ pomocy
ostrzega bez zapisu; `cwm engine check|status` (tekst i `--json`); odczyt na prawdziwych binarkach 2.1.322 i 2.1.323.
Po przeglądzie bezpieczeństwa (SEC-E1 do SEC-E7) dodatkowo: `PATH` próby bez katalogu projektu, wiązanie wyniku z plikiem
(zmiana rozmiaru lub mtime atrapy wymusza ponowne sprawdzenie), grupa procesów (atrapa ze śpiącym wnukiem: żaden wnuk
nie przeżywa przy zakończeniu, przekroczeniu czasu i przepełnieniu), limit dwóch timeoutów, baza flag, równość wersji. Te ręczne
sprawdzenia robiono wyłącznie na atrapach; prawdziwych binarek nie uruchamiano ponownie.
