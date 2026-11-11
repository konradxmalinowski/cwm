# ADR 0037: Model zasobów i resolver warstwy CWM

Status: zaakceptowane (decyzje właściciela produktu, 2026-11-11)
Data: 2026-11-11
Dotyka: ADR 0020 (brak automatycznej synchronizacji MCP), ADR 0032 (tylko konfiguracje globalne w MVP), ADR 0035 (zmiana nazwy na CWM)
Źródło: `plans/2026-11-11-cwm-core.md`, `plans/2026-11-11-cwm-spec-kontrakty.md`; spike S1 w ADR 0036

## Kontekst

Po zmianie nazwy (ADR 0035) CWM ma składać konfigurację Claude Code z warstw: zasoby wspólne
(`global`), firma, projekt. Specyfikacja właściciela ("CWM v1.0") opisuje manifesty YAML, kontrakty
pięciu rodzajów zasobów (skill, agent, workflow, plugin, MCP) i reguły dziedziczenia. Zanim
powstanie CLI albo adapter runtime, trzeba zdecydować, gdzie ta logika mieszka, w jakim formacie
trzymamy dane i co robi resolver, gdy manifesty są sprzeczne albo wrogie. Manifesty i zasoby to
pliki, które użytkownik pobiera z zewnątrz (pluginy, serwery MCP), więc są danymi niezaufanymi
(granica 1 w `docs/ARCHITECTURE.md`, sekcja 8.1).

Ten krok dostarcza sam model, walidatory i resolver. Nic jeszcze nie czyta `~/.cwm` i nic nie
zapisuje do konfiguracji silnika.

## Rozważane opcje

**Osobne repozytorium i osobny proces dla CWM.** Czysta granica, ale drugi pakiet do wydawania i
podpisywania (ADR 0003) oraz kopia modelu kanonicznego, zasad zapisu i logiki lokalizacji, które
ta aplikacja już ma.

**Walidacja przez bibliotekę schematów (Zod).** Mniej kodu na start. Odrzucone: reszta
`src/core` ma walidatory pisane ręcznie, a ta ścieżka ma dawać błędy ze ścieżką pola, limity na
rozmiar listy i tekstu oraz jeden wspólny wynik `Result`. Dodawanie drugiego stylu walidacji
tylko dla CWM podwaja miejsca do przeglądu.

**Konfiguracja w JSON zamiast YAML.** Prostszy parser (bez zależności), ale specyfikacja
właściciela jest w YAML, a manifesty edytuje człowiek.

## Decyzja

1. **CWM jest warstwą w tej aplikacji**, nie osobnym repozytorium. Dane CWM leżą w `~/.cwm`.
2. **Manifesty są w YAML**, parsowane biblioteką `yaml` w wersji `2.9.1`, przypiętej dokładnie w
   `dependencies`. Parsowanie jest w `src/infra/cwm/yaml-manifest.ts`, bo dotyka zależności z
   zewnątrz; `core` dostaje już `unknown`. Ustawienia parsera:
   - schemat `core` z YAML 1.2, bez dat, binariów i znaczników niestandardowych,
   - `merge: false`, `uniqueKeys: true`, `strict: true`,
   - aliasy i jawne znaczniki (`!!str`, `!cos`) są błędem, a `toJS` dostaje `maxAliasCount: 0`,
   - ostrzeżenia parsera liczą się jako błędy (biblioteka zgłasza nierozpoznany znacznik jako
     ostrzeżenie i zostawia tekst),
   - limit rozmiaru: 256 Ki jednostek UTF-16 (`MAX_MANIFEST_UTF16_UNITS`). Limit działa na
     tekście, więc kod czytający plik musi ograniczyć odczyt w bajtach przed dekodowaniem.
3. **Walidatory są pisane ręcznie w `core`, fail closed** (`src/core/cwm/validate-manifest.ts`,
   `validate-resource.ts`, `check.ts`). Wejście `unknown` daje albo typowaną wartość, albo listę
   błędów ze ścieżką pola (korzeń to `$`). Sprawdzane są `apiVersion: cwm.dev/v1` i `kind`;
   nieznane pole jest błędem; wymagane pola mają jawne komunikaty. Limity: lista do 500
   elementów, tekst do 512 znaków bez znaków sterujących, powtórzony element listy jest błędem,
   jeden błąd na ścieżkę. Zbieranie błędów kończy się wcześnie, po `MAX_ERRORS + 1` wpisach
   (walidacja wrogiego dokumentu nie trwa dłużej niż trzeba), a wynik ma do 100 błędów z
   końcowym wpisem "+N więcej". Tekst z jakimkolwiek znakiem sterującym lub niewidocznym
   znakiem formatującym Unicode (kategorie `Cc` i `Cf`) jest odrzucany.
