# CLI `cwm`

last_updated: 2026-11-12

`cwm` zakłada i sprawdza dane CWM w `~/.cwm`: firmy, projekty i zasoby (skille, agenci, workflowy,
pluginy, serwery MCP). Składa też z nich konfigurację projektu. To fundament: polecenie nie
uruchamia silnika, nie synchronizuje i niczego nie zapisuje w `.claude/`, `CLAUDE.md` ani
`.mcp.json`. Decyzje i ograniczenia: [ADR 0038](adr/0038-fundament-cli-cwm.md). Model manifestów:
[ADR 0037](adr/0037-model-zasobow-i-resolver-warstwy-cwm.md).

Stan: gałąź `feat/cwm-cli`, niescalona do `main`.

## Uruchomienie ze źródeł

Wymagany jest Node 24 lub nowszy (`engines` w `package.json`).

```sh
npm ci
npm run build
node dist/cli/index.js --help
```

`npm run build` buduje całą aplikację. Samo CLI buduje `npm run build:main`. Żeby mieć polecenie
`cwm` w `PATH`, uruchom raz `npm link` w katalogu repozytorium; wpis `bin` wskazuje na
`dist/cli/index.js`. Po zmianie kodu zbuduj ponownie.

## Katalog danych: `CWM_HOME`

Dane leżą w `~/.cwm`. Zmienna `CWM_HOME` nadpisuje ten katalog. Musi być ścieżką bezwzględną i nie
może leżeć w `.claude`, `CLAUDE.md` ani `.mcp.json` (żaden segment ścieżki). Inaczej polecenie
kończy się kodem `2`.

```sh
export CWM_HOME=/home/user/cwm-test
cwm init
```

## Układ `~/.cwm`

```text
~/.cwm/
  config.yaml                     konfiguracja globalna (tworzy ją `cwm init`)
  registry/                       zasoby wspólne
    skills/<przestrzeń>/<nazwa>/skill.yaml
    agents/<przestrzeń>/<nazwa>/agent.yaml
    workflows/<przestrzeń>/<nazwa>/workflow.yaml
    plugins/<przestrzeń>/<nazwa>/plugin.yaml
    mcp/<przestrzeń>/<nazwa>/mcp.yaml
  companies/
    <firma>/
      company.yaml                manifest firmy
      skills/<nazwa>/skill.yaml   zasoby firmy (id: <firma>/<nazwa>)
      agents/<nazwa>/agent.yaml
      workflows/<nazwa>/workflow.yaml
      projects/<id>.yaml          manifesty projektów z `--store home`
  sources/  cache/  locks/  runtime/   zarezerwowane, na razie puste
```

Katalog zasobu zawiera plik definicji i pliki, na które wskazuje `spec.source` (np. `SKILL.md`).
Id zasobu musi zgadzać się z położeniem: `registry/skills/global/code-review/` to
`global/code-review`, a `companies/acme-a/skills/coding-standards/` to `acme-a/coding-standards`.
Zasób w katalogu firmy z id spoza jej przestrzeni nazw jest pomijany z komunikatem. Przestrzenie
`global`, `marketplace`, `local` i `git` są wspólne i nie mogą być nazwą firmy.

Id firmy i projektu: małe litery, cyfry i `-`, od litery lub cyfry, do 63 znaków. Katalogi i pliki
zaczynające się od `.` są pomijane przy odczycie, a dowiązania symboliczne odrzucane.

## Przykładowe manifesty

Przykłady (poza skróconym projektem w `~/.cwm`) przechodzą `cwm doctor`. Nieznane pole w
manifeście jest błędem.

`~/.cwm/config.yaml` (tworzy go `cwm init`):

```yaml
apiVersion: cwm.dev/v1
kind: GlobalConfig
defaults:
  engine: claude-code
  projectMode: clean
  workflowSelection: automatic
resources:
  mandatory:
    skills: []
    agents: []
  optional:
    skills: []
    agents: []
runtime:
  separateCompanyConfigs: true
  preserveNativeConfiguration: true
  overwriteNativeFiles: false
```

