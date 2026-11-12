# ADR 0038: Fundament CLI cwm

Status: zaakceptowane (decyzje właściciela produktu, 2026-11-11 i 2026-11-12)
Data: 2026-11-12
Dotyka: ADR 0012 (WriteGate jako jedyna droga zapisu), ADR 0020 (brak automatycznej synchronizacji MCP), ADR 0036 (zachowanie Claude Code), ADR 0037 (model zasobów i resolver)
Źródło: `plans/2026-11-11-cwm-cli-fundament.md`; kod w `src/cli` i `src/infra/cwm`; opis użytkowy w `docs/CLI.md`

## Kontekst

ADR 0037 dostarczył model, walidatory i resolver, ale nic nie czytało `~/.cwm`. Zanim powstanie
adapter runtime albo komenda `start`, potrzebny jest sposób, żeby założyć dane CWM, zobaczyć
zasoby, złożyć konfigurację projektu i sprawdzić, czy manifesty są poprawne. Manifesty i zasoby
to pliki z zewnątrz, więc czytanie i zapis muszą być ostrożniejsze niż zwykłe operacje na
plikach. Repozytorium jest publiczne, a część projektów użytkownika też, więc manifest projektu
nie zawsze może leżeć w jego repozytorium.

Ten krok jest fundamentem: czyta i waliduje, zapisuje wyłącznie własne dane CWM i nie dotyka
konfiguracji silnika.

## Rozważane opcje

**CLI w procesie głównym Electrona.** Odrzucone: CLI ma działać bez okna i bez Electrona, a
`src/main` jest korzeniem kompozycji aplikacji desktopowej. CLI dostaje własny korzeń
kompozycji, `src/cli`, obok `src/main`.

**Własny parser argumentów i własne pytania.** Zero zależności, ale właściciel zdecydował o
gotowych bibliotekach (`commander` i `@clack/prompts`), żeby nie utrzymywać parsera opcji,
pomocy i komunikatów o błędach użycia.

**Manifest projektu zawsze w repozytorium projektu.** Zgodne ze specyfikacją (3.3), ale
wymusza `.cwm/` w repozytoriach publicznych. Dlatego obok wariantu lokalnego jest wariant w
`~/.cwm` (`--store home`).

**Import biblioteki aplikacji od razu.** Odłożone przez właściciela. Zasoby czytamy na razie
tylko z `~/.cwm/registry`.

## Decyzja

1. **Zasoby pochodzą z `~/.cwm/registry`** (specyfikacja 3.2) i z katalogów firm
   (`~/.cwm/companies/<firma>/{skills,agents,workflows}`). Import z biblioteki aplikacji będzie
   osobnym krokiem. Rejestr (`FileResourceRegistry`) implementuje port `ResourceRegistry` z
   ADR 0037: wszystkie definicje pod jednym id zostają w wyniku, a konflikt zgłasza resolver.
2. **Zależności przypięte dokładnie:** `commander` `15.0.0` (opublikowany 2026-05-29) i
   `@clack/prompts` `1.8.1` (2026-09-13). Obie są starsze niż 14 dni względem daty decyzji.
   Obie są modułami ESM, a build główny jest CommonJS (`tsconfig.main.json`). `commander` jest
   ładowany przez `require` modułu ESM, co działa bez flag od Node 24 (`engines.node >=24.0.0`).
   `@clack/prompts` jest ładowany dynamicznym `import()` dopiero przy pierwszym pytaniu, więc
   ścieżki nieinteraktywne go nie wczytują.
3. **`src/cli` jest drugim korzeniem kompozycji.** Widzi `core` i `infra`. Reguły
   `import/no-restricted-paths` zabraniają importu z `main`, `renderer` i `preload` do `cli` i
   z `cli` do tych katalogów, a także z `core`, `adapters`, `infra`, `main` i `renderer` do
   `cli`. Wpis `bin: { cwm: dist/cli/index.js }` w `package.json` i `src/cli/**` w
   `tsconfig.main.json` dodają polecenie do budowania.
4. **Reguły zapisu.** Jedyny kod zapisujący to `src/infra/cwm/writer.ts`:
   - zapis plików jest atomowy (plik tymczasowy i `rename`, `infra/fs/atomic`),
   - dozwolone są dwa korzenie: `~/.cwm` (albo `CWM_HOME`) i `<projekt>/.cwm`; ścieżka poza
     korzeniem jest odmową,
   - żaden segment ścieżki zapisu, `CWM_HOME` ani katalogu projektu nie może być `.claude`,
     `CLAUDE.md` ani `.mcp.json` (bez rozróżniania wielkości liter, także po rozwiązaniu
     dowiązań),
   - dowiązanie symboliczne na ścieżce zapisu jest odmową; wyjątkiem jest sam `~/.cwm`, który
     może być dowiązaniem (wybór użytkownika), w przeciwieństwie do `<projekt>/.cwm`,
   - katalog projektu nie może leżeć w katalogu danych CWM, nim być ani sprawiać, żeby jego
     `.cwm` było katalogiem danych (`attach ~` przy domyślnym `~/.cwm`),
   - uprawnienia 700 dla katalogów i 600 dla plików na POSIX; `project create` tworzy katalog
     projektu z domyślnymi uprawnieniami, bo to katalog użytkownika,
   - `cwm` nie nadpisuje istniejących plików: `init` pomija to, co istnieje, a `company add` i
     `project create/attach` odmawiają, gdy cel już jest.