4. **Kształty manifestów jak w specyfikacji:**
   - `GlobalConfig` (`defaults`, `resources.mandatory|optional`, `runtime`),
   - `Company` (`metadata`, `resources.enable|disableOptional`, `plugins.enable`, `mcp.enable`,
     `instructions.file`),
   - `Project` (`metadata.company`, `spec.engine`, `spec.resources`, `spec.plugins`, `spec.mcp`,
     `spec.workflows.selection`, `spec.native.preserve`),
   - zasoby `Skill`, `Agent`, `Workflow`, `Plugin`, `MCP` z `metadata.id` w postaci
     `<przestrzeń>/<nazwa>` (małe litery ASCII) i `metadata.version` w postaci semver; dla MCP
     wersja jest opcjonalna.

   Rozszerzenia właściciela, spoza specyfikacji: `Company.exports` i `Project.spec.imports`
   (zasoby innych firm) oraz `Company.plugins.forbid`.
5. **Reguły rozwiązywania** (`src/core/cwm/resolve.ts`, `policy.ts`), w kolejności działania:
   - **Warstwy.** Najpierw importy, potem `global.mandatory`, `global.optional`, zasoby firmy
     (`resources.enable`, `plugins.enable`, `mcp.enable`), `company.disableOptional`, zasoby
     projektu i importy projektu, na końcu wyłączenia projektu (`disableOptional`,
     `plugins.disable`, `mcp.disable`).
   - **Mandatory i optional.** Zasób mandatory jest zawsze w wyniku. Próba wyłączenia go przez
     firmę albo projekt jest błędem. Wszystko inne ma pochodzenie `optional` i jest domyślnie
     aktywne. Zasoby włączone przez firmę są optional, więc projekt może je wyłączyć
     (decyzja właściciela).
   - **Co można wyłączyć.** `disableOptional` w manifeście firmy i projektu przyjmuje `skills`,
     `agents` i `workflows`; pluginy i MCP wyłącza się w projekcie przez `plugins.disable` i
     `mcp.disable`.
   - **`disableOptional` wygrywa nad `enable` w tej samej warstwie** (wyłączenia są stosowane po
     włączeniach). Zasób wyłączony przez firmę nie może zostać włączony przez projekt (błąd).
   - **Zależności** są rozwiązywane przechodnio. Zasób wyłączony przez firmę albo projekt
     (`disableOptional`, `plugins.disable`, `mcp.disable`), od którego zależy inny rozwiązany
     zasób, jest błędem z nazwami obu zasobów (Fail Closed). Nie jest po cichu zachowywany jako
     zależność (decyzja właściciela). Przy kilku powodach obecności liczy się najsilniejsze:
     `mandatory`, potem `optional`, potem `dependency`.
   - **Granica między firmami.** Zasób, którego przestrzeń nie jest przestrzenią firmy projektu
     ani przestrzenią wspólną (`global`, `marketplace`, `local`, `git`; `SHARED_NAMESPACES`),
     jest obcy i wchodzi do konfiguracji tylko przez `spec.imports`. Id firmy nie może zajmować
     przestrzeni wspólnej.
   - **Import** wymaga, żeby firma źródłowa (podana przez wywołującego w `importSources`)
     wyeksportowała zasób w `exports`. Import z własnej firmy, z firmy spoza listy, zasobu
     niewyeksportowanego albo zasobu cudzej firmy wskazanego pod złym `from` jest błędem.
     Mandatory istnieje tylko w `GlobalConfig`, więc z firmy źródłowej nie przechodzi importem
     żadne wymuszenie. Zależność obca zasobu musi być wyeksportowana przez firmę, z której projekt
     importuje.
   - **Widoczność `private`** (skill): nie można jej eksportować ani importować.
   - **`plugins.forbid`.** Plugin z listy zakazów firmy jest odrzucany w dowolnej warstwie i jako
     zależność, także gdy pochodzi z `global.mandatory` albo z importu. Dotyczy tylko pluginów
     (zgodnie z regułą z sekcji 4 specyfikacji).
   - **Zgodność z silnikiem.** Skill z niepustą listą `compatibility.engines` bez silnika
     profilu (`spec.engine` projektu) jest błędem.
   - **Konflikty przez kandydatów rejestru.** Port `ResourceRegistry.candidates(ref)` zwraca
     wszystkie definicje pod danym id. Więcej niż jedna to błąd konfliktu, bez automatycznego
     nadpisania. To samo id użyte przez dwa różne rodzaje zasobów jest błędem w `validatePolicy`.
   - **Brak zasobu.** Zasób wybrany wprost, którego nie ma w rejestrze, jest błędem; brakująca
     zależność przechodnia jest zgłaszana przez `validatePolicy`.
   - **Limity.** Najwyżej `MAX_RESOURCES = 5000` zasobów w wyniku i głębokość łańcucha
     `MAX_DEPTH = 64`. Cykl zależności jest błędem z listą id (do 10). Przejście grafu używa
     jawnego stosu, nie rekurencji.
   - **Projekt zagnieżdżony.** Opcja `parentCompany`: firma inna niż firma projektu nadrzędnego
     jest błędem. Projekt musi też należeć do firmy, z którą go złożono.
   - **Wynik deterministyczny.** Korzenie, zależności i końcowe listy są sortowane po punktach
     kodowych (nie `localeCompare`), błędy są sortowane i bez powtórzeń. Ten sam stan wejściowy
     daje ten sam wynik, co jest warunkiem późniejszego lockfile.
   - **Resolver nie rzuca.** Nieoczekiwany wyjątek kończy się błędem w wyniku.