`~/.cwm/companies/acme-a/company.yaml`:

```yaml
apiVersion: cwm.dev/v1
kind: Company
metadata:
  id: acme-a
  name: Acme A
resources:
  enable:
    skills: [acme-a/coding-standards, global/code-review]
    agents: [global/reviewer]
    workflows: []
  disableOptional:
    skills: []
    agents: []
    workflows: []
plugins:
  enable: [marketplace/acme-lint]
  forbid: []
mcp:
  enable: [global/acme-docs]
instructions:
  file: CLAUDE.md
exports:
  skills: []
  agents: []
  workflows: []
  plugins: []
  mcp: []
```

Projekt z manifestem lokalnym, `<projekt>/.cwm/project.yaml`:

```yaml
apiVersion: cwm.dev/v1
kind: Project
metadata:
  id: acme-web
  company: acme-a
spec:
  engine: claude-code
  resources:
    enable:
      skills: []
      agents: []
      workflows: []
    disableOptional:
      skills: []
      agents: []
  plugins:
    enable: []
    disable: []
  mcp:
    enable: []
    disable: []
  workflows:
    selection: automatic
  native:
    preserve: true
```

Projekt z manifestem w `~/.cwm`, `companies/acme-a/projects/acme-legacy.yaml`. Różni się od
lokalnego tylko polem `metadata.path`, które musi być ścieżką bezwzględną do istniejącego katalogu
spoza `~/.cwm`. Nazwa pliku musi być równa `metadata.id` plus `.yaml`.

```yaml
apiVersion: cwm.dev/v1
kind: Project
metadata:
  id: acme-legacy
  company: acme-a
  path: /home/user/work/legacy
spec:
  engine: claude-code
  # reszta jak w projekcie lokalnym
```

Po jednym zasobie każdego rodzaju. `metadata.id` ma postać `<przestrzeń>/<nazwa>`, a `version` to
`MAJOR.MINOR.PATCH` (dla MCP jest opcjonalna).

`registry/skills/global/code-review/skill.yaml`:

```yaml
apiVersion: cwm.dev/v1
kind: Skill
metadata:
  id: global/code-review
  version: 1.0.0
spec:
  source: SKILL.md
  visibility: shared
  compatibility:
    engines: [claude-code]
```

`registry/agents/global/reviewer/agent.yaml`:

```yaml
apiVersion: cwm.dev/v1
kind: Agent
metadata:
  id: global/reviewer
  version: 1.0.0
spec:
  source: agent.md
  skills:
    shared: [global/code-review]
  tools: [Read, Grep]
  model: inherit
```

`registry/workflows/global/review-flow/workflow.yaml` (typ `orchestrated` wymaga kroków, typ
`instructional` ich zabrania):

```yaml
apiVersion: cwm.dev/v1
kind: Workflow
metadata:
  id: global/review-flow
  version: 1.0.0
spec:
  type: orchestrated
  source: workflow.md
  routing:
    mode: review
    priority: 10
    keywords: [review]
  agents: [global/reviewer]
  steps:
    - id: review
      agent: global/reviewer
```

`registry/plugins/marketplace/acme-lint/plugin.yaml`:

```yaml
apiVersion: cwm.dev/v1
kind: Plugin
metadata:
  id: marketplace/acme-lint
  version: 0.3.1
spec:
  source:
    type: marketplace
    marketplace: acme-market
    plugin: acme-lint
  activation:
    default: disabled
```

`registry/mcp/global/acme-docs/mcp.yaml`. Sekretów nie wpisuje się wprost: zmienna środowiskowa
to odwołanie `envRef`. Transport `stdio` wymaga `command` (jeden plik wykonywalny, bez spacji) i
zabrania `url`; `http` i `sse` odwrotnie.

```yaml
apiVersion: cwm.dev/v1
kind: MCP
metadata:
  id: global/acme-docs
spec:
  transport: stdio
  command: acme-docs-server
  args: [--readonly]
  env:
    ACME_DOCS_TOKEN:
      envRef: ACME_DOCS_TOKEN
```

