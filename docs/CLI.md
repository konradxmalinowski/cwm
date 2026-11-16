# CLI `cwm`

last_updated: 2026-11-15

`cwm` zakłada i sprawdza dane CWM w `~/.cwm`: firmy, projekty i zasoby (skille, agenci, komendy,
workflowy, ustawienia, pluginy, serwery MCP). Składa też z nich konfigurację projektu, a
`cwm import claude` kopiuje do rejestru skille, agentów, komendy i ustawienia z natywnego katalogu
Claude Code, a `cwm sync` odświeża rejestr z tych samych katalogów. `cwm start` generuje profil firmy w `~/.cwm/runtime` i uruchamia silnik (ADR 0040);
żadne polecenie nie zapisuje w `.claude/`, `CLAUDE.md` ani `.mcp.json`, a natywny katalog jest
czytany tylko do odczytu.
Decyzje i ograniczenia: [ADR 0038](adr/0038-fundament-cli-cwm.md) (fundament),
[ADR 0040](adr/0040-zatwierdzanie-profil-i-cwm-start.md) (zatwierdzanie, profil, `cwm start`) i
[ADR 0039](adr/0039-rodzaje-settings-i-command-oraz-import-z-natywnej-konfiguracji.md) (rodzaje
`Settings` i `Command`, import). Model manifestów:
[ADR 0037](adr/0037-model-zasobow-i-resolver-warstwy-cwm.md).

Stan: gałąź `feat/cwm-run` (Etap B, zbudowana na `feat/cwm-start`, czyli Etapie A), niescalona do `main`.

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
  config.yaml                     konfiguracja globalna (tworzy ją `cwm init`), w tym marketplace'y
  registry/                       zasoby wspólne
    skills/<przestrzeń>/<nazwa>/skill.yaml
    agents/<przestrzeń>/<nazwa>/agent.yaml
    commands/<przestrzeń>/<nazwa>/command.yaml
    settings/<przestrzeń>/<nazwa>/settings.yaml
    files/<przestrzeń>/<nazwa>/files.yaml
    workflows/<przestrzeń>/<nazwa>/workflow.yaml
    plugins/<przestrzeń>/<nazwa>/plugin.yaml
    mcp/<przestrzeń>/<nazwa>/mcp.yaml
  companies/
    <firma>/
      company.yaml                manifest firmy
      skills/<nazwa>/skill.yaml   zasoby firmy (id: <firma>/<nazwa>)
      agents/<nazwa>/agent.yaml
      commands/<nazwa>/command.yaml
      settings/<nazwa>/settings.yaml
      files/<nazwa>/files.yaml
      workflows/<nazwa>/workflow.yaml
      projects/<id>.yaml          manifesty projektów z `--store home`
      projects/<id>.lock          lockfile projektu z `--store home` (tworzy `cwm lock`)
  approvals/<firma>.yaml          zatwierdzenia zasobów z polami wykonawczymi (tworzy `cwm start`)
  approvals/packs/<przestrzeń>/<nazwa>.json   zaufane skróty pakietów (tworzy `cwm import`, odnawia `cwm start`)
  packs/<przestrzeń>/<nazwa>.yaml definicje pakietów: lista zasobów (tworzy `cwm import`, zob. `cwm pack`)
  runtime/<firma>/                profil i pliki uruchomienia (tworzy `cwm start`, zob. niżej)
  runtime/engine-checks.json      wyniki sprawdzenia flag silnika per wersja (tworzy `cwm engine check` i `cwm start`, ADR 0052)
  sources/git/<skrót adresu>/<commit>/   kopie pluginów z git, bez `.git` (tworzy `cwm plugin add git|fetch|update`)
  cache/  locks/                  zarezerwowane, na razie puste
```

Katalog zasobu zawiera plik definicji i pliki, na które wskazuje `spec.source` (np. `SKILL.md`;
import tworzy `SKILL.md`, `AGENT.md` i `COMMAND.md`). `Settings` nie ma pliku źródłowego: cała
treść jest w `settings.yaml`. `Files` (wspólne pliki, zob. niżej) trzyma treść pod tą samą ścieżką
względną, pod którą trafi do profilu. Istniejący `~/.cwm` dostaje katalog `registry/files/` po
ponownym `cwm init`; bez niego `cwm doctor` ostrzega, a reszta działa.
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
    workflows: []             # rozszerzenie spoza specyfikacji (ADR 0049)
    commands: []
    settings: []
  optional:
    skills: []
    agents: []
    workflows: []
    commands: []
    settings: []
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
    commands: [global/acme-ship]
    settings: [global/acme-baseline]
  disableOptional:
    skills: []
    agents: []
    workflows: []
    commands: []
    settings: []
plugins:
  enable: [marketplace/acme-lint]
  forbid: []
mcp:
  enable: [global/acme-docs]
workflows:                        # opcjonalne, rozszerzenie spoza specyfikacji (ADR 0049)
  default: acme-a/bugfix          # dla cwm run, gdy opis nic wyraźnie nie wskazuje
instructions:
  file: CLAUDE.md
exports:
  skills: []
  agents: []
  workflows: []
  commands: []
  settings: []
  plugins: []
  mcp: []
runtime:                          # opcjonalne, rozszerzenie spoza specyfikacji (ADR 0040)
  isolation: true                 # false: bez kluczy izolacji od zasobów konta claude.ai
  claude:
    path: /home/user/.local/bin/claude   # bezwzględna ścieżka silnika; bez niej szukanie w PATH
  env:
    passthrough: [ACME_HTTP_PROXY]       # dziedziczone mimo wzorca sekretu lub ANTHROPIC_*/CLAUDE_*
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
      commands: []
      settings: []
    disableOptional:
      skills: []
      agents: []
      workflows: []
      commands: []
      settings: []
  plugins:
    enable: []
    disable: []
  mcp:
    enable: []
    disable: []
  workflows:
    selection: automatic
    default: acme-a/bugfix        # opcjonalne (ADR 0049): przesłania workflow domyślny firmy
  native:
    preserve: true
  lock: warn               # `frozen`: dryf wobec lockfile to odmowa startu (ADR 0051); pole opcjonalne
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
`MAJOR.MINOR.PATCH` (dla MCP jest opcjonalna). `Skill`, `Agent` i `Command` mogą mieć
`spec.contentFlags` (`allowedTools`, `inlineCommands`, oba domyślnie `false`): informację, że treść
pliku źródłowego ma pola wykonawcze. Import ustawia ją sam; jest to podpowiedź, a nie dowód
(ADR 0039).

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
      task: Review the changes and list the findings.
    - id: summary
      agent: global/reviewer
      dependsOn: [review]
```

Krok ma `id`, `agent`, opcjonalne `dependsOn` i opcjonalne `task` (jedna linia do 1000 znaków, bez znaków
sterujących; ADR 0050).

Workflow `instructional` (dodawany przez `cwm workflow add`, ADR 0049) ma `routing`, który czyta
`cwm run`; `mode: manual` wyłącza go z wyboru automatycznego:

```yaml
apiVersion: cwm.dev/v1
kind: Workflow
metadata:
  id: acme-a/bugfix
  version: 1.0.0
spec:
  type: instructional
  source: workflow.md
  routing:
    mode: automatic
    priority: 20
    keywords: [bug, regression]
    examples: [fix a failing unit test in the parser]
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

Plugin z lokalnego marketplace'u (ADR 0043) wymaga wpisu w `~/.cwm/config.yaml` (opcjonalne pole
`marketplaces`; jego brak oznacza brak marketplace'ów, a stare pliki pozostają poprawne). Wpis
tworzy `cwm marketplace add`:

```yaml
marketplaces:
  example-market:
    type: local
    path: /home/user/marketplaces/example-market
```

Nazwa to małe litery ASCII (jak przestrzeń nazw id) i musi być równa polu `name` w
`<katalog>/.claude-plugin/marketplace.json`. Typ inny niż `local` jest błędem walidacji. Zasób
`Plugin` zapisuje `cwm plugin add` (ADR 0046), a id dopisuje do `plugins.enable` w `company.yaml` `--enable`
albo `cwm plugin enable`. Ręczny zapis nadal działa (`cwm marketplace show <nazwa> <plugin>` wypisuje gotowy
tekst). Dwa marketplace'y z pluginami o tej samej nazwie wymagają różnych id zasobów, np.
`marketplace/acme-lint` i `marketplace/other-acme-lint`; wskazuje je `spec.source.plugin`, nie id.

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

`registry/commands/global/acme-ship/command.yaml` (plik `.md` z `commands/`; jak `Skill` bez
zależności):

```yaml
apiVersion: cwm.dev/v1
kind: Command
metadata:
  id: global/acme-ship
  version: 1.0.0
spec:
  source: COMMAND.md
  contentFlags:
    allowedTools: false
    inlineCommands: true
```

`registry/settings/global/acme-baseline/settings.yaml`. Hooki mają kształt natywnego
`settings.json`, ale `type` to zawsze `command` (`http`, `prompt` i `agent` są błędem).
Zmienna `env` to `{ envRef }` (nazwa zmiennej środowiska użytkownika) albo `{ value }`; `value`
wolno wpisać tylko, gdy ani nazwa, ani wartość nie wyglądają na sekret. Zmienne sterujące
silnikiem lub procesem (`PATH`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`,
`*_BASE_URL`, `*_PROXY` i inne) są zabronione, podobnie jak klucze `statusLine`, `apiKeyHelper`,
`enabledPlugins` i pokrewne. `enforce` (domyślnie `false`) jest zapisywane i scalane, a użyje go
dopiero generowanie profilu.

Poza hookami, uprawnieniami i `env` `Settings` niesie dwa bloki bez wpływu na wykonanie kodu:
`attribution` (`commit`, `pr`: teksty dopisywane do commitów i opisów PR, do 2048 znaków, bez
sekretów; pusty tekst wyłącza dopisek) oraz `preferences` (`theme`, `tui`, `preferredNotifChannel`,
`voiceEnabled`, `enableWorkflows` i `voice` z polami `enabled` i `mode`; teksty to krótkie nazwy
trybów). Ten sam klucz o różnych wartościach w dwóch zasobach to błąd resolvera, jak w `env`.

`registry/files/global/acme-guides/files.yaml` (rodzaj `Files`: wspólny materiał, który agenci i
skille czytają po ścieżce, bez pól wykonawczych):

```yaml
apiVersion: cwm.dev/v1
kind: Files
metadata:
  id: global/acme-guides
  version: 1.0.0
spec:
  root: skills          # skills albo agents: katalog profilu
  path: acme-guides.md  # ścieżka pod root; plik albo katalog
```

Treść leży w katalogu zasobu pod tą samą ścieżką (`acme-guides.md`, a dla katalogu
`acme-support/ref.md` itd.), a `spec.path` jest jej wspólnym przedrostkiem. `cwm start` zapisuje ją
w `claude/<root>/<ścieżka>`.

```yaml
apiVersion: cwm.dev/v1
kind: Settings
metadata:
  id: global/acme-baseline
  version: 1.0.0
spec:
  hooks:
    PreToolUse:
      - matcher: Bash
        hooks:
          - type: command
            command: /opt/acme/audit-hook.sh
            timeout: 10
  permissions:
    allow:
      - Bash(npm run lint)
    deny:
      - Read(./.env)
    defaultMode: acceptEdits
  env:
    ACME_REGION:
      value: eu
    ACME_AUDIT_TOKEN:
      envRef: ACME_AUDIT_TOKEN
  enforce: true
```

Limity: `command` do 4096 znaków, bez znaków sterujących i bez sekretów; `timeout` od 1 do 600
sekund; do 64 zdarzeń; listy do 500 pozycji; teksty do 512 znaków. Kilka zasobów `Settings`
`resolve` scala w kolejności warstw (global, firma, projekt), a w warstwie po id: hooki są
dołączane, listy uprawnień sumowane. Ta sama zmienna `env` albo `defaultMode` o różnych wartościach
to błąd, np. `settings:global/acme-eu.env.ACME_REGION: Zmienna ACME_REGION ma rozne definicje w
global/acme-baseline i global/acme-eu.` (kod `1`).