6. **Sekrety tylko przez `envRef`, z listą zakazanych kluczy.** Zmienna środowiskowa MCP jest
   obiektem `{ envRef: NAZWA }`. Wartość wpisana wprost jest odrzucana przez walidator i nie jest
   zapisywana ani cytowana w komunikacie. Klucz (nazwa zmiennej w procesie MCP) musi mieć zapis
   `WIELKIMI_LITERAMI` i nie może być na liście zakazanych, bo zmienia ładowanie lub uruchamianie
   procesu albo kieruje ruch: `LD_*`, `DYLD_*`, `PYTHON*`, `NPM_CONFIG_*`, `*_PROXY` oraz
   `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `PATH`, `BASH_ENV`, `ENV`,
   `SSL_CERT_FILE`, `SSL_CERT_DIR`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `GIT_SSH_COMMAND`,
   `GIT_EXEC_PATH`, `RUBYOPT`, `PERL5OPT`, `PERL5LIB`, `IFS`, `SHELL`, `HOME` (bez rozróżniania
   wielkości liter). Nazwa w `envRef` jest ograniczona tylko wzorcem `WIELKIMI_LITERAMI`; lista
   zakazanych jej nie dotyczy, bo `envRef` jest odwołaniem do istniejącej zmiennej, a nie
   ustawieniem zmiennej procesu. `validatePolicy` zgłasza dodatkowo argument wyglądający na
   sekret (`--token=`, `--password=`, `--passwd=`, `--secret=`, `--api-key=`, `--auth=`,
   `--bearer=` z wartością) oraz adres z danymi logowania w postaci `user:hasło@host`.

### Wybory, których specyfikacja nie rozstrzyga

Poniższe wynikają z kodu, nie ze specyfikacji. Właściciel ma je potwierdzić albo zmienić.
Rozstrzygnięte przez właściciela (2026-11-11) i przeniesione do decyzji wyżej: zasoby firmy są
optional, `disableOptional` obejmuje workflowy, wyłączona zależność jest błędem, `plugins.forbid`.

- Id firmy i projektu: małe litery, cyfry i `-`, do 63 znaków; id zasobu to
  `<przestrzeń>/<nazwa>`, nazwa dopuszcza `.`, `_` i `-` w środku.
- Mandatory istnieje tylko w `GlobalConfig`.
- Wyłączenie zasobu, który nie jest włączony, jest cichym brakiem operacji.
- Powtórzony zasób w wielu warstwach liczy się raz (pierwsza ścieżka zostaje w komunikatach).
- Zasoby obce wymagają importu w każdej warstwie, także w `GlobalConfig` i manifeście firmy.
- Zależność w przestrzeni wspólnej (`global`, `marketplace`, `local`, `git`) nie wymaga
  eksportu, nawet gdy zależy od niej zasób importowany.
- Agent: `skills.shared` to zależności z rejestru; `skills.private` to ścieżki poza rejestrem i
  nie są zależnościami. Zależnościami workflow są `agents` oraz agenci kroków `steps`.
- Zgodność z silnikiem jest sprawdzana tylko dla skilli. Silnik profilu pochodzi z
  `Project.spec.engine`; `GlobalConfig.defaults.engine` jest walidowany, ale resolver go nie
  używa.
- Pola `GlobalConfig.defaults.projectMode`, `workflowSelection`, `runtime.*`,
  `Company.instructions.file`, `Project.spec.workflows.selection`, `spec.native.preserve` i
  `Plugin.activation.default` są walidowane i zapisane w modelu, ale resolver ich jeszcze nie
  stosuje.
- `Skill.visibility` ma domyślnie `shared`; `Plugin.activation.default` ma domyślnie
  `disabled`; `GlobalConfig` wymaga `defaults` i `runtime`.
- Polecenie MCP to jeden plik wykonywalny: bez spacji i znaków powłoki, a gdy zawiera `/`, to
  ścieżka względna. Adres MCP to `https`, albo `http` tylko dla pętli zwrotnej, bez nazwy
  użytkownika i hasła i bez parametrów zapytania o nazwie sugerującej sekret (`token`, `key`,
  `secret`, `password`, `auth`). Transport `stdio` wymaga `command` i zabrania `url`; `http` i
  `sse` odwrotnie.
- Źródło pluginu typu `git` wymaga adresu spełniającego te same reguły; `ref` nie może
  zaczynać się od `-` ani zawierać `..`. Ścieżki źródeł są względne, w NFC, bez `..`, `%`, `\`
  i nazw urządzeń Windows.
- Eksport zasobu `private` jest błędem rozwiązywania (widać go dopiero, gdy rejestr zna zasób),
  nie błędem walidacji manifestu firmy.

## Konsekwencje

**Czego jeszcze nie ma.**

- Odczytu plików z `~/.cwm`. `parseManifestYaml` i `parseAndValidate` przyjmują tekst; nic nie
  wywołuje `fs`, więc limit bajtów przed dekodowaniem jest zadaniem przyszłego czytnika.
- Implementacji `ResourceRegistry` na bibliotece.
- CLI `cwm`, adaptera runtime (profil z `CLAUDE_CONFIG_DIR`, ADR 0036) ani obsługi pluginów i
  serwerów MCP w silniku.
- Lockfile. Wynik jest deterministyczny właśnie po to, by lockfile był powtarzalny, ale samego
  lockfile nie ma.
- Testów. Zgodnie z decyzją właściciela z 2026-11-11 ten krok nie dodaje testów i nie uruchamia
  ich lokalnie. Zgodność kodu z regułami powyżej została sprawdzona czytaniem, nie wykonaniem.
  Nowy kod nie jest podłączony do aplikacji, więc nie zmienia jej zachowania.

**Wymaganie bezpieczeństwa dla przyszłej warstwy zapisu.** Resolver mówi, co powinno być w
konfiguracji, ale nic nie zapisuje. Gdy powstanie warstwa zapisująca do konfiguracji silnika
(pluginy, serwery MCP, ustawienia), przed jakimkolwiek zapisem musi pokazać użytkownikowi ekran
zatwierdzania z polami `EXECUTION_RELEVANT_FIELDS` (`src/core/cwm/resource.ts`): dla MCP
`command`, `args`, `url` i nazwy `envRef`, dla pluginu `source`. To są pola, które decydują, jaki
kod zostanie uruchomiony i z kim połączy się narzędzie; manifest firmy albo importowany zasób
może je zmienić bez zmiany `id` i wersji. Zapis przez `WriteGate` (ADR 0012) pozostaje
jedyną drogą. Przy projektowaniu tej warstwy zalecany jest głęboki przegląd bezpieczeństwa
(model zagrożeń dla niezaufanych manifestów, łańcuch dostaw pluginów, kolejność zatwierdzenia i
zapisu), a ADR 0020 trzeba wtedy rozstrzygnąć w osobnym ADR, bo dziś zakazuje automatycznej
synchronizacji MCP.

**Ryzyko szczątkowe walidacji MCP.** Walidator i `validatePolicy` ograniczają kształt manifestu,
ale nie rozstrzygają, czy zasób jest bezpieczny. Przechodzi walidację: serwer `stdio` z
poleceniem `sh` albo `node` i dowolnymi argumentami (polecenie to jeden token, ale to, co ten
program zrobi z argumentami, nie jest sprawdzane), oraz `envRef` wskazujący dowolny sekret
użytkownika, bo nazwa w `envRef` nie ma listy zakazanych. Dlatego ekran zatwierdzania
z `EXECUTION_RELEVANT_FIELDS` jest twardym warunkiem wstępnym: żadna warstwa zapisu nie może
trafić do wydania bez niego.

**Koszt nowej zależności.** `yaml` jest drugim parserem w produkcji obok `smol-toml` i podlega
tym samym zasadom łańcucha dostaw (przypięta wersja, `npm audit`, ryzyko S8 w
`docs/ROADMAP.md`). Parser działa na tekście z dysku użytkownika, więc ustawienia z punktu 2
są częścią kontraktu: ich osłabienie wymaga nowego ADR.

**Koszt ręcznych walidatorów.** Każde nowe pole manifestu wymaga zmiany typu, walidatora i
resolvera. Płacimy za to jednolitymi komunikatami, limitami i brakiem zależności.
