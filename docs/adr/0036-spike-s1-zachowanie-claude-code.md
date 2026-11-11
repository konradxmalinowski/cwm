# ADR 0036: Spike S1, jak Claude Code ładuje konfigurację (podstawa adaptera runtime CWM)

Status: zaakceptowane jako wynik spike'a, 2026-11-11
Data: 2026-11-11
Dotyka: ADR 0022 (wykrywanie lokalizacji), ADR 0032 (tylko konfiguracje globalne w MVP)
Źródło: `plans/2026-11-11-cwm-core.md`, sekcja C

## Kontekst

CWM ma generować osobny profil Claude Code dla każdej firmy i uruchamiać w nim sesję tak, żeby
natywna konfiguracja projektu (`.claude/`, `.mcp.json`, `CLAUDE.md`) i natywna konfiguracja
użytkownika (`~/.claude/`, `~/.claude.json`) zostały nietknięte. Zanim powstanie adapter
runtime, trzeba ustalić na zainstalowanej wersji, a nie z pamięci, skąd Claude Code czyta
każdy rodzaj konfiguracji i co przenosi zmienna `CLAUDE_CONFIG_DIR`.

Testowana wersja: **Claude Code 2.1.322** (`claude --version`, instalacja natywna, macOS arm64).

Metoda. Dokumentacja z `code.claude.com/docs/en/*` (stan na 2026-11-11) plus sprawdzenia na
żywo wyłącznie poleceniami metadanych: `claude --version`, `claude --help`, `claude mcp list`,
`claude mcp get`, `claude mcp add/remove` (zapis tylko do profilu tymczasowego),
`claude plugin list`, `claude plugin details`, `claude auth status`, `claude doctor`. Każde
polecenie szło z `CLAUDE_CONFIG_DIR` wskazującym na katalog tymczasowy i z katalogiem
projektu testowego obok niego. Bez sesji interaktywnych i bez `claude -p`, więc zachowania
widoczne dopiero w działającej sesji (skille, agenci, `CLAUDE.md`) mają tylko etykietę
dokumentacji. Fixture'y: skill `acme-shared` w profilu i w projekcie, agent `acme-agent`,
plugin w katalogu skilli `acme-plug` (skill, agent, serwer MCP), `.mcp.json` z serwerami
`acme-stdio` i `acme-http`. Serwer stdio testowy dopisywał do pliku swoje argumenty i
zmienne, co pozwoliło sprawdzić rozwijanie `${VAR}` bez sesji.

Etykiety: **[E]** empirycznie (polecenie i obserwacja), **[D]** dokumentacja (adres),
**[?]** nieustalone.

## Ustalenia

### 1. `CLAUDE_CONFIG_DIR`