Manifest jest czytany jako YAML 1.2 bez aliasów, jawnych znaczników i dat, do 256 Ki znaków
(limit odczytu to 768 KiB) i tylko jako poprawny UTF-8 z pliku regularnego.

## Opcje wspólne

| Opcja | Znaczenie |
|---|---|
| `--json` | wynik w JSON na stdout, bez pytań interaktywnych |
| `--no-input` | bez pytań; brakująca wartość jest błędem użycia (kod `2`) |
| `-V`, `--version` | wersja z `package.json` |
| `-h`, `--help` | pomoc (działa też przy każdym podpoleceniu) |

Pytania na terminalu pojawiają się tylko wtedy, gdy stdin i stdout są terminalem i nie podano
`--json` ani `--no-input`. W `--json` błąd ma postać `{"ok": false, "error": "..."}` (`resolve` podaje
`errors`, a `doctor` `errors` i `warnings`).

Tekst z dysku (nazwy plików, klucze, komunikaty) jest przed wypisaniem czyszczony: znaki
sterujące i niewidoczne znaki formatujące Unicode wychodzą jako `\xNN` albo `\uNNNN`. Nowa linia
i tabulator zostają.

## Kody wyjścia

| Kod | Znaczenie |
|---|---|
| `0` | sukces; także `-h` i `-V` |
| `1` | błąd walidacji, polityki albo stanu na dysku (brak `cwm init`, firma już istnieje, błąd w manifeście, przerwane pytanie, nieoczekiwany błąd) |
| `2` | błędne użycie: nieznane polecenie lub opcja, brak wymaganego argumentu, niepoprawne id, zła wartość `--store`, `CWM_HOME` niebezwzględny |

`cwm` bez argumentów i `cwm help` wypisują pomoc, ale kończą się kodem `2`. Do pomocy z kodem `0`
służy `-h`.

## Polecenia

Poza `init` każde polecenie wymaga wcześniejszego `cwm init`; bez niego kończy się kodem `1`
z komunikatem `Brak danych CWM w ...`.

### `cwm init`

```text
cwm init
```

Tworzy `~/.cwm` z podkatalogami (`registry/*`, `companies`, `sources`, `cache`, `locks`,
`runtime`) i `config.yaml` z domyślną konfiguracją globalną. Niczego nie nadpisuje: to, co już
istnieje, jest tylko wymieniane. Katalogi dostają tryb 700, pliki 600 (POSIX).

```sh
cwm init
```

Kody: `0`, `2` przy niepoprawnym `CWM_HOME`. Z `--json`: `{ ok, home, created[], existing[] }`.

### `cwm company add`

```text
cwm company add [id] [--name <nazwa>] [--instructions <plik>]
```

| Opcja | Znaczenie |
|---|---|
| `id` | id firmy; bez niego na terminalu `cwm` zapyta, poza terminalem to błąd użycia |
| `--name <nazwa>` | nazwa firmy (domyślnie id); pytanie o nazwę pojawia się tylko, gdy id też zadano pytaniem |
| `--instructions <plik>` | ścieżka względna pliku instrukcji firmy (np. `CLAUDE.md`), zapisana w `instructions.file` |

Tworzy `companies/<id>/` z `company.yaml` oraz `skills/`, `agents/`, `workflows/` i `projects/`.

```sh
cwm company add acme-a --name "Acme A"
cwm company add acme-b --instructions CLAUDE.md
```

Kody: `0`; `1`, gdy firma już istnieje; `2` przy braku id bez terminala albo niepoprawnym id
(w tym `global`, `marketplace`, `local`, `git`).

### `cwm company list`

```text
cwm company list
```

Wypisuje firmy z kolumnami `ID`, `NAZWA` i `PROJEKTY W ~/.cwm` (liczba projektów z
`--store home`). Błędny manifest firmy jest pokazany jako `(bledny manifest)` z błędem na stderr.

```sh
cwm company list
```

```text
ID      NAZWA   PROJEKTY W ~/.cwm
acme-a  Acme A  1
```

Kody: `0`. Z `--json`: `{ ok, companies: [{ id, name, valid, homeProjects }] }`.

