# CLI `cwm`

last_updated: 2026-11-12

`cwm` zakłada i sprawdza dane CWM w `~/.cwm`: firmy, projekty i zasoby (skille, agenci, komendy,
workflowy, ustawienia, pluginy, serwery MCP). Składa też z nich konfigurację projektu, a
`cwm import claude` kopiuje do rejestru skille, agentów, komendy i ustawienia z natywnego katalogu
Claude Code. To fundament: polecenie nie uruchamia silnika, nie synchronizuje i niczego nie
zapisuje w `.claude/`, `CLAUDE.md` ani `.mcp.json`; natywny katalog czyta tylko do odczytu.
Decyzje i ograniczenia: [ADR 0038](adr/0038-fundament-cli-cwm.md) (fundament) i
[ADR 0039](adr/0039-rodzaje-settings-i-command-oraz-import-z-natywnej-konfiguracji.md) (rodzaje
`Settings` i `Command`, import). Model manifestów:
[ADR 0037](adr/0037-model-zasobow-i-resolver-warstwy-cwm.md).

Stan: gałąź `feat/cwm-start` (Etap A, zbudowana na `feat/cwm-cli`), niescalona do `main`.

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
    commands/<przestrzeń>/<nazwa>/command.yaml
    settings/<przestrzeń>/<nazwa>/settings.yaml
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
      workflows/<nazwa>/workflow.yaml
      projects/<id>.yaml          manifesty projektów z `--store home`
  sources/  cache/  locks/  runtime/   zarezerwowane, na razie puste
```

Katalog zasobu zawiera plik definicji i pliki, na które wskazuje `spec.source` (np. `SKILL.md`;
import tworzy `SKILL.md`, `AGENT.md` i `COMMAND.md`). `Settings` nie ma pliku źródłowego: cała
treść jest w `settings.yaml`.
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
    commands: []
    settings: []
  optional:
    skills: []
    agents: []
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
| `1` | błąd walidacji, polityki albo stanu na dysku (brak `cwm init`, firma już istnieje, błąd w manifeście, przerwane pytanie, nieoczekiwany błąd); dla `import claude` także zmiany do zapisania bez terminala (zob. niżej) |
| `2` | błędne użycie: nieznane polecenie lub opcja, brak wymaganego argumentu, niepoprawne id, zła wartość `--store`, `CWM_HOME` niebezwzględny; dla `import claude` brak `--company` i `--global` bez terminala albo oba naraz |

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
`settings/` i `projects/`.

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
| `--kind <rodzaj>` | `skill`, `agent`, `workflow`, `plugin`, `mcp`, `settings` albo `command` |
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
cwm import claude (--company <id> | --global) [--from <katalog>] [--dry-run]
```

Czyta natywny katalog Claude Code tylko do odczytu, pokazuje plan i raport, a po potwierdzeniu na
terminalu zapisuje kopie do rejestru CWM. Niczego nie uruchamia, nie zmienia źródła i nie włącza
zasobów w żadnej konfiguracji. Model zagrożeń i decyzje: [ADR 0039](adr/0039-rodzaje-settings-i-command-oraz-import-z-natywnej-konfiguracji.md).

| Opcja | Znaczenie |
|---|---|
| `--company <id>` | zapis w `companies/<id>/`, id zasobów `<id>/<nazwa>`; firma musi istnieć (`cwm company add`) |
| `--global` | zapis w `registry/`, id `global/<nazwa>`; zasób jest widoczny dla wszystkich firm. Nie łączy się z `--company` |
| `--from <katalog>` | katalog źródłowy; domyślnie `~/.claude` (zmienna `CLAUDE_CONFIG_DIR` nie jest brana pod uwagę). Nie może leżeć w katalogu danych CWM ani nim być |
| `--dry-run` | pokazuje plan i raport, niczego nie zapisuje; kod `0` |