5. **Miejsce manifestu projektu: `--store local|home`** (domyślnie `local`).
   - `local`: `<katalog>/.cwm/project.yaml`.
   - `home`: `~/.cwm/companies/<firma>/projects/<id>.yaml` z polem `metadata.path`. To pole jest
     rozszerzeniem modelu `Project` (`src/core/cwm/manifest.ts`), dozwolonym i wymaganym tylko
     dla manifestu w `~/.cwm`. Czytnik przyjmuje je, gdy jest ścieżką bezwzględną do istniejącego
     katalogu spoza katalogu danych CWM; inaczej manifest dostaje problem, a projekt jest
     pomijany. Zapisywana jest ścieżka po `realpath`.
   - Katalog z dwoma manifestami (lokalnym i w `~/.cwm`) jest błędem, nie wyborem pierwszego.
   - Przy `local` w repozytorium git `cwm` sprawdza, czy `.cwm/` jest ignorowane, i ostrzega
     (pkt 8). Przy `home` nic nie trafia do repozytorium projektu.
6. **Kody wyjścia.** `0`: sukces (także `-h` i `-V`). `1`: błąd walidacji, polityki albo stanu
   na dysku, w tym przerwanie pytania i nieoczekiwany błąd. `2`: błędne użycie (nieznane
   polecenie lub opcja, brak wymaganego argumentu w trybie nieinteraktywnym, niepoprawne id,
   `CWM_HOME` niebezwzględny). Błędy parsera `commander` mają kod `2`.
7. **Bezpieczeństwo wyjścia.** Tekst, który pochodzi z dysku (nazwy plików, klucze manifestu,
   komunikaty błędów), przechodzi przed wypisaniem przez `safeText`: znaki sterujące (`Cc`) i
   formatujące (`Cf`, w tym RLO i znaki zerowej szerokości) są zapisywane jako `\xNN` albo
   `\uNNNN`, z wyjątkiem nowej linii i tabulatora. Ścieżki pól w błędach walidatora są
   przycięte do 64 znaków na klucz i też escapowane (`childPath`). Tryb `--json` wypisuje
   `JSON.stringify`, który zapisuje znaki sterujące jako `\uXXXX`. Nieznany błąd systemowy nie
   jest wypisywany: użytkownik dostaje tylko kod errno, bo surowy komunikat zawiera ścieżki.
8. **Limity skanowania i `git check-ignore`.**
   - Odczyt katalogów iteratorem `opendir` staje na 5000 wpisach (`MAX_DIR_ENTRIES`), a rejestr
     na 20 000 plikach zasobów (`MAX_RESOURCES * 4`). Obcięcie jest zgłaszane jako problem.
   - Manifest czyta się z limitem `3 * 262 144` bajtów przed dekodowaniem, jako ścisły UTF-8,
     tylko z plików regularnych; dowiązania do plików i katalogi wychodzące dowiązaniem poza
     `~/.cwm` są odmową.
   - `project list --scan <katalog>` schodzi do 2 poziomów, pomija `node_modules`, `.git`,
     `dist`, `target`, `build` i katalogi zaczynające się od `.`, nie idzie za dowiązaniami i
     staje na 2000 katalogach.
   - Ignorowanie `.cwm/` sprawdza `git -c core.fsmonitor=false check-ignore -q -- .cwm/project.yaml`
     uruchomione bez powłoki, w katalogu projektu, z limitem 5 s; `core.fsmonitor=false` wyłącza
     program wskazany w `.git/config` obcego repozytorium. Bez gita działa heurystyka na
     `.gitignore` w korzeniu repozytorium i w katalogu projektu oraz `.git/info/exclude`
     (limit 256 KiB). Wzorzec z negacją (`!`) i brak gita dają wynik `unknown`, czyli
     ostrzeżenie, nie ciche przepuszczenie. Ostrzeżenie nie zmienia kodu wyjścia.
9. **Reguła przestrzeni nazw firmy** (rozwinięcie ADR 0037). Zasób z katalogu firmy
   `companies/<firma>/` musi mieć id `<firma>/<nazwa>`, a `<nazwa>` musi zgadzać się z nazwą
   katalogu; inaczej plik jest pomijany z problemem. W rejestrze globalnym id musi zgadzać się
   z położeniem `registry/<rodzaj>/<przestrzeń>/<nazwa>/`. Id firmy nie może być `global`,
   `marketplace`, `local` ani `git`. Projekt zagnieżdżony musi należeć do firmy projektu
   nadrzędnego i domyślnie ją dziedziczy.