### `cwm project create` i `cwm project attach`

```text
cwm project create <katalog> [--company <id>] [--id <id>] [--engine <silnik>] [--store local|home]
cwm project attach <katalog> [--company <id>] [--id <id>] [--engine <silnik>] [--store local|home]
```

`create` zakłada nowy, pusty katalog (albo używa istniejącego pustego) i manifest. `attach`
podłącza istniejący katalog; wykrywa i wypisuje natywne `.claude/`, `CLAUDE.md` i `.mcp.json` i
nigdy ich nie otwiera ani nie zmienia.

| Opcja | Znaczenie |
|---|---|
| `--company <id>` | firma projektu; domyślnie firma projektu nadrzędnego (znalezionego w górę drzewa); bez niej na terminalu `cwm` pyta, poza terminalem to błąd użycia |
| `--id <id>` | id projektu; domyślnie nazwa katalogu zapisana małymi literami, znaki spoza `a-z0-9-` zamienione na `-` |
| `--engine <silnik>` | `claude-code` albo `codex`; domyślnie `defaults.engine` z `config.yaml` |
| `--store local\|home` | `local` (domyślnie): `<katalog>/.cwm/project.yaml`; `home`: `~/.cwm/companies/<firma>/projects/<id>.yaml` z `metadata.path` |

Przy `--store local` w repozytorium git `cwm` sprawdza (`git check-ignore`), czy `.cwm/` jest
ignorowane, i ostrzega na stderr, jeśli nie jest albo nie da się tego rozstrzygnąć. Ostrzeżenie
nie zmienia kodu wyjścia. Dla repozytoriów publicznych użyj `--store home`.

Projekt zagnieżdżony musi należeć do firmy projektu nadrzędnego. Katalog, który ma już manifest
projektu (lokalny albo w `~/.cwm`), jest odrzucany. Katalog nie może leżeć w `~/.cwm`, nim być
ani mieć w ścieżce segmentu `.claude`, `CLAUDE.md` lub `.mcp.json`.

```sh
cwm project create ~/work/acme-web --company acme-a
cwm project attach ~/work/legacy --company acme-a --store home --id acme-legacy
```

```text
Podlaczono projekt "acme-legacy" (firma "acme-a", silnik claude-code).
Manifest (home): /home/user/.cwm/companies/acme-a/projects/acme-legacy.yaml
Wykryto natywna konfiguracje (CWM jej nie zmienia): .claude/, CLAUDE.md
```

Kody: `0`; `1`, gdy `create` trafia na niepusty katalog, `attach` na brakujący, firma nie istnieje,
manifest już jest albo katalog jest niedozwolony; `2` przy braku firmy bez terminala, niepoprawnym
id albo złej wartości `--store`/`--engine`. Z `--json`: `{ ok, project, native, parent, warnings }`.

### `cwm project list`

```text
cwm project list [--company <id>] [--scan <katalog>]
```

Wypisuje projekty z manifestami w `~/.cwm`. Projekty z manifestem lokalnym `cwm` znajdzie tylko
w katalogu podanym w `--scan` (do 2 poziomów w dół, z pominięciem `node_modules`, `.git`, `dist`,
`target`, `build` i katalogów zaczynających się od `.`, bez dowiązań, do 2000 katalogów; przy
osiągnięciu limitu ostrzega, że wynik może być niepełny).

| Opcja | Znaczenie |
|---|---|
| `--company <id>` | tylko ta firma |
| `--scan <katalog>` | dodatkowo szuka `.cwm/project.yaml` poniżej katalogu |

```sh
cwm project list --scan ~/work
```

```text
STORE  FIRMA   ID           KATALOG
home   acme-a  acme-legacy  /home/user/work/legacy
local  acme-a  acme-web     /home/user/work/acme-web
```

Kody: `0`. Błędne manifesty są wypisane na stderr jako `Blad: ...`, ale nie zmieniają kodu.

### `cwm resource list`

```text
cwm resource list [--kind <rodzaj>] [--company <id>]
```