Serwer MCP: znak `$` jest zabroniony w `command`, `args` i `url` (silnik rozwija `${...}`), więc
`args: ["--key=${AWS_SECRET_ACCESS_KEY}"]` kończy się błędem walidacji. Sekret przekazuje się
przez `env.<NAZWA>.envRef`.

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
| `1` | błąd walidacji, polityki albo stanu na dysku (brak `cwm init`, firma już istnieje, błąd w manifeście, przerwane pytanie, nieoczekiwany błąd); dla `import claude` i `sync` także zmiany do zapisania bez terminala (zob. niżej), a dla `sync` zablokowane usunięcie (zasób obowiązkowy albo wymagany) i źródło, którego nie da się przejrzeć; dla `start` niezatwierdzone zasoby bez terminala, brak zmiennej `envRef`, trwająca sesja firmy z innym profilem, odmowa zatwierdzenia, dryf, brak lub uszkodzenie lockfile w trybie frozen; dla `lock --check` dryf; dla `start` i `run` także silnik bez flagi, którą CWM mu podaje (ADR 0052); dla `engine check` brak takiej flagi albo nieczytelna pomoc silnika; po uruchomieniu silnika `start` zwraca jego kod wyjścia |
| `2` | błędne użycie: nieznane polecenie lub opcja, brak wymaganego argumentu, niepoprawne id, zła wartość `--store`, `CWM_HOME` niebezwzględny; dla `import claude` brak `--company` i `--global` bez terminala albo oba naraz; dla `start` niedozwolone argumenty silnika po `--`, dla `approvals revoke` zły zestaw selektorów; dla `diff` także każdy błąd ustawienia (brak manifestu projektu, uszkodzony manifest firmy), bo `1` oznacza tam różnicę: start coś zmieni albo odmówi; dla `lock --check` brak lub uszkodzenie lockfile i błąd ustawienia (`1` to dryf) |

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

Tworzy `companies/<id>/` z `company.yaml` oraz `skills/`, `agents/`, `workflows/`, `commands/`,
`settings/`, `files/` i `projects/`.

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
| `--kind <rodzaj>` | `skill`, `agent`, `workflow`, `plugin`, `mcp`, `settings`, `command` albo `files` |
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

### `cwm marketplace`

```text
cwm marketplace add <nazwa> <katalog>
cwm marketplace list
cwm marketplace remove <nazwa>
cwm marketplace show <nazwa> [<plugin>]
```

Lokalne marketplace'y pluginów (ADR 0043): katalog z `.claude-plugin/marketplace.json`. Polecenia
tylko czytają katalog marketplace'u; jedyny zapis to pole `marketplaces` w `~/.cwm/config.yaml`
(przez writer `~/.cwm`, atomowo, tryb 0600, komentarze i reszta pliku zostają).

- `add` zapisuje ścieżkę po `realpath` i odmawia, gdy marketplace nie przechodzi kontroli
  (poniżej), nazwa różni się od `name` w `marketplace.json` albo jest już zarejestrowana.
- `list` pokazuje stan każdego wpisu (`ok` albo powód błędu).
- `remove` usuwa wpis z konfiguracji (katalog marketplace'u zostaje) i odmawia, gdy jakiś zasób
  `Plugin` na niego wskazuje.
- `show <nazwa>` wypisuje pluginy z katalogu i stan każdego (to samo rozwiązanie ścieżki co
  `cwm start`, więc dowiązania i uprawnienia też są widoczne). `show <nazwa> <plugin>` dopisuje
  gotowy manifest zasobu `Plugin`.

**Kontrola marketplace'u** (przy `add`, `list`, `show` i `cwm start`): ścieżka bezwzględna; po
`realpath` katalog należy do bieżącego użytkownika i nie jest zapisywalny dla grupy ani innych, a jego
katalog nadrzędny ma właściciela root albo użytkownika i nie jest zapisywalny dla grupy ani innych
(jak plik silnika; chyba że ma bit sticky). Tak samo `.claude-plugin/`, `marketplace.json` i każdy
katalog na ścieżce do pluginu. `marketplace.json` jest czytany jako zwykły plik do 512 KiB (limit
przed dekodowaniem), w UTF-8, bez zabronionych kluczy. Walidacja jest ostra: dozwolone pola
korzenia to `$schema`, `name`, `owner`, `metadata`, `plugins`, `description`, `version`;
`metadata.pluginRoot` jest odrzucane (zmieniałoby znaczenie `source`).

**Wpis pluginu jest używalny tylko wtedy, gdy:** nazwa jest ASCII i nie zwija się (`foldName`:
wielkość liter, Unicode) do tej samej nazwy co inny wpis; `source` to tekst `./sciezka` (bez `..`,
bez ścieżki bezwzględnej, bez segmentów zaczynających się od `.`, bez samego korzenia); wpis nie
deklaruje `hooks`, `mcpServers`, `lspServers`, `commands`, `agents`, `skills` ani `outputStyles` (silnik
czyta je z `plugin.json` pluginu, nie z wpisu) i nie ma `strict: false`; nie ma nieznanych pól.
Źródła obiektowe (`github`, `url`, `git`, `npm`) są odrzucane z powodem: marketplace niczego nie pobiera.
Plugin z repozytorium git dodaje `cwm plugin add git` (zob. `cwm plugin`); można też sklonować go ręcznie do
katalogu marketplace'u i wpisać `./sciezka`.

Kody: `0`; `1` przy odmowie (marketplace nie przechodzi kontroli, nazwa zajęta, nieznany, w użyciu);
`2` przy niepoprawnej nazwie. Z `--json` każde polecenie zwraca `{ ok, ... }`.

### `cwm plugin`

```text
cwm plugin add <marketplace>/<plugin> [--id <id>] [--plugin-version <wersja>] [--enable <firma>...]
cwm plugin add git <url> --id git/<nazwa> [--ref <ref>] [--plugin-version <wersja>] [--enable <firma>...]
cwm plugin fetch <id>
cwm plugin update <id> [--ref <ref>]
cwm plugin enable <id> --company <firma>
cwm plugin disable <id> --company <firma>
cwm plugin list
cwm plugin remove <id>
```

Zasoby `Plugin` z lokalnych marketplace'ów (ADR 0046) i z repozytoriów git (ADR 0048). Zapis idzie przez writer `~/.cwm` (atomowo, tryb
0600) pod mutexem `runtime/global`, jak `cwm sync`; edycje `company.yaml` zachowują komentarze i resztę
pliku, a wynik przechodzi ten sam walidator co odczyt. Żadne z poleceń nie zatwierdza pluginu:
zatwierdzenie jest przy `cwm start` (treść pluginu i blok `marketplace` albo `git`), a `cwm start --dry-run`
pokazuje plugin jako `NOWE`.

- `add <marketplace>/<plugin>` rozwiązuje wpis jak `cwm start` (marketplace zarejestrowany, wpis używalny, katalog zaufany;
  zob. `cwm marketplace`) i zapisuje `registry/plugins/marketplace/<plugin>/plugin.yaml` z
  `activation.default: disabled`. Id to `marketplace/<plugin>`; `--id` musi mieć przestrzeń `marketplace`.
  Wersja: `--plugin-version`, inaczej `version` z `.claude-plugin/plugin.json`, inaczej `0.0.0`.
  Opcja nie nazywa się `--version`, bo tę flagę przechwytuje program (`-V, --version`).
  - Id zajęte przez inny marketplace albo plugin: błąd z podpowiedzią `--id marketplace/<marketplace>-<plugin>`.
  - Id zajęte przez ten sam wpis: `bez zmian` (kod `0`).
  - `--enable <firma>...` dopisuje id do `plugins.enable` wskazanych firm (także gdy zasób już istniał).
    Nieistniejąca firma albo id w jej `plugins.forbid` przerywa polecenie przed jakimkolwiek zapisem.
- `add git <url> --id git/<nazwa>` pobiera repozytorium (patrz niżej), przypina pełny SHA commita w
  `registry/plugins/git/<nazwa>/plugin.yaml` (`source.commit`) i dopisuje id do `plugins.enable` firm z `--enable`.
  `--id` jest wymagane i musi mieć przestrzeń `git`. `--ref` to gałąź, tag albo pełny SHA (domyślnie `HEAD`
  repozytorium). Id zajęte przez inne źródło to błąd przed pobraniem; to samo źródło to `bez zmian`, bez sieci.
- `fetch <id>` pobiera kopię commita przypiętego w manifeście (po SHA), gdy jej brakuje na dysku; gdy kopia
  jest na miejscu, nic nie pobiera. Manifest bez `source.commit` (zapisany ręcznie) przypina `ref` do bieżącego
  commita.
- `update <id> [--ref <ref>]` pobiera aktualny commit refu, pokazuje stary i nowy commit oraz listę
  zmienionych plików (`+` dodany, `~` zmieniony, `-` usunięty, do 50 wierszy), zapisuje nowy commit w
  manifeście i usuwa kopię starego, jeśli nie używa jej inny zasób. Ten sam commit to `bez zmian`. Nic nie
  zatwierdza: skrót drzewa się zmienia, więc `cwm start` zapyta ponownie.
- `enable` i `disable` dopisują i usuwają id w `plugins.enable` firmy; `enable` wymaga zasobu w rejestrze i
  odmawia przy `plugins.forbid`. Powtórzenie to `bez zmian`.
- `list` wypisuje pluginy z rejestru: id, wersja, źródło (dla git: adres bez danych logowania, ref i
  początek commita) i firmy, które je włączają.
- `remove` odmawia, gdy firma włącza plugin (w komunikacie jej nazwa); inaczej usuwa zasób z rejestru,
  z `exports.plugins` firm, z pakietów (razem z zaufanymi skrótami) i z zatwierdzeń oraz kopie `.old-*`.
  Dla pluginu z git usuwa też kopię w `sources/git`, jeśli nie używa jej inny zasób.
  Projekt z `~/.cwm`, który nadal wymienia plugin, daje ostrzeżenie.

**Pluginy z git (ADR 0048).** Sieć i proces `git` są tylko w `cwm plugin add git`, `fetch` i `update`;
`cwm start`, `cwm diff` i `cwm sync` nigdy nie uruchamiają `git` ani nie łączą się z siecią (pilnuje tego
lint i `npm run test:boundaries`). Start używa wyłącznie commita przypiętego w manifeście, z kopii
`~/.cwm/sources/git/<skrót adresu>/<commit>/`; bez kopii kończy się błędem z poleceniem `cwm plugin fetch <id>`,
a manifest bez `source.commit`, z kopią, której skrót drzewa różni się od `source.tree`, albo z kopią, która nie zgadza się z commitem (niżej), błędem z tym samym poleceniem (`fetch` pobiera wtedy ponownie).

```yaml
apiVersion: cwm.dev/v1
kind: Plugin
metadata:
  id: git/acme-lint
  version: 1.0.0
spec:
  source:
    type: git
    url: https://example.com/acme/lint.git
    ref: v1.0.0
    commit: 0123456789abcdef0123456789abcdef01234567
    tree: 89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567
  activation:
    default: disabled
```

- Adres: w formie kanonicznej (`new URL(adres).href` równe wpisanemu: małe litery w schemacie i hoście, bez jawnego domyślnego portu), `https://` (`http://` tylko dla `localhost`, `127.0.0.0/8` i `::1`). Odrzucane są `file://`,
  `ext::`, `git://`, `ssh://`, ścieżki lokalne, nazwa użytkownika i hasło w adresie, zapytanie (`?`), fragment
  (`#`), białe znaki i znaki sterujące. Dane logowania nie są obsługiwane: pobieranie jest anonimowe
  (publiczne repozytoria), a pomocniki haseł i agent SSH są wyłączone.
- Ref: nazwa gałęzi, tagu (`refs/tags/<nazwa>` rozstrzyga niejednoznaczność) albo pełny SHA; skrócony SHA, `..`,
  początkowy `-` i `.lock` są odrzucane.
- `git` jest uruchamiany po ścieżce bezwzględnej z `PATH` (po `realpath`, ten sam warunek właściciela i
  uprawnień co plik silnika), w pustym katalogu roboczym 0700, ze środowiskiem zbudowanym od zera: tylko
  zmienne proxy (`HTTPS_PROXY`, `NO_PROXY`) i certyfikatów (`SSL_CERT_FILE`, `SSL_CERT_DIR`) z procesu CWM,
  `HOME` wskazuje katalog roboczy (żadnego `~/.netrc`, `~/.ssh`, `~/.gitconfig`), `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=https`. Opcje `-c`: bez hooków
  (`core.hooksPath=/dev/null`), `protocol.allow=never` z wyjątkiem https, bez przekierowań, bez submodułów,
  bez filtrów LFS, bez pomocników haseł, z `transfer.fsckObjects`.