Na terminalu bez `--company` i `--global` `cwm` pyta o przestrzeń (firma albo `global`). Bez
terminala (także z `--json` i `--no-input`) trzeba podać jedną z tych opcji, nawet przy `--dry-run`.

**Co jest czytane.** Wyłącznie poniższa lista; żaden inny plik z `--from` nie jest otwierany
(`.credentials.json`, `.claude.json`, `projects/`, `history.jsonl`, `plugins/`, `settings.local.json`
i reszta).

| Źródło | Rodzaj | Co powstaje |
|---|---|---|
| `skills/<nazwa>/` | `Skill` | `SKILL.md` i pliki pomocnicze skilla |
| `agents/<nazwa>.md` | `Agent` | `AGENT.md`; `tools` i `model` z frontmattera trafiają do manifestu |
| `commands/<nazwa>.md` | `Command` | `COMMAND.md` |
| `settings.json` | `Settings` | jeden zasób `<przestrzeń>/claude-settings` z `hooks`, `permissions` i `env` |

Zasoby dostają wersję `0.1.0`. Frontmatter jest odtwarzany z dozwolonych kluczy (nie kopiowany
bajt w bajt), a treść pliku zostaje bez zmian. Nazwy są normalizowane do wzorca id (małe litery,
znaki spoza `a-z0-9._-` zamienione na `-`).

**Co jest pomijane** (każde pominięcie ma wpis w raporcie, bez wartości z pliku):

- dowiązania symboliczne wszędzie (w tym `skills/<nazwa>` wskazujące na inne repozytorium); opcji
  `--follow-links` nie ma,
- `skills/synced` (skille z konta claude.ai), `.git` i `node_modules`, a także wpisy zaczynające
  się od `.` bezpośrednio w `skills/`, `agents/` i `commands/` oraz zagnieżdżone katalogi w
  `agents/` i `commands/`,
- pliki, które wyglądają na zawierające sekret: nazwy w rodzaju `.env`, `*.pem`, `secrets.yaml`,
  `kubeconfig`, `token.txt`, `service-account*.json`, a w treści m.in. znane prefiksy kluczy,
  długie ciągi o wysokiej entropii i linie `hasło/token/klucz = wartość` (wartość co najmniej 4
  znaki). Trafienie w `SKILL.md` pomija cały skill, w pliku pomocniczym tylko ten plik,
- agenci, skille i komendy z kluczem frontmattera `hooks`, `mcpServers` albo `permissionMode`
  (cały zasób jest odrzucany),