Wypisuje zasoby z rejestru globalnego i katalogów firm, posortowane po rodzaju i id. Id zdefiniowane
więcej niż raz są oznaczone `(KONFLIKT)`. Pliki zasobów, które nie przeszły walidacji, są
pomijane: `cwm` podaje ich liczbę i pierwsze pięć błędów na stderr (pełną listę da `cwm doctor`).

| Opcja | Znaczenie |
|---|---|
| `--kind <rodzaj>` | `skill`, `agent`, `workflow`, `plugin` albo `mcp` |
| `--company <id>` | tylko zasoby z katalogu tej firmy |

```sh
cwm resource list --kind skill
```

```text
RODZAJ  ZASOB                          ZRODLO        PLIK
skill   acme-a/coding-standards@1.2.0  firma acme-a  /home/user/.cwm/companies/acme-a/skills/coding-standards/skill.yaml
skill   global/code-review@1.0.0       rejestr       /home/user/.cwm/registry/skills/global/code-review/skill.yaml
```

Kody: `0`; `2` przy złej wartości `--kind`. Z `--json`: `{ ok, resources: [...], skippedFiles }`.

### `cwm resolve`

```text
cwm resolve [--project <katalog>]
```

Składa konfigurację projektu z warstw (global, firma, projekt, importy) i wypisuje
`EffectiveConfiguration` jako YAML. Przy błędzie wypisuje listę błędów z plikiem i pozycją
(`plik:linia:kolumna: pole: komunikat`) i kończy się kodem `1`. Wykrywa firmę projektu
nadrzędnego.

| Opcja | Znaczenie |
|---|---|
| `--project <katalog>` | projekt dokładnie w tym katalogu; bez opcji `cwm` szuka manifestu od bieżącego katalogu w górę |

```sh
cd ~/work/acme-web && cwm resolve
cwm resolve --project ~/work/acme-web --json
```

```text
apiVersion: cwm.dev/v1
kind: EffectiveConfiguration
profile:
  company: acme-a
  project: acme-web
  engine: claude-code
resolved:
  skills:
    - acme-a/coding-standards@1.2.0
    - global/code-review@1.0.0
  agents:
    - global/reviewer@1.0.0
  workflows: []
  plugins:
    - marketplace/acme-lint@0.3.1
  mcp:
    - global/acme-docs
validation:
  conflicts: []
  missingDependencies: []
```

Kody: `0`; `1`, gdy nie znaleziono manifestu projektu albo konfiguracji nie da się złożyć. Z
`--json` błąd to `{ ok: false, errors: [...] }`.

### `cwm doctor`

```text
cwm doctor [--project <katalog>]
```

Sprawdza katalog danych, `config.yaml`, wszystkie manifesty firm i projektów z `~/.cwm`, zasoby
w rejestrze, referencje do zasobów, które nie istnieją, brakujące zależności i konflikty id.
Dodatkowo sprawdza projekt z bieżącego katalogu (z szukaniem w górę) albo z `--project` i składa
jego konfigurację.

Błędy (kod `1`) to m.in. zepsuty manifest, brakujący zasób, konflikt id, id niezgodne z położeniem
pliku. Ostrzeżenia (kod `0`) to brakujące katalogi z `init`, katalogi danych i firm z uprawnieniami
szerszymi niż 700, brak pliku `spec.source` obok definicji, pominięte dowiązania i obcięte skany.
Ten sam problem zgłoszony z wielu miejsc jest liczony raz.

```sh
cwm doctor
```

```text
Sprawdzono: firm 1, projektow 1, zasobow 6. Bledy: 0, ostrzezenia: 0.
```

Kody: `0` bez błędów, `1` gdy są błędy. Z `--json`: `{ ok, checked, errors[], warnings[] }`, gdzie
każdy wpis ma `file`, `path`, `message`, `line` i `col`.

## Czego jeszcze nie ma

Polecenia `start`, `sync`, `diff` i `run`, lockfile, generowanie profili silnika, ekran
zatwierdzania zmian w pluginach i MCP oraz import biblioteki aplikacji. Zapis do konfiguracji
silnika jest poza zakresem.