- Pobranie to `git fetch --depth=1 --no-tags --no-recurse-submodules` po SHA (przy `fetch`) albo po refie
  (przy `add` i `update`). Limity: 120 s na polecenie, 300 s łącznie, 64 MiB w katalogu roboczym (kontrola co 200 ms, przed pobraniem wymagane 128 MiB wolnego miejsca), 4 MiB
  wyjścia; przerwanie (Ctrl-C, SIGTERM) zabija proces `git` z jego pomocnikami i usuwa katalog roboczy.
- Przed zapisem lista plików commita (`git ls-tree -r -t -l -z`) musi mieć tylko zwykłe pliki (dowiązanie
  symboliczne, składnik `.git` i tryb inny niż 100644, 100755 i dawny 100664 to błąd; nazwa powyżej 200 bajtów i kolizja nazw po `foldName` też), do 500 plików, 1 MiB na plik i 10 MiB
  razem (obiekty commita i drzew liczą się do 10 MiB); submoduły nie są pobierane (ostrzeżenie, w kopii ich nie ma).
  Zapisane drzewo czyta ten sam `readTree` co plugin `local` (bez dowiązań, bez twardych dowiązań, bez kolizji
  wielkości liter). Hooki, filtry i atrybuty z repozytorium nie są wykonywane; kopia nie ma katalogu `.git`.
- **Surowe bajty.** Pliki nie powstają przez `checkout`, tylko z blobów odczytanych przez `git cat-file --batch`
  i zapisanych bez zmian: `.gitattributes` (`working-tree-encoding`, `ident`, `eol`, `text`) nie zmienia
  bajtów. Tryb wykonywalny wynika z trybu wpisu drzewa (100755).
- **Weryfikacja commita offline.** Obok kopii leży katalog `<commit>.objects/` z surowymi obiektami commita i
  wszystkich drzew (plik na obiekt, nazwa to skrót, treść z nagłówkiem `<typ> <długość>\0`); nie trafia do
  migawki pluginu ani do profilu. `cwm start` i `cwm diff` sprawdzają w czystym JS, bez `git`: skrót obiektu
  commita (SHA-1 albo SHA-256 zależnie od długości przypiętego SHA) równy `source.commit`, linia `tree` commita
  wskazuje drzewo główne, każde drzewo przeliczone z zapisanych bajtów, każdy plik kopii przeliczony na skrót
  bloba, zgodność trybów i zbioru ścieżek (brakujący, dodatkowy albo zmieniony plik, nadmiarowy obiekt to
  odmowa). `source.tree` zostaje szybką kontrolą; wiążący jest łańcuch od commita.
- **Migracja.** Kopia pobrana przed tą kontrolą (bez `<commit>.objects/`) jest odrzucana przy starcie z
  poleceniem `cwm plugin fetch <id>`; `fetch` pobiera ją ponownie i zapisuje obiekty (tylko jawnie, start nie
  łączy się z siecią). Gdy surowe bajty różnią się od dawnych (repozytorium z `.gitattributes`), `fetch`
  odmawia zgodnie z `source.tree`: zaakceptuj nową treść przez `cwm plugin update <id>`.
- Pola zatwierdzenia: jak dla pluginu `local` (skrót drzewa, lista plików, hooki, serwery MCP i LSP, piny)
  plus blok `git` z adresem bez danych logowania, refem i commitem. Zmiana adresu, refu albo commita pyta
  ponownie. Skróty pluginów `local` i `marketplace` się nie zmieniają.

Kody: `0`; `1` przy odmowie (marketplace albo wpis nieużywalny, kolizja id, nieznana firma albo plugin,
`plugins.forbid`, plugin włączony, nieudane pobranie, repozytorium z dowiązaniem albo przekroczonym limitem);
`2` przy niepoprawnym argumencie (w tym adres lub ref odrzucony regułami powyżej). Z `--json` każde polecenie zwraca
`{ ok, ... }`.

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
  settings:
    - global/acme-baseline@1.0.0
  commands:
    - global/acme-ship@1.0.0
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

### `cwm import claude`

```text
cwm import claude (--company <id> | --global) [--from <katalog>] [--include-flagged <ścieżka>]... [--dry-run]
```

Czyta natywny katalog Claude Code tylko do odczytu, pokazuje plan i raport, a po potwierdzeniu na
terminalu zapisuje kopie do rejestru CWM. Niczego nie uruchamia, nie zmienia źródła i nie włącza
zasobów w żadnej konfiguracji. Model zagrożeń i decyzje: [ADR 0039](adr/0039-rodzaje-settings-i-command-oraz-import-z-natywnej-konfiguracji.md).

| Opcja | Znaczenie |
|---|---|
| `--company <id>` | zapis w `companies/<id>/`, id zasobów `<id>/<nazwa>`; firma musi istnieć (`cwm company add`) |
| `--global` | zapis w `registry/`, id `global/<nazwa>`; zasób jest widoczny dla wszystkich firm. Nie łączy się z `--company` |
| `--from <katalog>` | katalog źródłowy; domyślnie `~/.claude` (zmienna `CLAUDE_CONFIG_DIR` nie jest brana pod uwagę). Nie może leżeć w katalogu danych CWM ani nim być |
| `--include-flagged <ścieżka>` | dołącza plik oznaczony jako możliwy sekret (ścieżka względem `--from`, jak w sekcji „Oznaczone pliki”); powtarzalna. Nieznana ścieżka albo twardy sekret to błąd użycia (kod `2`) |
| `--dry-run` | pokazuje plan i raport, niczego nie zapisuje; kod `0` |

Na terminalu bez `--company` i `--global` `cwm` pyta o przestrzeń (firma albo `global`). Bez
terminala (także z `--json` i `--no-input`) trzeba podać jedną z tych opcji, nawet przy `--dry-run`.

**Co jest czytane.** Wyłącznie poniższa lista; żaden inny plik z `--from` nie jest otwierany
(`.credentials.json`, `.claude.json`, `projects/`, `history.jsonl`, `plugins/`, `settings.local.json`
i reszta).

| Źródło | Rodzaj | Co powstaje |
|---|---|---|
| `skills/<nazwa>/` z `SKILL.md` | `Skill` | `SKILL.md` i pliki pomocnicze skilla |
| `skills/<nazwa>/` bez `SKILL.md` | `Files` | drzewo wsparcia, id `<przestrzeń>/skills-<nazwa>`, `root: skills` |
| `skills/<nazwa>.md` | `Files` | plik wprost w `skills/` (przewodnik), id `<przestrzeń>/skills-<nazwa>` |
| `agents/<nazwa>.md` | `Agent` | `AGENT.md`; `tools` i `model` z frontmattera trafiają do manifestu |
| `agents/<podkatalog>/` | `Files` | moduły agentów, id `<przestrzeń>/agents-<nazwa>`, `root: agents` |
| `commands/<nazwa>.md` | `Command` | `COMMAND.md` |
| `settings.json` | `Settings` | jeden zasób `<przestrzeń>/claude-settings` z `hooks`, `permissions`, `env`, `attribution` i `preferences` |

Zasoby dostają wersję `0.1.0`. Frontmatter jest odtwarzany z dozwolonych kluczy (nie kopiowany
bajt w bajt), a treść pliku zostaje bez zmian. Agent zachowuje `name`, `description`, `tools`,
`model`, `color` i `memory` (tylko `user`, `project` albo `local`; inna wartość idzie do raportu).
Nazwa zasobu `Files` ma przedrostek rodzaju (`skills-`, `agents-`), a ścieżka w profilu jest
dokładnie taka jak w źródle, bo agenci odwołują się do niej po nazwie. Pliki `.md` w `agents/<podkatalog>/`
przechodzą `parseFilesMarkdown`, także w `skills/`: frontmatter jest odtwarzany z dozwolonych kluczy
(nigdy surowy), a plik z `hooks` (pliki wspólne nie mają zatwierdzonych hooków, w odróżnieniu od `Skill`), `mcpServers`, `permissionMode`, `tools`, `allowed-tools`, `model`,
kluczem scalania YAML `<<` albo znacznikiem `...` jest pomijany z raportem. Wstawki `!` w treści dają
zasobowi `Files` zatwierdzenie przy `cwm start` (pola w całości). Poza tym `Files` to dane: bez bitu
wykonywania. `Files` nie może zawierać pliku `skill.md` w żadnej postaci (zwinięcie nazwy: NFKC, małe
litery, bez znaków łączących i końcowych kropek oraz spacji): katalog z manifestem skilla jest
`Skill`. Nazwy plików i katalogów spoza ASCII w drzewach skilli, agentów, komend i `Files` są
pomijane z raportem. Dwa zasoby definiujące agenta o tej samej nazwie we frontmatterze to błąd planu
`cwm start`. Nazwy są normalizowane do wzorca id (małe litery,
znaki spoza `a-z0-9._-` zamienione na `-`).

**Co jest pomijane** (każde pominięcie ma wpis w raporcie, bez wartości z pliku):

- dowiązania symboliczne, których cel (po `realpath`) nie jest zwykłym plikiem ani katalogiem
  wewnątrz `realpath(--from)`, leży poza `skills/`, `agents/`, `commands/`, w `skills/synced`,
  w ukrytym wpisie `skills/`, w `.git`, `node_modules` albo pod chronioną nazwą, a także
  zerwane i tworzące pętlę. Cel wewnątrz `--from` (np. skill instalowany przez narzędzie jako
  dowiązania do `skills/<narzędzie>/...`) jest śledzony, ale do rejestru trafia kopia treści, nigdy
  dowiązanie; raport podaje liczbę takich dowiązań per zasób. Dowiązanie na `skills/`, `agents/`,
  `commands/` i `settings.json` jest zawsze pomijane. Cel nie może być samym korzeniem obszaru, a
  reguły `synced`, ukrytych wpisów, `.git`, `node_modules` i chronionych nazw dotyczą też wpisów
  wewnątrz śledzonego katalogu. Dowiązanie najwyższego poziomu do innego wpisu tego samego obszaru
  (także innego obszaru, np. `skills/x -> agents/m`) jest aliasem i jest pomijane. Ukryte wpisy
  są blokowane w `skills/`, `agents/` i `commands/`, także przez dowiązanie. Pliki z wieloma twardymi dowiązaniami są pomijane. Opcji
  `--follow-links` nie ma,
- `skills/synced` (skille z konta claude.ai), `.git` i `node_modules`, a także wpisy zaczynające
  się od `.` bezpośrednio w `skills/`, `agents/` i `commands/` oraz zagnieżdżone katalogi w
  `commands/`,
- trafienie klasyfikatora sekretów w `SKILL.md`, `AGENT.md` albo `COMMAND.md` pomija cały zasób.
  Pliki pomocnicze z trafieniem nie są pomijane po cichu, tylko trafiają do przeglądu (sekcja
  „Oznaczone pliki”),
- agenci i komendy z kluczem frontmattera `hooks`, `mcpServers` albo `permissionMode` oraz skille z
  `mcpServers` albo `permissionMode` (cały zasób jest odrzucany),
- hooki skilla (`hooks` w `SKILL.md`, ADR 0042) są zachowane po walidacji tymi samymi regułami co
  hooki Settings (tylko `type: command`, `timeout` 1..600, polecenie bez sekretu i znaków
  sterujących, opcjonalny tekst `statusMessage`); raport pisze "hooki skilla: wymaga zatwierdzenia" i
  podaje stan pinów skryptów. `cwm start` zawsze pyta o taki skill i pokazuje hooki oraz piny w
  całości, a zmiana hooka albo skryptu pyta ponownie,