| Element | Gdzie przy ustawionym `CLAUDE_CONFIG_DIR` | Etykieta |
| --- | --- | --- |
| `settings.json`, `CLAUDE.md`, `skills/`, `agents/`, `commands/`, `rules/`, `output-styles/`, `workflows/` użytkownika | pod tym katalogiem ("every `~/.claude` path on this page lives under that directory instead") | [D] claude-directory |
| `.claude.json` (stan aplikacji, MCP user i local, zaufanie projektów, `disabledMcpServers`) | `<profil>/.claude.json`, nie `~/.claude.json` | [E] + [D] |
| `backups/` kopii `.claude.json` | `<profil>/backups/` | [E] |
| `plugins/` (instalacje, marketplace'y, cache, `data/`) | `<profil>/plugins/`, chyba że ustawiono `CLAUDE_CODE_PLUGIN_CACHE_DIR` | [E] + [D] plugins/loading |
| `projects/` (transkrypty, pamięć automatyczna), `history.jsonl`, `file-history/`, `plans/` | pod profilem ("All settings, session history, and plugins are stored under this path") | [D] env-vars |
| Logowanie | macOS: wpis w pęku kluczy "keyed to that directory", więc inny katalog czyta inny wpis; plik `.credentials.json` też pod profilem | [E] + [D] authentication |
| Katalog tymczasowy, scratchpad | `/private/tmp/claude-<uid>/` wspólny dla profili, zmienia go tylko `CLAUDE_CODE_TMPDIR` | [D] claude-directory |
| Ustawienia zarządzane i zarządzany `CLAUDE.md` | ścieżki systemowe, niezależne od profilu | [D] settings, memory |

Dowody empiryczne:

- [E] `claude mcp list` w świeżym profilu utworzył `<profil>/.claude.json` (pola
  `firstStartTime`, `firstStartVersion: 2.1.322`, `userID`, `machineID`, migracje) i
  `<profil>/backups/`. Serwery MCP zakresu user z prawdziwego `~/.claude.json` nie pojawiły
  się na liście. Prawdziwy `~/.claude.json` i jego kopie nie zawierają ani ścieżki katalogu
  testowego, ani nazw `acme-*` (grep: 0 trafień).
- [E] `claude plugin list --json` pokazał tylko `acme-plug@skills-dir` z profilu. Pluginy
  zainstalowane w prawdziwym `~/.claude/plugins` nie pojawiły się. Wpis
  `enabledPlugins: {"acme-plugin@acme-market": true}` dla pluginu, którego profil nie ma
  zainstalowanego, nie pojawił się na liście i nie dał błędu.
- [E] `claude auth status` w świeżym profilu: `"loggedIn": false`, `"authMethod": "none"`,
  podczas gdy sesja nadrzędna na tej samej maszynie jest zalogowana. Nowy profil wymaga
  ponownego logowania.
- [D] authentication: alternatywą dla logowania w każdym profilu są `CLAUDE_CODE_OAUTH_TOKEN`
  (z `claude setup-token`), `ANTHROPIC_API_KEY` albo `apiKeyHelper`. Wyjątek: logowanie do
  Console bez klucza API jest trzymane poza katalogiem konfiguracji, więc profile go nie
  rozdzielają.
- [D] env-vars: `CLAUDE_CONFIG_DIR` musi być ścieżką bezwzględną; ustawienia projektu i
  lokalne nie mogą go ustawić (ignorowane w `env`). `CLAUDE_CODE_PROJECT_DIR_NAME` (tylko razem z
  `CLAUDE_CONFIG_DIR`, tylko ze środowiska) pozwala nazwać katalog w `projects/`.
- [E] `claude doctor` w świeżym profilu: "Managed settings (remote): not fetched, no usable
  credentials". Ustawienia zarządzane z serwera zależą od logowania profilu.
- [?] Czy przy ustawionym `CLAUDE_CONFIG_DIR` sesja nadal czyta `~/.claude/skills`,
  `~/.claude/agents` i `~/.claude/CLAUDE.md`. Dla MCP, pluginów i logowania potwierdzone
  empirycznie, że nie; dla skilli, agentów i `CLAUDE.md` potrzebna jest działająca sesja.
  Dokumentacja mówi, że nie.

### 2. Skille, agenci, komendy: kolejność i kolizje

- [D] skills: źródła skilli to enterprise (katalog ustawień zarządzanych), personal
  (`~/.claude/skills`), project (`.claude/skills` w katalogu startu i w każdym nadrzędnym aż do
  korzenia repozytorium), nested (`<podkatalog>/.claude/skills`, ładowane przy pierwszym
  dotknięciu pliku w podkatalogu), `--add-dir`, plugin, konto claude.ai.
- [D] skills: przy tej samej nazwie **enterprise > personal > project**. Skill wygrywa z
  plikiem w `.claude/commands/` o tej samej nazwie. Skill pluginu nie koliduje, bo ma nazwę
  `/<plugin>:<skill>`; goła `/<skill>` działa, dopóki nikt inny jej nie zajmuje.
- [D] sub-agents: dla agentów odwrotnie niż dla skilli: **managed > `--agents` > projekt
  `.claude/agents/` > użytkownik `~/.claude/agents/` > plugin**. Agent pluginu ma nazwę
  `<plugin>:<agent>`; pola `hooks`, `mcpServers`, `permissionMode`, `initialPrompt` są w
  agentach pluginu ignorowane.
- [D] skills: skille zsynchronizowane z claude.ai trafiają do `~/.claude/skills/synced/`
  (czyli do profilu) z przestrzenią `anthropic-skills:`. Każdy profil zalogowany tym samym
  kontem dostaje ten sam zestaw, chyba że profil ustawi `syncClaudeAiSkills: false`.
- [E] `claude plugin details acme-plug@skills-dir`: katalog z `.claude-plugin/plugin.json`
  pod `<profil>/skills/` ładuje się jako plugin zakresu user (skill `acme-shared`, agent
  `acme-agent`, serwer MCP), bez instalacji i bez marketplace'u.
- [D] plugins/loading: plugin w katalogu skilli użytkownika wygrywa z pluginem o tej samej
  nazwie w `.claude/skills/` projektu. Kolejność pluginów o tej samej nazwie manifestu:
  managed, `--plugin-dir`, zainstalowany z marketplace'u, katalog skilli, synchronizowany.
- [?] Kolizja skilla `acme-shared` z profilu i z projektu nie została sprawdzona na żywo
  (wymaga sesji).

### 3. Hierarchia ustawień i scalanie

- [D] settings: priorytet od najwyższego: **managed > `--settings` (CLI) > `.claude/settings.local.json`
  > `.claude/settings.json` > użytkownik**. Klucz z wyższego poziomu nadpisuje niższy.
- [D] settings: listy (np. `permissions.allow`) się sumują między plikami. Wyjątki z własnymi
  regułami: `fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`.
- [D] settings: `env` to zwykły klucz w tej samej hierarchii. Zmienne powłoki nie są
  poziomem; o pierwszeństwie decyduje para klucz-zmienna. `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`
  i telemetria są ignorowane w `env` projektu i lokalnym.
- [D] plugins/loading: `enabledPlugins` scalane per identyfikator pluginu: wartość z
  najwyższego źródła, które go wymienia (`--add-dir` < user < project < local < `--settings`
  < managed). Managed `true` wymusza, `false` blokuje. Plugin włączony tylko w projekcie nie
  instaluje się sam.
- [D] settings, permissions: `permissions.allow`, `additionalDirectories`,
  `extraKnownMarketplaces` i większość `env` z `.claude/settings.json` działa dopiero po
  zaufaniu folderowi; `deny` i `ask` działają od razu.
- [D] settings: część kluczy działa tylko z poziomu user albo managed (np.
  `permissions.defaultMode` równe `auto` lub `bypassPermissions`).
- [?] Scalanie `hooks` między poziomami nie zostało sprawdzone (dokumentacja mówi o sumowaniu
  list, bez osobnego opisu hooków).

### 4. MCP

- [D] mcp: zakresy local i user są w `.claude.json` (local pod
  `projects["<ścieżka bezwzględna>"]`), project w `.mcp.json` w korzeniu projektu.
- [D] mcp: przy tej samej nazwie wygrywa jedna definicja w całości, bez scalania pól:
  managed `managedMcpServers` > local > project > user > plugin > konektory claude.ai.
  Pluginy i konektory są dopasowywane po adresie, nie po nazwie.
- [E] `claude mcp add --scope local acme-stdio` zapisał serwer do
  `<profil>/.claude.json` pod ścieżką projektu, a `claude mcp list` uruchomił wersję local
  zamiast definicji z `.mcp.json` o tej samej nazwie. `--scope user` zapisał do
  `mcpServers` na najwyższym poziomie `<profil>/.claude.json`.
- [E] Zatwierdzanie `.mcp.json`: z `enabledMcpjsonServers: ["acme-stdio"]` tylko w
  `.claude/settings.json` projektu serwer został "Pending approval", bo projekt nie był
  zaufany. Po dodaniu `enabledMcpjsonServers` do `settings.json` profilu serwer wystartował.
  Po usunięciu go z profilu i ustawieniu `hasTrustDialogAccepted: true` dla projektu w
  `<profil>/.claude.json` zadziałał wpis z ustawień projektu. Zgodne z [D] mcp. Zaufanie
  jest zapisane w `.claude.json`, więc jest per profil.
- [E] `disabledMcpjsonServers: ["acme-http"]` w ustawieniach projektu ukrył `acme-http` z
  listy, mimo że profil miał go w `enabledMcpjsonServers`. [D] mcp: wpis
  `disabledMcpjsonServers` w dowolnym pliku odrzuca serwer.
- [E] `disabledMcpServers` w `projects[...]` w `<profil>/.claude.json` dało "Disabled for
  this project" dla serwera user (`acme-user`) i pluginu (`plugin:acme-plug:acme-plugsrv`).
  [D] mcp: `disabledMcpServers` dotyczy serwerów user, pluginów, managed, konektorów i
  wbudowanych; to osobny mechanizm niż `enabledMcpjsonServers`/`disabledMcpjsonServers`.
- [E] Rozwijanie zmiennych (serwer zapisywał do pliku `$1|$TOKEN|$ACME_PROFILE`):
  - `${ACME_ARG:-defaultarg}` bez zmiennej: `defaultarg`; ze zmienną: jej wartość;
  - `${ACME_TOKEN}` nieustawione: proces dostał dosłowny tekst `${ACME_TOKEN}`, a
    `claude mcp list` pokazał ostrzeżenie "Missing environment variables";
  - `ACME_TOKEN=` (pusty): pusty ciąg, także przy `:-default` (zgodne z [D]);
  - wartość z `env` w `settings.json` profilu jest używana przy rozwijaniu i trafia do
    środowiska procesu serwera (`ACME_PROFILE=acme-a`);
  - `claude mcp list` i `mcp get` wyświetlają argumenty nierozwinięte.
- [D] mcp: rozwijanie działa w `command`, `args`, `env`, `url`, `headers`. Nazwy
  poświadczeń Anthropic (`ANTHROPIC_API_KEY` itp.) w `url` i `headers` serwera zdalnego są
  zawsze puste.
- [E] Serwer MCP pluginu: nazwa `plugin:<plugin>:<serwer>`, `${CLAUDE_PLUGIN_ROOT}`
  rozwinięte do katalogu pluginu, start bez zatwierdzania. Profil dostał
  `plugins/data/` i `mcp-needs-auth-cache.json`.
- [D] mcp: `headersHelper` to polecenie powłoki zwracające JSON nagłówków, limit 10 s,
  uruchamiane przy każdym połączeniu, nadpisuje statyczne `headers`. Dla `.mcp.json` i
  zakresu local działa dopiero po zaufaniu katalogowi projektu (od 2.1.238), wcześniej
  łączy się tylko ze statycznymi nagłówkami. Katalog roboczy helpera zakresu user to katalog
  konfiguracji.
- [D] mcp: `--strict-mcp-config` używa wyłącznie serwerów z `--mcp-config`.
- [?] Czy `--strict-mcp-config` wyłącza także serwery pluginów i konektory claude.ai.
- [?] `headersHelper` nie był uruchomiony na żywo (serwer z nim był wyłączony).
- [?] Gdzie trzymane są tokeny OAuth serwerów MCP i czy są per profil.

### 5. `CLAUDE.md`

- [D] memory: zarządzany `CLAUDE.md` (macOS `/Library/Application Support/ClaudeCode/`),
  użytkownika (`~/.claude/CLAUDE.md`, czyli profilu), projektu (`./CLAUDE.md` albo
  `./.claude/CLAUDE.md`), lokalny `./CLAUDE.local.md`.
- [D] memory: przy starcie ładowane są `CLAUDE.md` i `CLAUDE.local.md` z katalogu roboczego i
  **każdego katalogu nadrzędnego**, sklejone od korzenia systemu plików w dół (bliższe
  katalogowi startu czytane później). Pliki w podkatalogach ładują się przy pierwszym
  odczycie lub edycji pliku w tym podkatalogu.
- [D] memory: import `@ścieżka`, względna wobec pliku importującego, rekurencja do czterech
  poziomów. Import spoza katalogu roboczego wymaga jednorazowej zgody w oknie dialogowym.
  Zgoda jest stanem projektu w `.claude.json`, więc w nowym profilu pojawi się znowu.
- [D] memory: `claudeMdExcludes` (glob po ścieżkach bezwzględnych, listy sumowane między
  poziomami) wyklucza wybrane pliki, ale nie zarządzany `CLAUDE.md`.
- [D] memory: `AGENTS.md` jest czytany zamiast `CLAUDE.md` tylko wtedy, gdy w katalogu
  roboczym i wyżej nie ma żadnego `CLAUDE.md` ani `CLAUDE.local.md`.
- [D] memory: pamięć automatyczna w `<profil>/projects/<projekt>/memory/`, chyba że
  `autoMemoryDirectory` (dowolny poziom ustawień) wskaże inne miejsce.
- [?] Brak testu na żywo: ładowanie `CLAUDE.md` z katalogów nadrzędnych i importy wymagają
  sesji.

## Decyzja

CWM uruchamia Claude Code z osobnym katalogiem profilu przez `CLAUDE_CONFIG_DIR` (ścieżka
bezwzględna, ustawiana w środowisku uruchamianego procesu, nigdy w pliku ustawień) i nie
zapisuje niczego do `~/.claude/`, `~/.claude.json` ani do katalogu projektu. Spike potwierdza,
że ten model działa dla ustawień użytkownika, pluginów, MCP zakresu user i local, logowania i
stanu aplikacji. Konfiguracja projektu ładuje się zawsze, niezależnie od profilu; CWM może ją
uzupełniać i zawężać przez flagi startowe, ale nie ukrywać.

## Konsekwencje dla CWM

Decyzje dla adaptera runtime:

1. **Układ profilu.** `~/.cwm/profiles/<firma>/claude/` jako `CLAUDE_CONFIG_DIR`. CWM generuje
   w nim `settings.json`, `CLAUDE.md`, `skills/`, `agents/`. `.claude.json` tworzy i
   przepisuje sam Claude Code (z kopiami w `backups/`), więc CWM go nie generuje i nie edytuje;
   jedyny wyjątek to odczyt diagnostyczny.
2. **Zasoby firmy jako plugin.** Skille i agenci firmy trafiają do profilu jako plugin w
   katalogu skilli (`<profil>/skills/<firma>-cwm/.claude-plugin/plugin.json`). Dostają
   przestrzeń `<plugin>:<nazwa>`, więc nie kolidują z natywnymi skillami i agentami projektu,
   a ładują się bez marketplace'u (potwierdzone [E]). Luźne pliki w `skills/` i `agents/`
   profilu tylko gdy resolver nie wykrył kolizji nazw z projektem, bo skille profilu
   przesłaniają projekt, a agenci projektu przesłaniają profil.
3. **Egzekwowanie przez `--settings`.** Ustawienia projektu stoją wyżej niż ustawienia
   użytkownika, więc polityka firmy w `settings.json` profilu jest tylko wartością domyślną.
   Wszystko, co firma wymusza (`enabledPlugins: false` dla zabronionych pluginów,
   `disabledMcpjsonServers`, `permissions.deny`, `claudeMdExcludes`), CWM przekazuje w pliku
   `--settings <profil>/cwm-enforced.json`, który jest nad projektem i local. Listy
   `permissions.allow` z projektu i tak się dosumują; zawężać da się przez `deny`, nie przez
   usunięcie `allow`.
4. **MCP przez `--mcp-config`.** Serwery z `EffectiveConfiguration` CWM zapisuje do
   `<profil>/cwm-mcp.json` i przekazuje `--mcp-config`. Tryb domyślny jest addytywny: natywne
   `.mcp.json` projektu działa dalej z natywnymi zasadami zatwierdzania. Tryb ścisły
   (`--strict-mcp-config`) jest wyborem firmy dla wymagań izolacji MCP ze specyfikacji
   (AC-12) i wyłącza `.mcp.json` projektu w całości; zanim zostanie obiecany, trzeba
   sprawdzić, co robi z MCP pluginów i konektorami.
5. **Sekrety.** `envRef` zamienia się w `${NAZWA}` w `cwm-mcp.json`, a wartość przychodzi
   tylko ze środowiska procesu. Nieustawiona zmienna nie blokuje startu, tylko trafia
   dosłownie do serwera ([E]), więc runtime przed startem sprawdza obecność każdej zmiennej z
   `envRef` i odmawia uruchomienia, gdy jej brak. `env` w ustawieniach profilu też zasila
   rozwijanie; CWM nie wpisuje tam sekretów.
6. **Logowanie.** Każdy nowy profil startuje niezalogowany ([E]). CWM nie dotyka pęku kluczy
   ani `.credentials.json`; pierwszy start profilu przeprowadza użytkownik. Opcjonalnie
   profil może dostać `CLAUDE_CODE_OAUTH_TOKEN` albo `apiKeyHelper` z `envRef`.
7. **Zaufanie projektu.** Zaufanie jest per profil, więc pierwszy start projektu w nowym
   profilu znowu pyta o zaufanie i o zewnętrzne importy `CLAUDE.md`. CWM nie ustawia
   `hasTrustDialogAccepted` za użytkownika: to decyzja bezpieczeństwa, a nie konfiguracja.
8. **Historia i pamięć.** Transkrypty, `history.jsonl` i pamięć automatyczna są per profil.
   Ten sam projekt otwarty w dwóch profilach ma dwie historie i dwie pamięci. CWM to
   dokumentuje i nie próbuje scalać.
9. **Projekt zagnieżdżony.** `CLAUDE.md` z katalogów nadrzędnych ładuje się zawsze, więc
   projekt w katalogu innej firmy dostałby jej instrukcje. Błąd walidacji z resolvera
   (projekt w katalogu projektu innej firmy) zostaje; jako uzupełnienie `claudeMdExcludes`
   w `cwm-enforced.json`.
10. **Wersja.** Adapter zapisuje w lockfile wersję Claude Code (tu 2.1.322). Przy innej wersji
    runtime powtarza zestaw sprawdzeń metadanych z tego spike'a w katalogu tymczasowym i
    ostrzega przy różnicy.

Czego profil nie izoluje:

- natywnej konfiguracji projektu: `.claude/settings*.json`, `.claude/skills|agents|commands`,
  `.mcp.json`, `CLAUDE.md` z katalogu projektu i katalogów nadrzędnych;
- ustawień zarządzanych, zarządzanego `CLAUDE.md`, `managed-mcp.json`;
- zasobów konta claude.ai: synchronizowanych skilli i pluginów oraz konektorów. Profil może
  je wyłączyć (`syncClaudeAiSkills: false`, `syncClaudeAiPlugins: false`,
  `disableClaudeAiConnectors: true`), ale nie przypisać innej firmie;
- globalnego pliku wykluczeń gita, który Claude Code uzupełnia przy pierwszym zapisie
  `settings.local.json`;
- katalogu tymczasowego i scratchpadu (wspólne, chyba że `CLAUDE_CODE_TMPDIR` per profil);
- profili `ant` w `~/.config/anthropic` i logowania Console bez klucza API.

Nieustalone, do sprawdzenia w sesji testowej, zanim adapter runtime trafi do wydania:

- czy przy `CLAUDE_CONFIG_DIR` sesja na pewno nie czyta `~/.claude/skills`, `agents/` i
  `CLAUDE.md` (dokumentacja: nie czyta);
- kolizja skilla profilu ze skillem projektu w działającej sesji;
- wpływ `--strict-mcp-config` na MCP pluginów i konektory;
- scalanie `hooks` między poziomami ustawień;
- `headersHelper` w praktyce i miejsce przechowywania tokenów OAuth serwerów MCP;
- nazwa wpisu w pęku kluczy dla profilu (dokumentacja mówi tylko, że jest powiązany z
  katalogiem);
- czy aplikacja desktopowa i rozszerzenia IDE respektują `CLAUDE_CONFIG_DIR`;
- czy `CLAUDE_CODE_PLUGIN_CACHE_DIR` można bezpiecznie współdzielić między profilami.

Źródła dokumentacji: `https://code.claude.com/docs/en/settings`,
`https://code.claude.com/docs/en/claude-directory`, `https://code.claude.com/docs/en/env-vars`,
`https://code.claude.com/docs/en/authentication`, `https://code.claude.com/docs/en/mcp`,
`https://code.claude.com/docs/en/skills`, `https://code.claude.com/docs/en/sub-agents`,
`https://code.claude.com/docs/en/plugins/loading`, `https://code.claude.com/docs/en/memory`.
