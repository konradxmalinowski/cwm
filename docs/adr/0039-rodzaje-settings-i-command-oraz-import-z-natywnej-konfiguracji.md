# ADR 0039: Rodzaje Settings i Command oraz import z natywnej konfiguracji

Status: zaakceptowane (decyzje właściciela produktu, 2026-11-12)
Data: 2026-11-12
Dotyczy: ADR 0012 (WriteGate jako jedyna droga zapisu), ADR 0020 (brak automatycznej synchronizacji MCP), ADR 0036 (zachowanie Claude Code), ADR 0037 (model zasobów i resolver), ADR 0038 (fundament CLI)
Źródło: plan etapów, model zagrożeń i wyniki weryfikacji silnika z 2026-11-12 (pliki w `plans/`, lokalne, poza repozytorium); kod w `src/core/cwm`, `src/infra/cwm/import-*.ts`, `src/infra/cwm/hook-pins.ts`, `src/cli/commands/import.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

ADR 0038 dał CLI, które czyta `~/.cwm`, ale rejestr zasobów trzeba było wypełniać ręcznie
napisanymi manifestami. Prawdziwa konfiguracja użytkownika leży w natywnym katalogu Claude Code
(`~/.claude`): skille, agenci, komendy i `settings.json` z hookami, uprawnieniami i zmiennymi
środowiska. Ten katalog jest niezaufanym wejściem. Skille bywają dowiązaniami do cudzych
repozytoriów, katalog skilla może zawierać `.env` albo klucz, frontmatter agenta może uruchamiać
kod (`hooks`, `mcpServers`), a hook wskazuje skrypt, który zmienia się bez zmiany polecenia.
Import jest więc granicą zaufania (G1 w modelu zagrożeń: natywny katalog konfiguracji -> rejestr
`~/.cwm`), a nie zwykłym kopiowaniem plików.

Prace są podzielone na dwa etapy, każdy z własnym PR. **Etap A** (ten ADR, gałąź `feat/cwm-start`):
rodzaje zasobów `Settings` i `Command` oraz `cwm import claude`. **Etap B** (osobny ADR):
zatwierdzanie, profil Claude Code, `cwm start`. Etap A nie uruchamia silnika, niczego nie
generuje do konfiguracji silnika i nie zapisuje w `.claude/`, `CLAUDE.md` ani `.mcp.json`.
Czyta natywny katalog tylko do odczytu, a zapisuje wyłącznie w `~/.cwm`.

## Decyzje właściciela (2026-11-12)

1. **`Settings` jako rozszerzenie specyfikacji.** Nowy rodzaj zasobu niesie hooki, uprawnienia i
   zmienne środowiska, w kształcie zbliżonym do natywnego `settings.json`. Obok niego powstaje
   rodzaj `Command` (plik `.md` z `commands/`). Oba wykraczają poza pięć rodzajów z sekcji 5
   specyfikacji.
2. **Import w tym kroku.** `cwm import claude` kopiuje skille, agentów, komendy i ustawienia z
   natywnego katalogu do rejestru. Biblioteka aplikacji desktopowej nadal nie jest źródłem.
3. **Testy: wyjątek od "żadnych testów".** Obowiązuje decyzja z ADR 0037 i 0038 (testy pominięte),
   z wyjątkiem pięciu czystych funkcji, których błąd usuwa dane albo decyduje o wykonaniu kodu:
   skrót zatwierdzenia z kanonizacją, walidacja ścieżek przy sprzątaniu profilu, budowa
   środowiska procesu, budowa argumentów silnika i wykrywanie sekretów w `env`. W Etapie A
   dotyczy to ostatniej: `tests/unit/cwm-settings-env-secrets.test.ts` (wykrywanie sekretów w
   `env`, konwersja natywnych ustawień, ścieżki hooków, wykrywanie flag treści). Pozostałe cztery
   funkcje należą do Etapu B. Reszta kodu Etapu A jest bez testów.

## Rozważane opcje

**Dowiązania w `skills/` jako źródło.** Skille w natywnym katalogu bywają dowiązaniami do
repozytoriów, także innych firm. Dowiązanie wciągnęłoby treść innej firmy do rejestru, a po
imporcie do `global` do profilu każdej firmy. Odrzucone: dowiązania są pomijane i zgłaszane.
Opcja `--follow-links` (z `realpath`, listą zakazanych katalogów i kopią zamiast dowiązania) jest
odłożona i nie istnieje.

**Surowa kopia frontmattera agenta, skilla i komendy.** Odrzucone: frontmatter może wykonywać kod.
Plik w rejestrze jest odtwarzany z dozwolonych kluczy, nigdy kopiowany bajt w bajt (pkt 5).

**Domyślna przestrzeń `global`.** Odrzucone: udostępniałaby zasób jednej firmy wszystkim
pozostałym. Przestrzeń trzeba wskazać (pkt 3).

**Kopiowanie skryptów hooków do rejestru.** Dopiero wtedy zatwierdzenie obejmowałoby to, co
faktycznie się wykona. Odłożone: w Etapie A skrypty są tylko wykrywane i przypinane skrótem (pkt 7).

## Decyzja

### 1. Rodzaje zasobów

- **`Settings`** (`src/core/cwm/settings-spec.ts`): `spec.hooks` (mapa zdarzenie -> lista grup
  `{ matcher?, hooks: [{ type: command, command, timeout? }] }`), `spec.permissions`
  (`allow`, `deny`, `ask`, `defaultMode`, `additionalDirectories`), `spec.env` (nazwa ->
  `{ envRef }` albo `{ value }`) i `spec.enforce` (domyślnie `false`). Wartość `enforce` jest
  zapisywana i scalana; zdecyduje o pliku docelowym (`--settings` albo `settings.json` profilu)
  w Etapie B.
- **`Command`**: `spec.source` (plik `.md`) i opcjonalne `spec.contentFlags`. Jak `Skill` bez
  zależności i bez ograniczeń silnika.
- **`contentFlags`** (`allowedTools`, `inlineCommands`) mogą mieć `Skill`, `Agent` i `Command`.
  Import zapisuje je jako informację, że treść ma pola wykonawcze. Tylko informację: patrz
  "Etap B".
- Zbiory zasobów (`global.resources.mandatory|optional`, `company.resources.enable|disableOptional`,
  `exports`, projekt) dostają klucze `commands` i `settings`. Wynik `resolve` ma listy
  `resolved.settings` i `resolved.commands`.
- **Scalanie wielu `Settings`** (`merge-settings.ts`): kolejność warstw global, firma, projekt, w
  warstwie po id zasobu. Hooki są konkatenowane, listy uprawnień sumowane i sortowane. Ta sama
  zmienna `env` albo `defaultMode` o różnych wartościach to błąd resolvera (komunikat nie cytuje
  wartości); identyczne duplikaty nie są konfliktem. Zasoby z `enforce: true` i `false` są
  scalane osobno, a rozbieżność tej samej zmiennej albo trybu między nimi też jest błędem.
  Wynik scalania jest polem wewnętrznym `EffectiveConfiguration.settings`; `cwm resolve` pokazuje
  tylko id zasobów.

### 2. Układ w rejestrze

`registry/{skills,agents,commands,settings}/<przestrzeń>/<nazwa>/` albo
`companies/<firma>/{skills,agents,commands,settings}/<nazwa>/`. Plik definicji to `skill.yaml`,
`agent.yaml`, `command.yaml`, `settings.yaml`; pliki źródłowe to `SKILL.md`, `AGENT.md`,
`COMMAND.md`. Ustawienia z jednego `settings.json` stają się jednym zasobem `<przestrzeń>/claude-settings`.
Importowane zasoby dostają wersję `0.1.0` (natywna konfiguracja nie ma wersji). Import niczego nie
włącza: id trzeba dopisać do `resources.optional` w `config.yaml` albo do `resources.enable` w
`company.yaml`. Kopia przechodzi przez `replaceScopedTree` (`writer.ts`): zapis do katalogu
tymczasowego, zamiana katalogów, jedna kopia poprzedniej wersji obok jako `.<nazwa>.old-*`.

### 3. Wybór przestrzeni nazw (IMP-11)

`--company <id>` (firma musi istnieć) albo `--global` (id `global/<nazwa>`), nigdy oba. Bez
terminala brak obu opcji to błąd użycia (kod `2`), także przy `--dry-run`. Na terminalu `cwm`
pyta, z firmą jako pierwszą opcją.

### 4. Co z modelu zagrożeń jest zaimplementowane

| Wymaganie | Jak działa |
|---|---|
| IMP-01 dowiązania | Dowiązanie na `skills/`, `agents/`, `commands/`, `settings.json`, na wpisie albo wewnątrz drzewa skilla jest pomijane i zgłaszane. Ścieżka po `realpath` musi leżeć pod `realpath` katalogu `--from`. Do rejestru trafia kopia. Pochodzenie: pkt 8 |
| IMP-02 lista dozwolona | Czytane są tylko `skills/*/`, `agents/*.md`, `commands/*.md` i `settings.json`. Nic innego z `--from` nie jest otwierane (`.credentials.json`, `.claude.json`, `projects/`, `history.jsonl`, `plugins/`, `settings.local.json` i reszta). `skills/synced` (skille z konta claude.ai) jest pomijane. `--from` w katalogu danych CWM albo nim będący to błąd |
| IMP-03 sekrety w plikach | Każdy plik skilla przechodzi `classifyFileName` i `classifyStrict`; trafienie pomija plik, a raport podaje powód i numer wiersza, bez wartości. Trafienie w `SKILL.md` pomija cały skill. `.git` i `node_modules` zawsze pomijane |
| IMP-04 frontmatter | Tylko na początku pliku (BOM dozwolony), do 64 Ki znaków, ten sam parser YAML co manifesty. Lista dozwolonych kluczy per rodzaj; reszta idzie do raportu (nazwy, bez wartości). Klucze `__proto__`, `constructor`, `prototype` w YAML i w JSON odrzucają zasób. Mapy bez prototypu |
| IMP-05 treść wykonująca | Klucze `hooks`, `mcpServers`, `permissionMode` (także w wariantach zapisu: wielkość liter, `_`, `-`) odrzucają cały zasób z raportem. `allowed-tools`, `tools` i wstawki `` !`...` `` oraz bloki ```` ```! ```` ustawiają `contentFlags` i są widoczne w planie. Plik w rejestrze powstaje z dozwolonych kluczy, treść bez zmian |
| IMP-06 klucze `settings.json` | Przyjmowane są tylko `hooks`, `permissions`, `env`. `apiKeyHelper`, `statusLine`, `otelHeadersHelper`, `enabledPlugins`, `extraKnownMarketplaces`, `awsAuthRefresh`, `awsCredentialExport`, `fileSuggestion` są pomijane z raportem, a walidator `Settings` odrzuca je też w ręcznym manifeście |
| IMP-07 sekrety w `env` | Pkt 6 |
| IMP-08 skrypty hooków | Pkt 7 |
| IMP-09 limity | Pkt 9 |
| IMP-10 nazwy | NFC, małe litery, znaki spoza `[a-z0-9._-]` zamienione na `-`, kolizje po normalizacji (także same wielkości liter) pomijają wszystkie strony kolizji. Nazwa `synced` zarezerwowana. Ta sama nazwa w dwóch rodzajach daje uwagę w raporcie (nie włączaj ich razem) |
| IMP-11 przestrzeń | Pkt 3 |
| IMP-12 import niczego nie uruchamia | Reguła lintu dla `src/infra/cwm/import*.ts` i `hook-pins*.ts`: zakaz importu procesów, wątków i `module` (także przez `require` i `import()`) oraz funkcji zapisu z `fs`. Próby naruszeń są w `scripts/verify-boundaries.mjs`. Zapis idzie tylko przez `writer.ts` |
| SET-03 hooki | Tylko `type: command`. `http`, `prompt`, `agent` są błędem (hook `http` wysyła zdarzenia sesji pod wskazany adres). `command` do 4096 znaków, bez znaków sterujących i formatujących (także nowej linii), bez sekretu; `timeout` 1 do 600 s; do 64 zdarzeń; nieznane pola są błędem |
| SET-04 polityka `env` | Pkt 6 |
| MCP-01 `$` w MCP | Walidator MCP odrzuca `$` w `command`, `args` i `url`, bo silnik rozwija `${...}`, co mogłoby wynieść sekret niezadeklarowany jako `envRef`. Jedyne `${...}` w przyszłym `mcp.json` wpisze generator z `envRef` (Etap B) |

### 5. Co jest świadomie odrzucane

- Klucze frontmattera `hooks`, `mcpServers`, `permissionMode` w agentach, skillach i komendach.
  Wynik weryfikacji V-08 (dodatek do ADR 0036): `hooks` i `mcpServers` agenta poziomu user działają
  w 2.1.322, a serwer z `mcpServers` startuje bez żadnej zgody silnika. Silnik o nic nie zapyta, więc
  to CWM musi je odrzucić.
- Typy hooków inne niż `command`.
- Zmienne `env` sterujące silnikiem lub procesem: lista `MCP_ENV_DENYLIST` (m.in. `PATH`,
  `NODE_OPTIONS`, `LD_*`, `*_PROXY`) plus `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`,
  `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `CLAUDE_CODE_SHELL_PREFIX`, `CLAUDE_CODE_SHELL`,
  `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_ENV_FILE`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `*_BASE_URL`, `OTEL_EXPORTER_OTLP_*`,
  `OTEL_*_HEADERS`. Zatwierdzenie tu nie wystarcza: `ANTHROPIC_BASE_URL` przekierowuje cały ruch
  razem z tokenem logowania.
- Klucze `settings.json` spoza `hooks`, `permissions`, `env` (raport: "poza zakresem importu") i
  osiem kluczy z pkt 4 (raport: "zabroniony").
- Dowiązania symboliczne (pkt 4) oraz skille z `skills/synced`.

### 6. Sekrety

- **`envRef` zamiast wartości.** Wartość `env` trafia do manifestu jako `value` tylko wtedy, gdy
  nazwa nie wygląda na sekret i wartość nie wygląda na sekret. W każdym innym przypadku powstaje
  `envRef` o tej samej nazwie, a raport wymienia nazwę zmiennej do uzupełnienia w środowisku.
  Nazwę uznajemy za sekretną po fragmencie (bez rozróżniania wielkości liter): `TOKEN`, `SECRET`,
  `KEY`, `PASS`, `PWD`, `CRED`, `AUTH`, `PAT`, `PRIVATE`, `DSN`, `COOKIE`, `SESSION`, `BEARER`,
  `WEBHOOK`, `SIGNING`, `SIGNATURE`, `CERT` oraz `PW` jako cały segment. Lista jest szersza niż w
  modelu zagrożeń i daje fałszywe trafienia (`KEYBOARD_LAYOUT`, `PATH_HINT`), które kończą się
  wymaganiem `envRef`, a nie utratą danych. Wartość: znane prefiksy (`sk-`, `ghp_`, `github_pat_`,
  `glpat-`, `xox?-`, `AKIA`/`ASIA`, `AIza`, `ya29.`, JWT, `-----BEGIN`, adres z hasłem, także po
  dekodowaniu procentowym), przypisania typu `token=`, długie ciągi o wysokiej entropii oraz
  `looksLikeSecretValue`.
- **Sekret w poleceniu hooka lub regule uprawnień** pomija cały zasób `Settings`, nie tylko ten
  wpis: nie ma bezpiecznego sposobu na częściowy import polityki. Sekret w ręcznym manifeście
  odrzuca walidator.
- **Wartości nie wychodzą na wyjście.** Plan, raport, `--json`, komunikaty błędów walidacji i
  porównanie przy ponownym imporcie zawierają nazwy zmiennych i sekcji, nigdy wartości. Plan
  zmienionych `Settings` mówi tylko, które sekcje się zmieniły (`hooks`, `permissions`, `env`,
  `enforce`). Wartości `value` niebędące sekretami trafiają do manifestu w rejestrze.
- `envRef` z `Settings` ma być materializowane wyłącznie w środowisku procesu potomnego (SET-02),
  nigdy w pliku, logu ani podglądzie. To wymaganie dla Etapu B; Etap A tylko zapisuje `envRef`.

### 7. Skrypty hooków (IMP-08, część obowiązkowa)

Z poleceń przyjętych hooków wydobywane są tokeny ścieżek: bezwzględne, `~/`, `$HOME/`, `${HOME}/`
(`hook-paths.ts`, heurystyka, nie parser powłoki; do 32 ścieżek na polecenie). Każda istniejąca
ścieżka do zwykłego pliku poniżej 1 MiB (nie dowiązania) dostaje `sha256` treści (`hook-pins.ts`,
do 200 ścieżek na import). Co nie da się przypiąć (zmienna, ścieżka względna, brak pliku, katalog,
dowiązanie, plik za duży, błąd odczytu), raport oznacza jako "nieprzypięte: zatwierdzasz ścieżkę,
nie treść". Ścieżki ponad limity są tylko liczone w raporcie. Skrót jest pokazany w raporcie
importu (12 pierwszych znaków) i **nie jest zapisywany w manifeście**. Kopiowanie skryptów do
rejestru z przepisaniem polecenia na znacznik jest odłożone.

### 8. Pochodzenie

Plan importu (tekst i `--json`) podaje dla każdego zasobu ścieżkę źródła po `realpath` i `sha256`
kopiowanego drzewa (ścieżka, bit wykonywania i skrót treści każdego pliku; dla `Settings` skrót
bajtów `settings.json`). Pochodzenie jest tylko w wyjściu polecenia, nie w rejestrze.

### 9. Limity

Plik do 1 MiB. Skill do 500 plików, 10 MiB i 16 poziomów głębokości; przekroczenie pomija skill z
raportem. Cały import do 20 000 plików, 5000 przeglądanych katalogów i 256 MiB treści (dwa
ostatnie limity są dodatkiem do modelu zagrożeń, bo treść jest trzymana w pamięci od skanu do
zapisu); przekroczenie przerywa cały import (kod `1`). Katalog z ponad 5000 wpisami pomija skill,
gdy jest w drzewie skilla, a na poziomie `skills/`, `agents/` i `commands/` pomija nadmiarowe wpisy
z raportem. Kopiowane są tylko zwykłe pliki; plik z bitem wykonywania właściciela dostaje tryb 0700,
pozostałe 0600, nigdy setuid, setgid ani sticky. Dwa pliki skilla różniące się tylko wielkością
liter pomijają skill. Pliki o nazwach, które CWM tworzy w katalogu zasobu (`skill.yaml`,
`agent.yaml`, `command.yaml`, `settings.yaml`, `agent.md`, `command.md`), nie są kopiowane.

### 10. Zatwierdzanie importu i brak terminala

Plan jest budowany w pamięci i niczego nie zapisuje. Zapis wymaga potwierdzenia na terminalu
(domyślna odpowiedź to "nie") i idzie z tego planu, nie z ponownego odczytu źródła. Bez terminala
(`--json`, `--no-input` albo brak TTY) import niczego nie zapisuje: wypisuje plan i kończy się
kodem `1`; nie ma opcji `--yes`. Wyjątkiem jest plan bez zmian do zapisania (kod `0`). `--dry-run`
pokazuje plan i kończy się kodem `0`. Błąd zapisu jednego zasobu nie przerywa reszty; polecenie
kończy się wtedy kodem `1`.

### 11. Znane fałszywe trafienia reguły liniowej

`classifyStrict` (`secret-classifier.ts`) dokłada do `classifySecrets` regułę `STRICT_LINE_RULE`:
słowo `password`, `passwd`, `secret`, `api_key` (także `api-key`, `apikey`), `token` albo
`aws_secret_access_key`, opcjonalne spacje, `:` lub `=`, opcjonalne spacje i co najmniej 4 znaki
niebędące białymi. Reguła ignoruje wielkość liter, nie ma granicy słowa po lewej i celowo łapie
też placeholdery, bo przeoczenie kosztuje więcej niż nadmiar trafień. Skutki, sprawdzone na
fixture'ach `acme-*`:

- Skill, którego `SKILL.md` zawiera zdanie `Enter the password: xyz1 in the form`, jest pomijany
  w całości, tak samo `max_token: 4096` i `api_key: ${ACME_KEY}`.
- Nie trafia `password: xyz` (wartość krótsza niż 4 znaki) ani `tokens: 4096` (liczba mnoga).
- Reguła działa także na plikach binarnych (cały plik jako jeden ciąg w kodowaniu latin1).
- Trafienie w pliku pomocniczym pomija tylko ten plik, a skill jest importowany bez niego. Skill
  może wtedy nie działać; raport o tym informuje, ale import nie ostrzega osobno.

Obejście: zmienić sformułowanie w źródle tak, by po nazwie i znaku `:` lub `=` nie następował ciąg
co najmniej 4 znaków, albo dodać zasób do rejestru ręcznie. Opcji wyłączającej regułę nie ma. `classifySecrets` używane przez aplikację desktopową nie zmieniło się; zmiana dotyczy tam
tylko nazw plików (CHANGELOG).

## Etap B: czego nie wolno przyjąć z importu na wiarę

1. **`contentFlags` w manifeście to podpowiedź, nie dowód.** Ktoś może zmienić plik `SKILL.md`,
   `AGENT.md` albo `COMMAND.md` w rejestrze po imporcie albo wpisać manifest ręcznie bez flag.
   Zatwierdzanie ma przeliczyć flagi z pliku źródłowego (`analyzeContent`, `hasInlineCommands`
   z `src/core/cwm/content.ts`) przy każdym liczeniu skrótu i włączyć do niego `sha256` treści
   pliku, `tools` / `allowed-tools` i `model` (`EXECUTION_RELEVANT_FIELDS`).
2. **Skróty skryptów hooków trzeba policzyć od nowa.** Manifest nie ma pinów. Ten sam kod
   (`pinHookCommands`) ma liczyć skróty przy zatwierdzaniu i tuż przed uruchomieniem, a skrypty
   nieprzypięte pokazywać z etykietą z pkt 7. Kolejność z modelu zagrożeń: plan w pamięci, skrót,
   zatwierdzenie, zapis tych bajtów, weryfikacja, uruchomienie.
3. **Pola wykonawcze `Settings` wchodzą do skrótu w całości**: `hooks` (zdarzenie, `matcher`,
   `command`, `timeout`, kolejność), `permissions` (w tym samo `allow` i `defaultMode`), cały
   `env`, `enforce` i skróty skryptów. `defaultMode: bypassPermissions` walidator dopuszcza;
   ostrzeżenie w ekranie zatwierdzania to zadanie Etapu B.
4. **`enforce: true` z hookami** wymaga jawnego `disableAllHooks: false` w pliku `--settings` i
   komunikatu "włącza hooki projektu" (V-05, dodatek do ADR 0036). Hooki są addytywne, równoległe
   i bez kolejności (V-01), a plik `--settings` jest czytany raz, w przeciwieństwie do
   `settings.json` profilu (V-03).
5. **Nazwy w profilu: wariant mieszany** (decyzja właściciela z 2026-11-12): zasoby `mandatory`
   w pluginie CWM przez `--plugin-dir` z prefiksem, `optional` pod zwykłymi nazwami, serwery MCP
   zawsze z prefiksem `cwm-<firma>-`. To odstępstwo od ADR 0036 (decyzja 2) opisze ADR Etapu B.
6. **Reszta wniosków z V-01 do V-08** (jeden plik `--settings`, kolejność argumentów przy
   `--mcp-config`, izolacja przez `CLAUDE_CONFIG_DIR`, `--strict-mcp-config`) jest w dodatku do
   ADR 0036.

## Konsekwencje

**Czego nie ma.** `--follow-links`, kopiowania skryptów hooków do rejestru, zapisu pochodzenia w
rejestrze, importu `.mcp.json` i pluginów, importu biblioteki aplikacji, zatwierdzania, profilu i
`cwm start` (Etap B). Zasoby po imporcie są nieaktywne, dopóki użytkownik ich nie włączy.

**Testy.** Zgodnie z decyzją właściciela (pkt 3 wyżej) tylko wykrywanie sekretów w `env` i
pokrewne funkcje czyste mają testy jednostkowe. Resztę sprawdzono czytaniem kodu oraz ręcznie na
katalogu tymczasowym z fixture'ami `acme-*`: plan i raport (`--dry-run`), ścieżki błędów z
kodami wyjścia, zapis drzewa i ponowny plan ("bez zmian"), `cwm doctor` i `cwm resolve` na
zaimportowanych zasobach oraz przykłady manifestów z `docs/CLI.md`. Nie sprawdzono ręcznie
potwierdzenia zapisu na terminalu ani Windowsa (tryby 0700 i 0600 dotyczą POSIX).

**Znane ograniczenia.**

- Wykrywanie sekretów jest heurystyczne. Sekret, który nie pasuje do żadnego wzorca, trafi do
  rejestru (tryb 0600 i 0700 chroni go przed innymi użytkownikami systemu, nie przed procesem tego
  samego użytkownika, który jest poza modelem zagrożeń).
- Parsowanie poleceń hooków to heurystyka. Skrypt wywoływany przez interpreter z argumentem
  wyliczanym albo przez `$CLAUDE_PROJECT_DIR` pozostaje nieprzypięty.
- Między skanem a zapisem źródło może się zmienić; zapis idzie z planu, który użytkownik widział,
  ale plan nie chroni przed zmianą skryptu hooka, który leży poza `--from`.
- Hook z `enforce: false` trafia w Etapie B do `settings.json` profilu, który silnik przeładowuje
  na żywo (V-03), więc zapis tego pliku przy działającej sesji zmienia jej zachowanie.
- Raport tekstowy pokazuje 40 wpisów; pełna lista jest w `--json`.