- z `settings.json` wszystko poza `hooks`, `permissions`, `env`, `attribution` (`commit`, `pr`) oraz
  preferencjami `theme`, `tui`, `voice`, `voiceEnabled`, `preferredNotifChannel`,
  `enableWorkflows` (sprawdzane typy); klucze uruchamiające polecenia
  (`statusLine`, `apiKeyHelper`, `enabledPlugins` i pokrewne) oraz `skipDangerousModePermissionPrompt`
  (wyłącza ostrzeżenie przed `bypassPermissions`; raportowany jako zabroniony), hooki inne niż `command`,
  zmienne `env` sterujące silnikiem lub procesem (`PATH`, `NODE_OPTIONS`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CONFIG_DIR` i pokrewne); sekret w poleceniu hooka lub regule uprawnień pomija cały zasób
  `Settings`,
- kolizje nazw po normalizacji (`Acme-Notes` i `acme-notes`): żadna ze stron nie jest importowana,
- limity: plik do 1 MiB; skill do 500 plików, 10 MiB i 16 poziomów; cały import do 20 000 plików,
  5000 katalogów i 256 MiB (przekroczenie przerywa import kodem `1`).

**Oznaczone pliki.** Plik pomocniczy z trafieniem klasyfikatora (nazwa, wzorzec klucza, entropia,
linia `hasło/token/klucz = wartość`) nie jest kopiowany, ale plan wymienia go w sekcji „Oznaczone
pliki”: ścieżka względem `--from`, powód, numer wiersza i stan (`pominiety`, `dolaczony`,
`zawsze pominiety`), nigdy wartość. Na terminalu, po wypisaniu planu, `cwm` pyta o wielokrotny
wybór plików do dołączenia (domyślnie żaden) i pokazuje plan jeszcze raz. Bez terminala służy do
tego `--include-flagged <ścieżka>`. Dołączony plik staje się częścią zasobu i jego skrótu
drzewa, a przy `cwm start` częścią zatwierdzenia (`Skill`, `Agent`) jak każdy inny. **Twardych
sekretów nie da się dołączyć** i nie są trzymane w pamięci: blok klucza prywatnego, identyfikator
`AKIA`/`ASIA`, klucze `sk-` i `sk-ant-`, tokeny `ghp_`, `github_pat_`, `glpat-`, `xox?-`, JWT, adres
z danymi logowania (`://użytkownik:hasło@`) oraz pliki o nazwach takich jak `.env`, `*.pem`, `*.key`.
Skan twardych sekretów obejmuje każdy plik pomocniczy, nie tylko te z trafieniem klasyfikatora.

**Sekrety w `env`.** Wartość trafia do manifestu jako `value` tylko wtedy, gdy ani nazwa, ani
wartość nie wyglądają na sekret. W przeciwnym razie powstaje `envRef` o tej samej nazwie, a raport
wymienia zmienne do uzupełnienia w środowisku. Wartości zmiennych nie pojawiają się w planie, w
raporcie, w `--json` ani w komunikatach błędów.

**Skrypty hooków.** Ścieżki z poleceń hooków (bezwzględne, `~/`, `$HOME/`, `${HOME}/`) są
wykrywane, a istniejące pliki poniżej 1 MiB dostają w raporcie skrót `sha256`. Reszta jest
oznaczona jako "nieprzypięte: zatwierdzasz ścieżkę, nie treść". Skrótów nie zapisuje się w
manifeście, a skryptów nie kopiuje się do rejestru.

#### Przykład

Natywny katalog (`acme-linked` to dowiązanie do innego repozytorium poza `--from`, `acme-reviewer` ma
w frontmatterze klucz `hooks`, `acme-lint` ma obok `SKILL.md` plik `.env`):

```text
/home/user/.claude/
  settings.json
  skills/acme-lint/SKILL.md
  skills/acme-lint/scripts/run.sh
  skills/acme-lint/.env
  skills/Acme-Notes/SKILL.md
  skills/acme-linked  ->  /home/user/work/acme-shared/skills/acme-linked
  agents/acme-planner.md
  agents/acme-reviewer.md
  commands/acme-ship.md
```

```sh
cwm import claude --company acme-a --dry-run
```

```text
Zrodlo: /home/user/.claude
Przestrzen: firma acme-a

RODZAJ    ID                      STATUS  UWAGI
agent     acme-a/acme-planner     nowy    narzedzia (tools/allowed-tools)
command   acme-a/acme-ship        nowy
settings  acme-a/claude-settings  nowy
skill     acme-a/acme-lint        nowy    narzedzia (tools/allowed-tools)
skill     acme-a/acme-notes       nowy    wstawki ! (polecenia przy wczytaniu)

Pochodzenie (zrodlo po realpath, skrot kopiowanego drzewa):
  acme-a/acme-planner: /home/user/.claude/agents/acme-planner.md sha256:dd17e635...
  acme-a/acme-ship: /home/user/.claude/commands/acme-ship.md sha256:a7779987...
  acme-a/claude-settings: /home/user/.claude/settings.json sha256:d2098b4e...
  acme-a/acme-lint: /home/user/.claude/skills/acme-lint sha256:85667ea3...
  acme-a/acme-notes: /home/user/.claude/skills/Acme-Notes sha256:10237d43...

Oznaczone pliki (mozliwy sekret, 1; do przegladu 0, twardych 1):
  skills/acme-lint/.env: Nazwa pliku ".env" wskazuje na dane uwierzytelniajace. [zawsze pominiety]

Raport (9):
  settings.json: hook ~/.claude/hooks/acme-fmt.js: nieprzypiete: zatwierdzasz sciezke, nie tresc (brak pliku)
  settings.json: env: wyglada na sekret, zapisano envRef zamiast wartosci (uzupelnij zmienne srodowiska): ACME_API_TOKEN
  skills/Acme-Notes: nazwa znormalizowana do "acme-notes"
  skills/acme-linked: dowiazanie prowadzi poza katalog --from
  agents/acme-reviewer.md: frontmatter.hooks: Klucz uruchamia kod albo rozszerza uprawnienia: zasob jest odrzucany.
  settings.json: model: poza zakresem importu
  settings.json: statusLine: zabroniony: uruchamia polecenia albo zmienia zrodla pluginow
  settings.json: hooks.PostToolUse[0].hooks[1]: hook typu "http" nie jest obslugiwany (tylko command)
  settings.json: env.ANTHROPIC_BASE_URL: zabroniona zmienna (steruje procesem, silnikiem lub ruchem sieciowym)

Tryb --dry-run: nic nie zapisano.
```

Skróty w przykładzie są obcięte do 8 znaków; polecenie wypisuje pełne 64.

**Sekcje wyjścia.**

1. `Zrodlo` i `Przestrzen`: katalog po `realpath` i przestrzeń docelowa.
2. Tabela planu: `RODZAJ`, `ID`, `STATUS` (`nowy`, `zmieniony`, `bez zmian`) i `UWAGI`. W `UWAGI`:
   `narzedzia (tools/allowed-tools)` i `wstawki ! (polecenia przy wczytaniu)` oznaczają treść z
   polami wykonawczymi, a przy statusie `zmieniony` wpis `zmieniono: ...` wymienia zmienione
   sekcje `Settings` (`hooks`, `permissions`, `env`, `enforce`) albo zmienione pliki innych
   zasobów (do 10). Wartości się tu nie pojawiają.
3. `Pochodzenie`: dla każdego zasobu ścieżka źródła po `realpath` i `sha256` kopiowanego drzewa (dla
   `Settings` skrót bajtów `settings.json`). To jest tylko wyjście polecenia, rejestr tego nie
   przechowuje.
4. `Oznaczone pliki`: lista z punktu wyżej (tekst pokazuje 40 wpisów).
5. `Raport (N)`: najpierw uwagi do importowanych zasobów (normalizacja nazwy, nieznane klucze
   frontmattera, `envRef`, skrypty hooków), potem wszystko, co pominięto. Tekst pokazuje 40
   wpisów, resztę da `--json`.

**Pakiety (ADR 0044).** Po tabeli planu `cwm` pokazuje sekcję „Pakiety”: zasoby są grupowane
automatycznie (import do firmy: jeden pakiet o nazwie firmy; import globalny: wspólny katalog źródłowy po
`realpath` dowiązania, potem wspólny przedrostek nazwy, np. `antislop` i `antislop-ui`, a reszta według
rodzaju: `skills`, `agents`, `commands`, `files`, `settings`). Dla każdego zasobu z polami wykonawczymi
ekran pokazuje pola **w całości**: `allowed-tools`, `tools`, `model`, wstawki `!`, hooki skilla i piny
skryptów (sha256 albo powód braku pinu) oraz ostrzeżenia. `/cwm-pack-profile` w polach to katalog profilu
firmy, na który `cwm start` przepisuje odwołania do `~/.claude`. Zasoby bez pól wykonawczych są tylko
policzone (zapisuje się skrót ich drzewa).

Po potwierdzeniu (`Zapisac N zasobow do rejestru (X nowych, Y zmienionych) i zatwierdzic M pakietow (K zasobow z polami wykonawczymi do zatwierdzenia)?`, domyślnie "nie")
`cwm` zapisuje zasoby, definicje pakietów i zaufane skróty członków; potwierdzenie jest więc też zgodą
na pakiety. Każdy członek jest po zapisie wyprowadzany jeszcze raz z plików na dysku i musi dać skrót z
zatwierdzonego planu; inaczej nie dostaje zgody (komunikat po zapisie). `cwm start` nie pyta potem o
zasoby, których zaufany skrót nadal pasuje (zob. niżej).

**Migracja rejestru bez pakietów.** Ponowny `cwm import` tego samego, niezmienionego źródła ma status
`bez zmian` i nie kopiuje zasobów, ale pyta `Utworzyc i zatwierdzic M pakietow ... Zasoby w rejestrze zostaja bez zmian.`
i zapisuje same definicje i zaufane skróty. Bez terminala nic z tego nie jest zapisywane, a import kończy się kodem `1`
(`ok: false` w `--json`), tak samo jak przy oczekujących zasobach.

Po zapisie `cwm`
wypisuje `Zapisano <rodzaj> <id>` dla każdego zasobu i przypomina, że zasoby są
nieaktywne: id trzeba dopisać do `resources.optional` w `config.yaml` albo do `resources.enable` w
`company.yaml`. Zapis idzie z zatwierdzonego planu, nie z ponownego odczytu źródła. Błąd zapisu
jednego zasobu nie przerywa pozostałych, ale daje kod `1`.

**Ponowny import.** Plan porównuje wynik ze stanem rejestru: `nowy`, `zmieniony` albo `bez zmian`.
Zmieniony zasób zastępuje katalog, a poprzednia wersja zostaje obok jako `.<nazwa>.old-*` (jedna
kopia, pomijana przy odczycie rejestru). Zasoby `bez zmian` nie są zapisywane.

**Bez terminala** (`--json`, `--no-input` albo wyjście nieinteraktywne) import niczego nie zapisuje
(ani zasobów, ani definicji pakietów, ani zgód).
Gdy plan ma coś do zapisania, `cwm` wypisuje go i kończy się kodem `1`; nie ma opcji `--yes`.
Plan do obejrzenia daje `--dry-run` (kod `0`).

**`--json`.** Obiekt `{ ok, dryRun, written, from, target, namespace, items[], skipped[], flagged[], packs[] }`
gdzie `packs[]` to `{ id, definition, pending, members[] }` z `members[]`
`{ key, status, trust, required, tree, exec, warnings }`, a
`items[]` mają `kind`, `id`, `status`, `changes`, `flags`, `notes`, `source`, `sha256`,
`skipped[]` to pary `{ item, reason }`, a `flagged[]` wpisy `{ label, path, reason, line, hard, included }`. Przy zmianach do zapisania bez terminala `ok` to `false`, a
obiekt ma dodatkowo pole `error`.

Kody: `0` (plan wypisany, zapis wykonany albo brak zmian); `1`, gdy firma nie istnieje, `--from`
nie istnieje albo leży w katalogu danych CWM, import przekracza limit, są zmiany do zapisania bez
terminala, użytkownik odmówił albo zapis któregoś zasobu się nie udał; `2` przy braku
`--company` i `--global` bez terminala, przy obu naraz albo niepoprawnym id firmy.

Po imporcie `cwm doctor` i `cwm resource list` widzą nowe zasoby. Z zasobem włączonym w firmie
`cwm resolve` wypisuje jego id w `resolved.skills`, `resolved.commands`, `resolved.files` albo `resolved.settings`.

### `cwm sync`

```text
cwm sync [--source <katalog>] [--dry-run]
```

Odświeża rejestr z natywnych katalogów, z których zasoby zaimportowano (ADR 0045). Źródłem jest
`spec.nativeDir` zasobów `skill`, `agent`, `command` i `files`; zasoby są grupowane po (katalog,
przestrzeń nazw: `global` albo firma), a każda grupa przechodzi ten sam skan, plan i pakiety co
`cwm import claude`. `Settings` nie ma pochodzenia w rejestrze, więc sync go nie dotyka
(`cwm import claude`). Katalog natywny jest tylko czytany.

- **Zmienione i nowe zasoby:** status `zmieniony` i `nowy`, jak w imporcie; nowe trafiają do pakietów,
  ale nie do `resources.optional` ani `resources.enable` (komunikat po zapisie).
- **Pliki oznaczone jako możliwy sekret:** wracają do zasobu tylko wtedy, gdy są już w rejestrze z tym
  samym skrótem pliku (były dołączone przy imporcie i źródło ich nie zmieniło). Plik zmieniony od
  dołączenia wymaga nowej decyzji (domyślnie pominięty, plan to mówi, bo plik znika z zasobu; jego
  kopia zostaje w `.<nazwa>.old-*` do następnego zapisu albo usunięcia zasobu). Pliki dołączone bez
  pytania są wypisane z powodem oznaczenia. Nowe
  pliki oznaczone: wybór na terminalu, domyślnie żaden; twardego sekretu nie da się dołączyć.
- **Zasoby bez źródła** (brak katalogu albo wpisu w katalogu): sekcja `Do usuniecia z rejestru` z
  miejscami, z których usunięcie też wytnie zasób. Po zgodzie znikają: katalog zasobu w rejestrze, wpisy
  w `resources.mandatory/optional` (`config.yaml`), `resources.enable`, `disableOptional` i `exports`
  (`company.yaml`; komentarze i reszta pliku zostają), członkostwo w pakietach (pusty pakiet znika)
  razem z zaufanymi skrótami, oraz wpisy w `approvals/<firma>.yaml`. Zasób pominięty przez skan z
  raportem (kolizja nazw, trafienie w `SKILL.md`) nie jest usuwany, bo jego źródło istnieje; zerwane
  dowiązanie jest zniknięciem źródła. Źródło przejrzane niepełnie (skrócony, pominięty, nieczytelny
  albo niebędący katalogiem obszar `skills`, `agents`, `commands`) niczego nie usuwa. Zasób, którego
  źródło istnieje w innej grupie, zostaje z ostrzeżeniem; zasób zgłoszony przez dwa źródła jest błędem
  obu (kod `1`). Usunięcie kasuje też kopie `.<nazwa>.old-*` i `.<nazwa>.import-*` obok katalogu zasobu.
- **Odmowa:** zasób z `mandatory` albo wymagany przez aktywny zasób (`mandatory`, `optional`, `enable`
  firmy lub projektu z `~/.cwm`) nie jest usuwany; błąd wymienia zależnego albo `config.yaml`. Zależny
  usuwany w tym samym planie nie blokuje. Zablokowane usunięcie odrzuca cały plan (kod `1`, nic nie
  zapisano). Manifest projektu z `~/.cwm` wymieniający usuwany zasób daje ostrzeżenie; projekty
  lokalne (`<projekt>/.cwm`) nie są przeszukiwane.
- **Jedno potwierdzenie** na terminalu dla całego planu (zapis, usunięcia, zgoda pakietów). Wybór
  oznaczonych plików (wielokrotny, domyślnie żaden) poprzedza je jak w imporcie.
- **Bez terminala** (`--json`, `--no-input`, wyjście nieinteraktywne) nic nie jest zapisywane; gdy plan
  ma zmiany, kod `1` (`ok: false`). `--dry-run` pokazuje plan i kończy się kodem `0`.
- `--source <katalog>`: tylko zasoby zaimportowane z tego katalogu (porównanie po `realpath`; katalog
  może już nie istnieć). Brak zasobów z tego źródła to błąd `1`.

Zapis idzie pod mutexem `runtime/global` w kolejności: zasoby i pakiety, czyszczenie odwołań (config, firmy, pakiety, zatwierdzenia),
na końcu katalogi usuwanych zasobów; przerwany sync dokończy kolejne uruchomienie. Źródło, którego nie
da się przejrzeć (nie jest katalogiem, leży w katalogu danych CWM, przekroczono limity), jest błędem
tej grupy: jej zasoby zostają bez zmian, a polecenie kończy się kodem `1`. `--json` wypisuje
`{ ok, dryRun, written, error, sources[], removals[], warnings[], blocked }`; każde źródło ma pola
planu importu (`items`, `skipped`, `flagged`, `packs`) oraz `state` (`ok`, `missing`, `error`),
`autoIncluded` i `changedFlagged`.

### `cwm lock`

```text
cwm lock [--project <katalog>] [--check] [--json]
```

Zapisuje lockfile projektu (ADR 0051): powtarzalny obraz tego, co projekt dostaje po rozwiązaniu, do
wykrywania dryfu między sesjami (zmiana w rejestrze, firmie, pluginie z git albo wersji silnika). Liczy go
z tego samego rozwiązania i planu co `cwm start` (te same błędy, te same pliki zasobów), ale nie generuje
profilu, nie pyta o zatwierdzenia i nie łączy się z siecią. To **nie jest zatwierdzenie**: lockfile niczego
nie zatwierdza ani nie zastępuje zatwierdzeń z `cwm start`.

Plik leży obok manifestu projektu, w tym samym magazynie i z tym samym zakresem zapisu (atomowo, tryb
`0600`, bez dowiązań): `<projekt>/.cwm/cwm.lock` dla `--store local`,
`~/.cwm/companies/<firma>/projects/<id>.lock` dla `--store home`. Jest to JSON z posortowanymi kluczami i
zasobami (`rodzaj:id`), więc dwa zapisy tego samego stanu dają identyczne bajty, a polecenie bez zmian nie
dotyka pliku (`Lockfile bez zmian`).

```json
{
  "apiVersion": "cwm.dev/v1",
  "company": "acme-a",
  "engine": { "name": "claude-code", "version": "2.1.322" },
  "kind": "Lock",
  "project": "demo",
  "resources": [
    {
      "content": "<sha256 treści>",
      "definition": "<sha256 definicji z manifestu>",
      "id": "acme-a/lint",
      "kind": "skill",
      "layer": "company",
      "origin": "optional",
      "version": "1.0.0"
    }
  ]
}
```

Wpis zasobu: `definition` to skrót kanonicznego JSON definicji z manifestu (bez `nativeDir`; wartości `env`
wpisane wprost i nazwy `envRef` wchodzą do skrótu, więc ich zmiana jest dryfem); `content` to skrót treści z plików
źródłowych (przed przepisywaniem odwołań, więc niezależny od maszyny): drzewo skilla i `Files` (`treeSha256`),
plik agenta i komendy, wygenerowana komenda workflow, drzewo pluginu, plik polecenia MCP będącego ścieżką;
`null` dla `Settings` i MCP bez pliku. `pins` to skrót skrótów skryptów hooków przypiętych przez plan.
Plugin z git ma `git: { commit, tree }`, plugin z marketplace'u `marketplace: { name, version }`. Wersja
silnika pochodzi z `claude --version` (ta sama proba co w `cwm start`: bezpieczny plik silnika, minimalne
środowisko, limit czasu); brak silnika albo nieudana proba to `null`, nie błąd. W pliku nie ma czasu, nazwy
hosta, ścieżek bezwzględnych ani jawnych wartości (tylko nazwy, wersje i skróty). Skróty nie są jednak tajne
(bez HMAC): krótki sekret osadzony w `args` serwera MCP albo w poleceniu hooka dałoby się zgadnąć ze skrótu, więc
nie commituj lockfile projektów, których zasoby osadzają dane uwierzytelniające (użyj `envRef`). Plik zawiera id
zasobów (także prywatnych), firmy i projektu, więc jego udostępnienie ujawnia te nazwy.

`--check` niczego nie zapisuje i porównuje zapisany lockfile z aktualnym stanem: kod `0` przy zgodności, `1`
przy dryfie (zasób dodany, usunięty, ze zmienionym polem: `version`, `definition`, `content`, `pins`, `git`,
`marketplace`, `origin`, `layer`; zmieniona firma lub projekt; zmieniona wersja silnika, gdy znane są obie), z
listą różnic. Wersja silnika nieznana po jednej ze stron nie jest dryfem. Brak lockfile, plik uszkodzony,
obcy (inna wersja formatu, nieznane pole), będący dowiązaniem albo większy niż 8 MiB to błąd z kodem `2`
(jak w `cwm diff`, gdzie `1` oznacza różnicę). Bez `--check` uszkodzony lockfile nie jest nadpisywany: usuń go
ręcznie i uruchom `cwm lock` ponownie (może pochodzić z nowszej wersji CWM). `cwm lock` i `cwm diff` uruchamiają `claude --version`
(w katalogu tymczasowym systemu, z limitem czasu; każdy błąd to wersja `null`). `--json`: zapis
`{ ok, written, created, file, resources, engine, drift, warnings }`, `--check` `{ ok, state, drift, warnings }` (`warnings`: wersja silnika bez sprawdzenia flag, zob. `cwm engine`).

**Użycie w `cwm start`, `cwm run` i `cwm diff`.** Gdy lockfile istnieje, po rozwiązaniu i przed
zatwierdzeniami start porównuje go z aktualnym stanem. Dryf zasobów to ostrzeżenie z podsumowaniem
(`dodane N, usuniete N, zmienione N`) i podpowiedzią `cwm lock --check` oraz `cwm lock`; start idzie dalej.
Inna wersja silnika to w lockfile zawsze tylko ostrzeżenie (ADR 0036 pkt 10; sprawdzenie flag silnika to osobna rzecz, zob. `cwm engine`). Tryb **frozen** zamienia dryf zasobów
w odmowę startu (kod `1`, przed pytaniami): `--frozen` w `cwm start`, `cwm run` i `cwm diff` albo
`spec.lock: frozen` w `project.yaml`; w tym trybie także brak lockfile jest odmową z podpowiedzią
`cwm lock`. Uszkodzony lockfile bez frozen to ostrzeżenie z podpowiedzią usunięcia pliku (`cwm lock` go nie nadpisuje, `cwm lock
--check` daje kod `2`), we frozen odmowa. `--dry-run` i `--json` pokazują stan
(`lock.state`: `absent`, `match`, `drift`, `invalid`). Frozen to wykrywanie dryfu, nie ochrona integralności i
nie zastępuje zatwierdzeń: kto zmieni zasoby, może zapisać też lockfile.

Lockfile nie obejmuje plików spoza rejestru poza przypiętymi skryptami hooków ani zmian samego profilu
(od tego jest `cwm diff`). `<projekt>/.cwm/` jest zwykle ignorowane przez git; żeby dzielić lockfile z
zespołem, wyłącz ignorowanie samego `cwm.lock`.

### `cwm start`

```text
cwm start [--project <katalog>] [--strict-mcp] [--frozen] [--dry-run] [--verbose] [--json] [-- <argumenty silnika>]
```

`--dry-run` pokazuje podsumowania: liczbę zatwierdzonych zasobów (osobno tylko nowe, zmienione i z uwagami),
liczbę plików i jedną linię o przepisanych odwołaniach do natywnego katalogu konfiguracji. `--verbose` przywraca
pełne listy; `--json` zawsze zawiera wszystko (w tym `rewrittenByResource`).

Składa konfigurację projektu (jak `cwm resolve`), generuje profil firmy i uruchamia Claude Code
w katalogu projektu. Kolejność jest wiążąca (APR-04): resolve, plan generowania w pamięci,
skróty zatwierdzeń liczone z tych samych bajtów, zatwierdzenie, zapis dokładnie tych bajtów,
odczyt kontrolny, `spawn`. Katalogiem silnika jest katalog projektu z manifestem (też przy
wywołaniu z podkatalogu), nie `cwd`.

**Zatwierdzenia.** Wymagają ich: każdy serwer MCP, plugin `local`, `marketplace` i `git`, `Settings`, skill, agent,
komenda i workflow `instructional` z `allowed-tools`, `tools` albo wstawkami `!` (liczone z plików, nie z flag w manifeście)
para (katalog projektu po `realpath`, firma, z listą zasobów włączonych przez projekt) oraz opcje
uruchamiania firmy (`company:<id>`: `runtime.claude.path`, `env.passthrough`, `isolation`). Skrót
obejmuje wszystkie pola wykonawcze (zob. ADR 0040): uprawnienia, `env`, hooki wraz z `sha256`
wskazanych skryptów, dla pluginu listę plików, hooki oraz serwery MCP i LSP z jego JSON-ów i
odwołania manifestu, dla serwera MCP z poleceniem-ścieżką plik polecenia (`realpath` i `sha256`,
bez limitu rozmiaru), a dla skilla i komendy pełne `allowed-tools` i wstawki `!`. Polecenie MCP,
którego nie da się przypiąć (brak pliku, dowiązanie poza projekt), przerywa start.

Zatwierdzenie serwera MCP ma klucz `mcp:<id>@<skrót-projektu>` tylko wtedy, gdy `command` jest
ścieżką (zawiera `/`): katalog projektu wchodzi wtedy do skrótu. Dla polecenia z `PATH` (`npx`,
`node`) klucz to `mcp:<id>`, a katalog projektu w skrócie to `null`, więc zatwierdzenie obowiązuje
w każdym projekcie. Wygenerowany `mcp.json` ma bezwzględną ścieżkę pliku polecenia po `realpath`
(tego, który został zahaszowany).

**Skanowanie pluginu `local` i `marketplace`.** `hooks/hooks.json`, `.mcp.json`, `.lsp.json` i
`.claude-plugin/plugin.json` są znajdowane bez rozróżniania wielkości liter. Odwołania `plugin.json`
(`hooks`, `mcpServers`, `lspServers` jako ścieżka, lista ścieżek albo obiekt, oraz ścieżki
`commands`, `agents`, `skills`, `outputStyles`) wchodzą do zatwierdzenia. Błędem, który przerywa
start, jest odwołanie poza drzewo pluginu (ścieżka bezwzględna, `..`), do brakującego pliku, z
wartością złego typu oraz nieznany klucz `plugin.json` (dozwolone poza tym tylko metadane: `name`,
`version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`). Zawartość
katalogów wskazanych przez `commands`, `agents`, `skills` i `outputStyles` nie jest analizowana
(zob. ADR 0040, ryzyko szczątkowe). Zasób `mandatory` nie omija zatwierdzenia. Zatwierdzenie jest zapamiętane w
`~/.cwm/approvals/<firma>.yaml`; każda zmiana pola wykonawczego wywołuje ponowne pytanie, z
różnicą „było/jest” i pełnymi wartościami. Domyślna odpowiedź to „nie”. **Bez terminala** (stdin i
stdout nie są terminalem, albo `--json`, `--no-input`) start niczego nie zatwierdza: kończy się
kodem `1` i listą kluczy ze skrótami, chyba że wszystko jest już zatwierdzone. Nie ma `--yes`.
Przed pytaniami `start` wypisuje ostrzeżenia planu oraz ostrzeżenia zasobów już zatwierdzonych.

**Pluginy z git** (`source.type: git`, ADR 0048). `cwm start` czyta tylko lokalną kopię przypiętego commita z `~/.cwm/sources/git/` (bez `git`, bez sieci); brak kopii albo brak `source.commit` to błąd z poleceniem `cwm plugin fetch <id>`. Dalej ta sama droga co plugin `local`; pola zatwierdzenia dostają blok `git` (zob. `cwm plugin`).

**Pluginy z marketplace'u** (`source.type: marketplace`, ADR 0043). `cwm start` czyta
`marketplace.json` z zarejestrowanego katalogu (kontrola i limity: zob. `cwm marketplace`), wybiera
wpis o nazwie z `source.plugin` i wyznacza katalog pluginu ze `source`: każdy składnik ścieżki musi
być zwykłym katalogiem (dowiązanie, nawet w obrębie marketplace'u, to odmowa), a wynik po
`realpath` leży w marketplace'ie. Dalej to ta sama droga co plugin `local`: drzewo (`readTree`,
limity 500 plików i 10 MiB, dowiązanie w drzewie to błąd), migawka `plugins/<id>@<skrót>`, skan
deklaracji wykonawczych (hooki, `.mcp.json` z `headersHelper`, `.lsp.json`, `plugin.json`),
piny skryptów, zatwierdzenie. Pola zatwierdzenia dostają blok `marketplace` (nazwa marketplace'u,
nazwa wpisu, tekst `source`, katalog marketplace'u i rozwiązana ścieżka pluginu po `realpath`), więc
zmiana któregokolwiek z nich pyta ponownie, nawet gdy drzewo jest to samo. Dopisanie innych
pluginów do `marketplace.json` nie zmienia skrótu. Skróty pluginów `local` się nie zmieniają.
Ostrzeżenie (bez blokady): `version` w `plugin.json` albo we wpisie różni się od `version` zasobu.
Po odczycie drzewa `start` sprawdza, że katalog pluginu nadal rozwiązuje się do tej samej ścieżki.

**Profil** (`~/.cwm/runtime/<firma>/`, tryby 700/600, właściciel musi być bieżącym użytkownikiem):

```text
claude/                      CLAUDE_CONFIG_DIR
  settings.json              Settings bez enforce (hooki, uprawnienia, env z value)
  CLAUDE.md                  instructions.file firmy (jeśli ustawione)
  skills/ agents/ commands/  zasoby optional, zwykłe nazwy; Files pod claude/<root>/<ścieżka>
sessions/<skrót projektu>/   pliki tego uruchomienia
  settings.json              jedyny plik --settings: Settings z enforce, klucze izolacji
  mcp.json                   serwery MCP jako cwm-<firma>-<nazwa>, env tylko jako ${NAZWA}
  plugin/                    plugin cwm-<firma> z zasobami mandatory (nazwy z przedrostkiem)
plugins/<id>@<skrót>/        migawki pluginów local i marketplace (kopia, nie oryginał)
generated/manifest.json      lista plików CWM ze skrótami; sprzątanie tylko według niej
generated/prev/              kopia plików sprzed ostatniej zmiany
tmp/                         CLAUDE_CODE_TMPDIR
active/<pid>.json            znaczniki trwających sesji (blokada profilu)
```

Zasoby `Files` zawsze trafiają do profilu pod zwykłą ścieżką `claude/<root>/<ścieżka>`, także gdy
są `mandatory`: to dane, nie polecenia, a agenci odwołują się do nich po ścieżce, której plugin
by zmienił. Zatwierdzenia wymaga tylko `Files` z `agents/`, w którym plik `.md` ma frontmatter
agenta z wstawkami `!`.

**Odwołania do natywnego katalogu.** W kopiach skilli, agentów, komend i `Files` odwołania do
`~/.claude`, `$HOME/.claude`, `${HOME}/.claude` i bezwzględnej ścieżki katalogu domowego (też po
`realpath`) są przepisywane na ścieżkę profilu (`CLAUDE_CONFIG_DIR`), żeby sesja nie czytała
prawdziwego katalogu natywnego. Dopasowanie kończy się na granicy nazwy (`~/.claude.json` zostaje).
Przepisywane są pliki tekstowe bez bitu wykonywania; skrypty wykonywalne i pliki binarne nie.
Przepisana treść jest częścią planu i skrótów zatwierdzenia (APR-04). `cwm start --dry-run` podaje
liczbę per zasób i łącznie (`rewrittenReferences` w `--json`). Polecenia hooków nie są
przepisywane: zostają przypięte do prawdziwych skryptów. Katalog `--from` jest zapisany w manifeście zasobu (`spec.nativeDir`), więc jego odwołania są
przepisywane także wtedy, gdy leży poza katalogiem domowym. Po aktualizacji zatwierdzenia zasobów
wspominających katalog natywny zostaną zapytane raz ponownie (zmienia się treść po przepisaniu).

Zasoby `mandatory` (poza `Files`) trafiają do pluginu przekazanego przez `--plugin-dir`, więc projekt nie może
ich zasłonić. Zasoby `optional` mają zwykłe nazwy; kolizja z natywnym `.claude/` projektu (cwd,
katalogi nadrzędne do korzenia repozytorium, `--add-dir`, dwa poziomy w głąb) daje ostrzeżenie.
CWM nie zapisuje `.claude.json` ani innych plików silnika i usuwa tylko pliki z własnego manifestu,
których skrót się zgadza. `settings.json` profilu zmieniony przez silnik jest zastępowany z kopią w
`generated/prev/` i ostrzeżeniem z nazwami zmienionych kluczy. Plik istniejący w profilu, a nie
pochodzący z CWM (poza `settings.json`), przerywa start.

**Blokada.** Gdy trwa sesja tej firmy (znacznik `active/`, żywy PID CWM albo silnika) z innym
profilem, start odmawia: silnik przeładowuje `settings.json` profilu na żywo (V-03). Ten sam profil: start bez
regeneracji. Pliki `sessions/` są niezmienne w trakcie sesji, bo `--settings` jest czytany raz.

**Silnik.** Ścieżka z `runtime.claude.path` albo z bezwzględnych elementów `PATH` (po `realpath`,
właściciel root lub bieżący użytkownik, bez zapisu dla grupy i innych, poza katalogiem projektu).
Uruchomienie: `shell: false`, `stdio: inherit`, `SIGTERM` przekazany dziecku (SIGINT i SIGHUP
dziecko dostaje samo z terminala), kod wyjścia przekazany dalej (sygnał to 128+n). Środowisko dziecka nie jest
`process.env`: bez `envRef` innych firm, nazw wyglądających na sekret i rodziny
`ANTHROPIC_*`/`CLAUDE_*` (wyjątki: własne `envRef` firmy i `runtime.env.passthrough`), z
oczyszczonym `PATH` (bez elementów w katalogu projektu), `CLAUDE_CONFIG_DIR` i `CLAUDE_CODE_TMPDIR`.
Usuwane są też `envRef` z rejestru, których ta firma nie używa, oraz wartości o kształcie sekretu
(prefiksy dostawców, JWT, PEM, `://user:hasło@`). `SSH_AUTH_SOCK` jest usuwany; wraca przez
`runtime.env.passthrough`. `envRef` z `Settings.env`
trafia wyłącznie do środowiska dziecka. Brak albo pusta zmienna `envRef` kończy się kodem `1`.
Na Windowsie `start` odmawia. Wersja silnika inna niż 2.1.322 i bez zapisanego sprawdzenia daje ostrzeżenie
z podpowiedzią `cwm engine check`; `cwm start` i `cwm run` (bez `--dry-run`) robią takie sprawdzenie same, patrz
`cwm engine`: brak flagi, którą CWM podaje silnikowi, to odmowa kodem `1` przed pytaniami i zapisem profilu.

**Argumenty silnika** (po `--`) trafiają do silnika po flagach CWM (`--plugin-dir=...`,
`--mcp-config=...`, `--strict-mcp-config`, na końcu `--settings <plik>`). Samo `--` jest dodawane
tylko wtedy, gdy wszystkie argumenty to tekst promptu. Kod `2` dają: `--settings`, `--mcp-config`,
`--strict-mcp-config` (użyj `--strict-mcp`), `--plugin-dir`, `--plugin-url`, `--setting-sources`,
`--bare`, `--safe-mode`; `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
`--permission-mode bypassPermissions`, `--agents`, `--debug-file`, `--file`, `--desktop`,
`--cloud`, `--teleport`, `--remote-control`, `--environment`; każdy argument pozycyjny będący
podpoleceniem silnika lub jego aliasem (`agents`, `attach`, `auth`, `auto-mode`, `config`, `doctor`,
`gateway`, `import`, `install`, `kill`, `logs`, `mcp`, `plugin`, `plugins`, `purge`, `respawn`,
`rm`, `setup-token`, `stop`, `ultrareview`, `update`, `upgrade`); drugie `--`.

**`--dry-run`.** Niczego nie zapisuje (ani profilu, ani zatwierdzeń) i nie uruchamia silnika
(poza `claude --version` do ustalenia wersji). Wypisuje: ścieżkę i wersję silnika, stan zatwierdzeń
każdego zasobu (zatwierdzone, NOWE, ZMIENIONE, z ostrzeżeniami), listę plików do wygenerowania,
argumenty silnika oraz nazwy (nigdy wartości) zmiennych usuniętych i dodanych do środowiska.
Kod `0`, gdy właściwy start zostałby przyjęty, inaczej `1` z listą powodów. Z `--json` ten sam
zakres jako obiekt (`ok`, `approvals[]` ze skrótami i różnicami, `files`, `argv`, `env`,
`blockers`).

`--strict-mcp` dodaje `--strict-mcp-config`: tylko serwery z CWM (wyłącza MCP pluginów
konta, konektory claude.ai i `.mcp.json` projektu). Pluginy, skille i konektory konta wyłączają
klucze izolacji (`syncClaudeAiPlugins: false`, `syncClaudeAiSkills: false`,
`disableClaudeAiConnectors: true`), ustawiane domyślnie w pliku `--settings`;
`runtime.isolation: false` w manifeście firmy je pomija (izolacja jest domyślnie włączona).

Przy więcej niż jednym nowym zasobie bez ostrzeżeń `cwm start` wypisuje najpierw wszystkie zasoby
do zatwierdzenia z polami w całości, a potem pyta raz: zatwierdzić wszystkie nowe zasoby bez
ostrzeżeń, pytać o każdy osobno albo przerwać. Zasoby zmienione i zasoby z ostrzeżeniem (np. skill
z hookami, manifest projektu) zawsze dostają osobne pytanie, także po wyborze zatwierdzenia zbiorczego.

**Pakiety (ADR 0044).** Skill, agent, komenda, `Files` i `Settings`, które należą do pakietu, nie
dostają pytania, gdy ich zaufany skrót z `cwm import` nadal pasuje: ten sam skrót definicji, drzewa
z rejestru i pól wykonawczych niezależnych od firmy (`allowed-tools`, `tools`, `model`, wstawki `!`,
hooki, piny skryptów spoza profilu). Odwołania do `~/.claude` w tych polach są porównywane po zamianie
ścieżki profilu firmy na znacznik, a plan musi dać to samo, co wyprowadzenie z rejestru. Skrypt hooka,
który po przepisaniu leży w profilu, musi pochodzić z zasobu tego samego lub innego pakietu o zgodnym
zaufanym skrócie drzewa (zmiana skryptu w `Files` pyta o skill, który go uruchamia). `--dry-run` pisze
przy takim zasobie `zatwierdzone ...; pakiet <id> zatwierdzony <data>`. Zgoda zapisana per firma
(`approvals/<firma>.yaml`) ma pierwszeństwo.

Skrypt hooka dostarczany przez inny zasób jest zapisany jako powiązanie (właściciel i skrót jego drzewa); inny właściciel, właściciel spoza pakietu albo z innego pakietu wymaga zgody. Ekran importu pisze „właściciel ustalany przy starcie”, gdy plan importu go nie zna.

Gdy zasób pakietu jest nowy albo zmieniony (także po ręcznej edycji plików w rejestrze), `cwm start`
pyta **raz na pakiet**: wypisuje dodane zasoby z polami w całości, zmienione z polami `bylo`/`jest`
(dla drzewa także listę zmienionych plików), zasób ze zmienionym skryptem hooka i zasoby usunięte z rejestru,
a potem `Zatwierdzic zmiany w pakiecie <id> (N zasobow)?`. Odmowa przerywa start i nic nie zapisuje;
zgody są zapisywane na końcu, razem ze zwykłymi zatwierdzeniami. Do zaufanych skrótów trafiają tylko
zasoby pokazane w pytaniu. Zasób, którego pól nie da się wyprowadzić niezależnie od firmy (skrypt hooka
bez właściciela w pakiecie, polecenie hooka ze ścieżką profilu wpisaną wprost, niezgodność planu z
rejestrem), jest w tym pytaniu oznaczony `WYMAGA ZGODY FIRMY` z powodem i zatwierdzany jak dotąd
w `approvals/<firma>.yaml`. Bez terminala niezatwierdzone zasoby pakietów kończą start kodem `1` (z nazwą
pakietu). `--json` w `--dry-run` ma przy takich zasobach pola `pack`, `packState`, `packChanges`,
`packBlockers`. Uszkodzony plik zaufanych skrótów pakietu przerywa start.

### `cwm diff`

```text
cwm diff [--project <katalog>] [--stat] [--frozen] [--json]
```

Pokazuje, co zmieni najbliższy `cwm start` w profilu firmy (ADR 0047). Buduje ten sam plan co start
(rejestr, resolver, pakiety, zatwierdzenia) i porównuje go z plikami w `~/.cwm/runtime/<firma>/` oraz z
manifestem `generated/manifest.json`. Działa **tylko na odczyt**: nie zapisuje niczego w `~/.cwm` ani w
projekcie, nie tworzy katalogu firmy, nie bierze blokady `.lock` (nie przeszkadza działającej sesji ani
`cwm start`) i nie uruchamia silnika (poza `claude --version` dla stanu lockfile). Projekt jest wyszukiwany jak w `cwm start` (bieżący katalog i
wyżej albo `--project`).

Wynik w grupach:

- **Dodane** i **Usunięte:** ścieżka względna wobec `runtime/<firma>`, rozmiar i skrót SHA-256.
- **Zmienione:** rozmiar i skrót przed i po, liczniki `+N -M` oraz ujednolicony diff (3 wiersze
  kontekstu) dla plików tekstowych, w których po obu stronach jest najwyżej 200 wierszy; dłuższe
  pliki mają same liczniki. Plik z samą zmianą trybu (0600/0700) jest opisany jako „tylko tryb pliku”.
- **Zmienione poza CWM:** plik profilu, który różni się od manifestu (np. silnik dopisał
  `settings.json`). Start go nadpisze i zachowa kopię w `generated/prev`; ekran podaje przy
  `settings.json` nazwy zmienionych kluczy najwyższego poziomu.
- **Pluginy:** jeden wpis na plugin (nowy, zmieniony z liczbą dodanych, zmienionych i usuniętych plików
  między migawkami, usuwany).
- **Zostają na miejscu:** pliki z manifestu zmienione poza CWM, których start nie usunie.
- **Start zostałby odrzucony:** plik spoza CWM w miejscu pliku z planu, niebezpieczny plik w profilu,
  trwająca sesja firmy z innym profilem albo (w trybie frozen) uszkodzony lockfile, brak lockfile lub dryf.
- **Lockfile:** jedna linia stanu (`zgodny`, `dryf` z listą różnic, `brak lockfile`, `uszkodzony`; ADR 0051) z
  tą samą oceną co w `cwm start`. Sam dryf (bez frozen) jest informacją i nie zmienia kodu wyjścia; do
  porównania wersji silnika diff uruchamia `claude --version` (jedyny proces, null przy niepowodzeniu).

Pliki uruchomienia (`sessions/<projekt>/settings.json`, `mcp.json`, `plugin/`) są porównane ze stanem
po ostatniej sesji tego projektu; bez niej są „dodane”. Zatwierdzenia: jedna linia z liczbą zasobów do
zatwierdzenia i pakietami do ponownej zgody (szczegóły w `cwm start --dry-run`).

Czego **nie** widać: treści pliku oznaczonego jako możliwy sekret (nazwa albo treść, klasyfikator jak w
imporcie), pliku binarnego i większego niż 512 KiB (zostaje „treść ukryta” z powodem), oraz zawartości
`env` w plikach JSON: w `settings.json` i `mcp.json` wartość każdego klucza `env` jest zastąpiona
znacznikiem, a zmiana jest zgłoszona słowami (`env zmieniony (treść ukryta)`).

`--stat` pomija wiersze diffu. `--json` wypisuje `{ ok, differs, company, project, profile{dir, exists,
manifest}, approvals{total, approved, pending, pendingResources[], packsToReapprove[]}, files[],
plugins[], kept[], unchanged, lock{state, frozen, error, drift, blockers, warnings}, blockers[], warnings[] }`; `files[]` ma `path`, `area`
(`profile`, `session`), `status` (`added`, `changed`, `removed`), `outsideCwm`, `action`, rozmiary i
pełne skróty przed i po, `lines`, `hunks`, `hidden`, `notes`. Kody wyjścia: `0` brak różnic, `1` start
coś zmieni albo odmówi (zob. wyżej), `2` błąd użycia lub ustawienia (brak manifestu projektu,
uszkodzony manifest, zła opcja). Pominięte w porównaniu: `generated/manifest.json`, `.lock`, `active/`,
`tmp/`.

### `cwm engine`

```text
cwm engine check  [--project <katalog>] [--json]
cwm engine status [--project <katalog>] [--json]
```

Sprawdzenie nowej wersji silnika (ADR 0052, ADR 0036 pkt 10). Claude Code aktualizuje się sam, więc po każdym
wydaniu wersja różni się od przetestowanej (2.1.322). Zamiast ostrzegać za każdym razem, CWM sprawdza, czy flagi, na
których stoi, nadal istnieją, i zapamiętuje wynik dla tej wersji.

`check` uruchamia cztery polecenia metadanych pliku silnika: `--version`, `--help`, `plugin --help`, `mcp --help`.
Nic więcej: bez `-p`, bez logowania, bez modelu. Plik silnika jest wybierany jak w `cwm start` (`runtime.claude.path`
firmy projektu albo `PATH`; bez projektu tylko `PATH`), środowisko jak przy `claude --version` (minimalne, z
`CLAUDE_CONFIG_DIR` w pustym katalogu tymczasowym 0700, który jest usuwany po sprawdzeniu), z limitem czasu (10 s na
polecenie) i wyjścia; z `PATH` próby wypadają elementy w katalogu projektu, a proces i jego potomkowie są kończeni
razem (osobna grupa procesów); po dwóch przekroczeniach czasu reszta poleceń jest pomijana. Wynik:

| Wynik | Znaczenie | Kod |
|---|---|---|
| `ok` | wszystkie flagi, które CWM podaje silnikowi (`--settings`, `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`), są w `--help`; wynik jest zapisany w `~/.cwm/runtime/engine-checks.json` (skrót pomocy, bez jej tekstu) | `0` |
| `missing-flags` | którejś z tych flag nie ma; silnik nie zrozumie argumentów; nic nie jest zapisane | `1` |
| `unverified` | nie udało się odczytać wersji albo pomocy, pomoc ma nieznany układ, albo `--version` w trakcie sprawdzenia dało inną wersję niż przed nim; nic nie jest zapisane | `1` |

Do wyniku `ok` dochodzą ostrzeżenia (nie blokują): podpolecenia w `--help` spoza listy, którą CWM blokuje po `--`
(`cwm start -- <podpolecenie>` jest dla nich otwarte), oraz nowe flagi o nazwach zawierających `dangerous`, `permission`, `bypass`, `yolo`, `trust`, `allow`, `sandbox`,
`add-dir`, `hook`, `config`, `setting`, `plugin`, `mcp` albo `skip`, których CWM nie zna (flagi pasujące do wzorca, ale
obecne już w 2.1.322 i 2.1.323, jak `--add-dir` czy `--permission-mode`, są w bazie i nie ostrzegają). Flagi z list CWM, których silnik już nie ma, i
polecenia metadanych bez wyniku są tylko wypisane. Sprawdzenie dotyczy wyłącznie interfejsu wiersza polecen: nie
dowodzi, że zachowanie sesji (hooki, MCP, izolacja profilu; V-01 do V-08 w ADR 0036) jest takie jak w 2.1.322.

**Wynik jest związany z plikiem silnika** (ścieżka po `realpath`, rozmiar, czas modyfikacji). Ta sama wersja w innym
pliku albo po jego zmianie to „inny plik”: jak niesprawdzona, więc `start` sprawdza ponownie, a `--dry-run`, `diff` i
`lock` ostrzegają. To zgodność z uczciwym dryfem (aktualizacja, inna wersja), nie obrona przed wrogim plikiem silnika.

**Fail-open.** Gdy sprawdzenia nie da się ocenić (`unverified`), `cwm start` ostrzega i uruchamia silnik, bez zapisu
wyniku. Odmowa dotyczy wyłącznie udowodnionego braku flagi, którą CWM podaje silnikowi.

`status` pokazuje plik i wersję silnika oraz stan: przetestowana (2.1.322), sprawdzona (z datą, skrótem pomocy i
zapisanymi ostrzeżeniami), wynik dla innego pliku (z zapisaną ścieżką i rozmiarem) albo niesprawdzona, i listę
sprawdzonych wersji. Tylko odczyt.

**Kiedy to się dzieje samo.** `cwm start` i `cwm run` bez `--dry-run`, przy wersji innej niż przetestowana i bez
zapisanego wyniku, wykonują sprawdzenie przed zatwierdzeniami (kilka sekund) i zapisują wynik `ok`. Brak flagi kończy
się odmową z kodem `1` i silnik się nie uruchamia; nieudane sprawdzenie (`unverified`) daje ostrzeżenie i start idzie
dalej, a następny start powtórzy próbę. Drugi start tej samej wersji nie ostrzega ani nie sprawdza. `--dry-run`,
`cwm diff` i `cwm lock` tylko czytają zapisany wynik: przy wersji bez wyniku ostrzegają (`cwm engine check`), niczego
nie uruchamiają i nie zapisują (poza `claude --version`, jak dotąd). W `--dry-run --json` pole `engine.check` to
`expected`, `checked`, `other-binary` albo `unchecked`.

```sh
cwm engine status
cwm engine check --json
```

Z `--json` (`check`): `{ ok, engine: { path, source, version }, expectedVersion, verdict, missingFlags[],
newSubcommands[], suspiciousFlags[], goneFlags[], unavailable[], problems[], stored, warnings[] }`; `status`:
`{ ok, engine, expectedVersion, state, check, checkedVersions[] }`.

### `cwm pack`

```text
cwm pack list
cwm pack show <id>
cwm pack rename <id> <nowa-nazwa>
cwm pack move <rodzaj:id> <pakiet>
```

Pakiety zasobów (ADR 0044): grupy zatwierdzane razem przy `cwm import claude`. Id pakietu to
`<przestrzeń>/<nazwa>` (`global/gstack`, `acme-a/acme-a`), a zasób może należeć najwyżej do jednego.
`list` wypisuje pakiety, liczbę zasobów, liczbę zatwierdzonych i datę ostatniej zgody. `show` czyta
rejestr i dla każdego zasobu pokazuje stan wobec zaufanego skrótu (`zatwierdzony`, `zmieniony od zgody`,
`bez zgody`, `brak w rejestrze`) oraz źródło zgody (`import` albo `start`). `rename` zmienia nazwę
(zgoda zostaje, bo skrót członka nie zawiera nazwy pakietu); `move` przenosi zasób do pakietu z tej
samej przestrzeni nazw (pakiet docelowy powstaje, jeśli go nie ma), ale **zgoda nie przechodzi razem z zasobem**:
`cwm start` zapyta raz o pakiet docelowy. Definicje to zwykłe pliki YAML w `~/.cwm/packs/`; nie edytuj
zaufanych skrótów w `~/.cwm/approvals/packs/`, bo ich skrót jest sprawdzany przy odczycie.

### `cwm approvals`

```text
cwm approvals list [--company <id>]
cwm approvals revoke <klucz> [--company <id>]
cwm approvals revoke pack:<przestrzeń>/<nazwa>
cwm approvals revoke --company <id>
cwm approvals revoke --all
```

`list` wypisuje klucz (np. `mcp:global/acme-docs`, `mcp:global/acme-tool@<skrót-projektu>`, `settings:acme-a/guard`, `company:acme-a`,
`project:<skrót>`), skrót, wersję, datę i ścieżkę projektu. `revoke` usuwa wpisy zatwierdzeń i od razu
unieważnia wygenerowany profil dotkniętych firm (usuwa pliki z manifestu o zgodnym skrócie), więc
kolejny `cwm start` pyta ponownie. Gdy silnik zmienił `settings.json` profilu, `revoke` zapisuje
kopię w `generated/revoked/` i usuwa z pliku klucze `hooks`, `permissions`, `env`; jeśli czegoś z CWM
nie da się usunąć, kończy się kodem `1`. **Działająca sesja nie traci wczytanych hooków ani serwerów
MCP**; trzeba ją zamknąć. Zatwierdzenia są zapisywane pod blokadą firmy; przy zapisie znikają wpisy
zasobów, których nie ma w rejestrze, i projektów, których katalogu nie ma. Klucz pary projekt-firma
to `project:<sha256 ścieżki>` (ścieżka widoczna w `list`). Zgody pakietów mają klucz `pack:<id>` i
są wspólne dla firm: `list` pokazuje je w kolumnie `FIRMA` jako `(wszystkie)`, a `revoke pack:<id>`
usuwa zaufane skróty pakietu i unieważnia profile wszystkich firm (z `--company` jest błędem użycia).
`revoke <klucz zasobu>` bez `--company` usuwa też zaufany wpis zasobu z pakietów; z `--company` (albo `revoke --company <id>`) wypisuje ostrzeżenie o zasobach nadal objętych zgodą pakietów.
`revoke --all` odwołuje też wszystkie pakiety. Zgody firm na te same zasoby są osobne i zostają.
Uszkodzony plik zatwierdzeń oznacza „nic nie jest zatwierdzone”
(kod `1`).

### `cwm run`

```text
cwm run <zadanie...> [--workflow <id>] [--project <katalog>] [--strict-mcp] [--frozen] [--dry-run] [--verbose] [--explain] [--json]
```

Dobiera workflow do opisu zadania i uruchamia `cwm start` z poleceniem tego workflow jako
pierwszym poleceniem sesji (ADR 0049). Po `prepareRun` wspólnym ze startem liczy wynik każdego aktywnego
workflow projektu, pokazuje wybór (workflow, wynik, powód: które słowa kluczowe i jaki przykład
trafiły, dwaj kolejni kandydaci), a potem wykonuje resztę `cwm start` tym samym kodem: zatwierdzenia,
izolacja, blokady sesji, zapis profilu, argumenty silnika. Silnik dostaje `-- /<polecenie> <zadanie>`
jako jeden argument (bez powłoki); zadanie zaczynające się od `-` podaj po `--`:
`cwm run -- "-x popraw test"`.

**Wynik.** Słowo kluczowe (po `foldName`, na granicach słów, także fraza wielowyrazowa): 4 pkt i
2 pkt za każde kolejne słowo frazy. Przykład: do 6 pkt za pokrycie jego znaczących słów (krótkie i
pospolite odpadają; jedno wspólne słowo liczy się za pół). `priority`: do +2 pkt, tylko przy
istniejącym trafieniu. Wybierany jest lider z wynikiem co najmniej 4 i przewagą co najmniej 1 pkt.
Remis albo brak trafienia: na terminalu lista do wyboru, bez terminala (i przy `--dry-run`) błąd z
listą i podpowiedzią `--workflow`. Workflow domyślny (`spec.workflows.default` projektu, potem
`workflows.default` firmy) wygrywa tylko bez wyraźnego trafienia albo rozstrzyga remis, w którym
uczestniczy. `routing.mode: manual` i brak `routing` wyłączają workflow z automatu.

`--workflow <id>` pomija routing (pełne id albo sama nazwa, gdy jest jednoznaczna). `--dry-run` pokazuje
wybór i plan startu jak `cwm start --dry-run`, niczego nie zapisuje i nie pyta. `--explain` dodaje
tabelę wyników wszystkich workflow. `--json` wymaga `--dry-run` i dokłada do dokumentu startu pole
`workflow { id, basis, default, command, minScore, scores[], warnings[] }`. Zadanie: niepuste, do 4000
znaków, bez znaków sterujących i formatujących (poza nową linią i tabulatorem); nie jest zapisywane w
profilu ani w logu. Argumenty silnika (`--model` itp.) nie są w tym etapie przyjmowane. Kody wyjścia jak w
`cwm start`; `2` także dla złego zadania.

Workflow `orchestrated` (ADR 0050) działa tak samo: jest komendą `cwm-<nazwa>` (zasób obowiązkowy:
`/cwm-<firma>:cwm-<nazwa>`), a podsumowanie, `--dry-run` i `--explain` dokładają listę etapów (kroki jednego
etapu mogą iść równolegle) z agentami i zależnościami. `--json` dodaje `workflow.type` i `workflow.stages[]`
(`index`, `steps[]`: `id`, `agent`, `dependsOn`, `task`). Nazwa agenta jest taka, jaką widzi silnik: z
frontmattera agenta albo z nazwy pliku, a dla zasobu obowiązkowego z przedrostkiem pluginu (`cwm-<firma>:<nazwa>`).
Treść komendy to treść `source` i sekcja kroków (po angielsku), na końcu wiersz `Task: $ARGUMENTS`, gdy sam
`source` nie ma placeholdera. Kolejność, równoległość i przekazanie wyników między krokami wykonuje model w sesji
silnika na podstawie tej instrukcji, CWM nie uruchamia procesów na krok.

Workflow `instructional` jest w profilu komendą `cwm-<nazwa>` (zasób obowiązkowy: `/cwm-<firma>:cwm-<nazwa>`
w pluginie CWM) i podlega zatwierdzeniu jak komenda (`allowed-tools`, wstawki `!`); tekst z
`$ARGUMENTS` albo `$<cyfra>` razem ze znacznikiem wstawki `!` jest odrzucany. Natywny `.claude/commands/cwm-<nazwa>.md` projektu zasłaniający wybrane polecenie to odmowa. Zatwierdzenia obejmują wszystkie aktywne workflow, nie tylko wybrany.

### `cwm workflow`

```text
cwm workflow add <id> (--from <plik.md> | --from-command <id komendy>) [--keywords a,b]
                 [--example "..."]... [--priority 0-1000] [--manual]
                 [--type instructional|orchestrated] [--step <id>=<agent>]...
                 [--after <id>=<dep1>,<dep2>]... [--step-task <id>=<tekst>]...
                 [--enable <firma>...] [--global optional|mandatory]
cwm workflow list
cwm workflow show <id>
```

`add` tworzy workflow `instructional` (domyślnie) albo `orchestrated` (wersja `1.0.0`): `global/<nazwa>` w rejestrze, `<firma>/<nazwa>`
w `companies/<firma>/workflows/`. `--from-command` kopiuje treść komendy z rejestru. `--enable` dopisuje id
do `resources.enable.workflows` (firma-właściciel tylko u siebie; odmowa przy `disableOptional`),
`--global` do `config.yaml`. Zapis przez writer `~/.cwm`, z zachowaniem komentarzy, walidacją i blokadą
`runtime/global` (jak `cwm plugin`). Treść przechodzi te same kontrole co plan startu; `add` podaje, czy będzie wymagała
zatwierdzenia. Powtórzenie z tą samą treścią to brak zmian, z inną to odmowa. Zatwierdzenie nastąpi przy
`cwm start`. `list` wypisuje workflow, ich routing i gdzie są włączone; `show` pokazuje routing,
polecenie, w które workflow się zamienia, etapy z krokami (dla `orchestrated`) i cechy do zatwierdzenia. `--json`
działa dla wszystkich.

Workflow `orchestrated` (ADR 0050): `--type orchestrated` wymaga co najmniej jednego `--step <id>=<agent>`
(powtarzalne; `<agent>` to id agenta z rejestru, kolejność opcji to kolejność deklaracji). `--after <id>=<a>,<b>`
dopisuje zależności kroku (krok musi być wcześniej zadeklarowany), `--step-task <id>=<tekst>` polecenie kroku
(jedna linia do 1000 znaków). Cykl, nieznany krok, brakujący agent, wielowierszowy `task` i `$ARGUMENTS` w `task`
razem ze wstawką `!` w treści to odmowa; `--step`, `--after` i `--step-task` z typem `instructional` to błąd
użycia (kod `2`). Przykład:

```text
cwm workflow add acme-a/release --type orchestrated --from release.md --keywords release --enable acme-a \
  --step lint=global/linter --step notes=global/writer --step ship=global/shipper \
  --after ship=lint,notes --step-task "notes=Draft the release notes."
```

Kroki `lint` i `notes` tworzą etap 1 (mogą iść równolegle), `ship` etap 2. Zmiana kroku, agenta albo `task` zmienia
wygenerowaną treść, więc workflow wymagający zatwierdzenia (`allowed-tools` w `release.md` albo wstawka `!`, także w
`task`) pyta o zgodę ponownie.

## Czego jeszcze nie ma

Argumenty silnika w `cwm run`, zmiana `nativeDir` istniejących zasobów (przeniesione źródło), `--follow-links` w imporcie, kopiowanie skryptów
hooków do rejestru (skrypt poza rejestrem jest przypięty skrótem, ale nie skopiowany), pluginy
marketplace'y zdalne (git, http) i źródła obiektowe wpisów, pobieranie z uwierzytelnieniem (SSH, tokeny) dla pluginów `git`, tryb `scrub` środowiska, HMAC zatwierdzeń, dziennik
zatwierdzeń, Windows w `cwm start` oraz import biblioteki aplikacji i pluginów. Zapis do
konfiguracji silnika (`.claude/`, `CLAUDE.md`, `.mcp.json`) jest poza zakresem.