### Wybory, których plan nie rozstrzyga

Poniższe wynikają z kodu. Właściciel ma je potwierdzić albo zmienić.

- Opcje globalne `--json` (wynik maszynowy, bez pytań) i `--no-input`. Pytania `@clack/prompts`
  pojawiają się tylko, gdy stdin i stdout są terminalem i nie podano żadnej z tych opcji.
  Pytamy o id firmy (`company add` bez argumentu), nazwę firmy, firmę projektu (wybór z listy)
  i id projektu, gdy nie da się go wyprowadzić z nazwy katalogu. Przerwanie pytania kończy się
  kodem `1`.
- `company add` ma opcje `--name` (domyślnie id) i `--instructions <plik>` (ścieżka względna
  zapisana w `instructions.file`) i zakłada `skills/`, `agents/`, `workflows/`, `projects/`.
- `project create/attach` mają opcje `--company`, `--id` (domyślnie nazwa katalogu zapisana
  małymi literami, znaki spoza `a-z0-9-` zamienione na `-`, do 63 znaków) i `--engine`
  (`claude-code` albo `codex`; domyślnie `defaults.engine` z `config.yaml`).
- `project attach` wykrywa i wypisuje `.claude/`, `CLAUDE.md` i `.mcp.json`, nigdy ich nie
  otwiera. `create` wymaga pustego katalogu albo katalogu, którego nie ma.
- `resource list` ma opcje `--kind` i `--company`, sortuje po rodzaju i id i oznacza konflikty.
- `resolve` bez `--project` szuka manifestu od bieżącego katalogu w górę; z `--project` tylko w
  podanym katalogu. Wynik to dokument z sekcji 10 specyfikacji bez wewnętrznego pola
  `resources` resolvera.
- `doctor` rozróżnia błędy (kod `1`) i ostrzeżenia (kod `0`). Ostrzeżeniami są: brakujące
  katalogi z `init`, uprawnienia katalogu danych i katalogów firm szersze niż 700 (POSIX),
  brak pliku `spec.source` obok definicji zasobu, pominięte dowiązania i obcięte skany. Ten
  sam problem zgłoszony z kilku miejsc liczy się raz.
- Zmiany w `core/cwm` poza planem: `escapeControlChars` w `errors.ts` (używany też przez
  `childPath`) oraz pole `metadata.path` w `validateProjectManifest`.
- `cwm --version` czyta wersję z `package.json`.

## Konsekwencje

**Czego nie ma.** Poleceń `start`, `sync`, `diff` i `run`, lockfile, generowania profili,
ekranu zatwierdzania, pluginów i MCP w silniku. `cwm` nie zapisuje do konfiguracji silnika
(`.claude/`, `~/.claude`, `.mcp.json`, `CLAUDE.md`), więc ADR 0020 i wymaganie ekranu
zatwierdzania z ADR 0037 pozostają bez zmian. Zapis do `~/.cwm` i `<projekt>/.cwm` idzie własną
drogą (`writer.ts`), a nie przez `WriteGate` z ADR 0012, bo `WriteGate` (po ADR 0031) dotyczy
zapisu poza `userData`, czyli konfiguracji narzędzi, a tu taka konfiguracja nie powstaje. Gdy powstanie warstwa zapisująca do silnika, musi
przejść przez `WriteGate`.

**Testy.** Zgodnie z decyzją właściciela z 2026-11-11 ten krok nie dodaje testów i nie
uruchamia ich. Zgodność z regułami powyżej sprawdzono czytaniem kodu, a przykłady z
`docs/CLI.md` wykonano ręcznie na katalogu tymczasowym. Nie wykonano ścieżek interaktywnych
(pytania `@clack/prompts` na terminalu), Windowsa (uprawnienia 700/600 dotyczą POSIX) ani
instalacji przez `npm link`.

**Znane ograniczenia.**

- Sprawdzenie ścieżki (`lstat` po składnikach) i zapis to dwie operacje. Nie chroni to przed
  atakującym, który równolegle zmienia drzewo wewnątrz `~/.cwm` albo `<projekt>/.cwm`.
- Heurystyka `.gitignore` bez gita nie odtwarza kolejności wzorców, dlatego negacja daje
  `unknown`.
- `cwm` bez argumentów i `cwm help` wypisują pomoc, ale kończą się kodem `2`; kod `0` mają
  tylko `-h` i `-V`.
- Kolejność wpisów katalogu przy obcięciu limitu jest dowolna, więc wynik skanu o ponad 5000
  wpisów nie jest powtarzalny.

**Koszt nowych zależności.** `commander` i `@clack/prompts` podlegają tym samym zasadom
łańcucha dostaw co `yaml` (przypięta wersja, `npm audit`, ryzyko S8 w `docs/ROADMAP.md`).
Obie są ESM-only, więc zmiana wersji głównej Node poniżej 24 albo przejście builda głównego na
inny format modułów wymaga przeglądu tego ADR.