- z `settings.json` wszystko poza `hooks`, `permissions` i `env`; klucze uruchamiające polecenia
  (`statusLine`, `apiKeyHelper`, `enabledPlugins` i pokrewne), hooki inne niż `command`,
  zmienne `env` sterujące silnikiem lub procesem (`PATH`, `NODE_OPTIONS`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CONFIG_DIR` i pokrewne); sekret w poleceniu hooka lub regule uprawnień pomija cały zasób
  `Settings`,
- kolizje nazw po normalizacji (`Acme-Notes` i `acme-notes`): żadna ze stron nie jest importowana,
- limity: plik do 1 MiB; skill do 500 plików, 10 MiB i 16 poziomów; cały import do 20 000 plików,
  5000 katalogów i 256 MiB (przekroczenie przerywa import kodem `1`).

**Sekrety w `env`.** Wartość trafia do manifestu jako `value` tylko wtedy, gdy ani nazwa, ani
wartość nie wyglądają na sekret. W przeciwnym razie powstaje `envRef` o tej samej nazwie, a raport
wymienia zmienne do uzupełnienia w środowisku. Wartości zmiennych nie pojawiają się w planie, w
raporcie, w `--json` ani w komunikatach błędów.

**Skrypty hooków.** Ścieżki z poleceń hooków (bezwzględne, `~/`, `$HOME/`, `${HOME}/`) są
wykrywane, a istniejące pliki poniżej 1 MiB dostają w raporcie skrót `sha256`. Reszta jest
oznaczona jako "nieprzypięte: zatwierdzasz ścieżkę, nie treść". Skrótów nie zapisuje się w
manifeście, a skryptów nie kopiuje się do rejestru.

#### Przykład

Natywny katalog (`acme-linked` to dowiązanie do innego repozytorium, `acme-reviewer` ma
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

Raport (10):
  settings.json: hook ~/.claude/hooks/acme-fmt.js: nieprzypiete: zatwierdzasz sciezke, nie tresc (brak pliku)
  settings.json: env: wyglada na sekret, zapisano envRef zamiast wartosci (uzupelnij zmienne srodowiska): ACME_API_TOKEN
  skills/Acme-Notes: nazwa znormalizowana do "acme-notes"
  skills/acme-linked: dowiazanie symboliczne pominiete (brak --follow-links)
  skills/acme-lint/.env: mozliwy sekret: Nazwa pliku ".env" wskazuje na dane uwierzytelniajace.
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
4. `Raport (N)`: najpierw uwagi do importowanych zasobów (normalizacja nazwy, nieznane klucze
   frontmattera, `envRef`, skrypty hooków), potem wszystko, co pominięto. Tekst pokazuje 40
   wpisów, resztę da `--json`.

Po potwierdzeniu (`Zapisac N zasobow do rejestru (X nowych, Y zmienionych)?`, domyślnie "nie")
`cwm` wypisuje `Zapisano <rodzaj> <id>` dla każdego zasobu i przypomina, że zasoby są
nieaktywne: id trzeba dopisać do `resources.optional` w `config.yaml` albo do `resources.enable` w
`company.yaml`. Zapis idzie z zatwierdzonego planu, nie z ponownego odczytu źródła. Błąd zapisu
jednego zasobu nie przerywa pozostałych, ale daje kod `1`.

**Ponowny import.** Plan porównuje wynik ze stanem rejestru: `nowy`, `zmieniony` albo `bez zmian`.
Zmieniony zasób zastępuje katalog, a poprzednia wersja zostaje obok jako `.<nazwa>.old-*` (jedna
kopia, pomijana przy odczycie rejestru). Zasoby `bez zmian` nie są zapisywane.

**Bez terminala** (`--json`, `--no-input` albo wyjście nieinteraktywne) import niczego nie zapisuje.
Gdy plan ma coś do zapisania, `cwm` wypisuje go i kończy się kodem `1`; nie ma opcji `--yes`.
Plan do obejrzenia daje `--dry-run` (kod `0`).

**`--json`.** Obiekt `{ ok, dryRun, written, from, target, namespace, items[], skipped[] }`, gdzie
`items[]` mają `kind`, `id`, `status`, `changes`, `flags`, `notes`, `source`, `sha256`, a
`skipped[]` pary `{ item, reason }`. Przy zmianach do zapisania bez terminala `ok` to `false`, a
obiekt ma dodatkowo pole `error`.

Kody: `0` (plan wypisany, zapis wykonany albo brak zmian); `1`, gdy firma nie istnieje, `--from`
nie istnieje albo leży w katalogu danych CWM, import przekracza limit, są zmiany do zapisania bez
terminala, użytkownik odmówił albo zapis któregoś zasobu się nie udał; `2` przy braku
`--company` i `--global` bez terminala, przy obu naraz albo niepoprawnym id firmy.

Po imporcie `cwm doctor` i `cwm resource list` widzą nowe zasoby. Z zasobem włączonym w firmie
`cwm resolve` wypisuje jego id w `resolved.skills`, `resolved.commands` albo `resolved.settings`.

## Czego jeszcze nie ma

Polecenia `start`, `sync`, `diff` i `run`, lockfile, generowanie profili silnika, zatwierdzanie
zasobów z polami wykonawczymi (hooki, MCP, pluginy; Etap B, osobny PR), `--follow-links` w
imporcie, kopiowanie skryptów hooków do rejestru oraz import biblioteki aplikacji i pluginów.
Zapis do konfiguracji silnika jest poza zakresem.
