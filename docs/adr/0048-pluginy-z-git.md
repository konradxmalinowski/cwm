# ADR 0048: Pluginy z repozytorium git

Status: zaakceptowane w zakresie planu (2026-11-15)
Data: 2026-11-15
Dotyczy: ADR 0037 (model zasobów, `source.type: git`), ADR 0040 (zatwierdzanie, `cwm start`), ADR 0043 (pluginy z marketplace'u), ADR 0046 (`cwm plugin`)
Źródło: plan `plans/2026-11-15-cwm-git-plugins.md` (lokalny, poza repozytorium); kod w `src/core/cwm/git-source.ts`, `src/infra/cwm/{git-fetch,git-source,plugin-registry,runtime-plan,writer}.ts`, `src/cli/commands/plugin.ts`, `eslint.config.mjs`, `scripts/verify-boundaries.mjs`; opis użytkowy w `docs/CLI.md`

## Kontekst

Model `Plugin` zna źródło `{type: git, url, ref?}` od ADR 0037, ale `cwm start` obsługiwał tylko `local` i
`marketplace`. Plugin z git to najgroźniejsze źródło dotąd: kod pochodzi z sieci, a po zatwierdzeniu silnik
uruchamia go bez własnego pytania (hooki, serwery MCP). Decyzje poniżej wynikają z jednej zasady: sieć jest
jawnym, osobnym krokiem, a to, co zatwierdzono, jest dokładnie tym, co zostanie uruchomione.

## Decyzja

1. **Sieć tylko w trzech poleceniach.** `cwm plugin add git <url> --id git/<nazwa> [--ref <ref>]`,
   `cwm plugin fetch <id>` i `cwm plugin update <id> [--ref <ref>]` pobierają. `cwm start`, `cwm diff` i
   `cwm sync` nigdy nie uruchamiają `git` ani nie łączą się z siecią. Egzekwuje to lint:
   `child_process` wolno importować tylko `engine-process.ts`, `gitignore.ts` i `git-fetch.ts`, a
   `git-fetch.ts` wolno zaimportować tylko `cli/commands/plugin.ts` (reguła `import-x/no-restricted-paths`
   z wyjątkiem). Kod odczytu (ścieżki, kontrola zaufania kopii) leży w osobnym `git-source.ts`, który nie
   uruchamia procesów i jest eksportowany z `index.ts`; `git-fetch.ts` z `index.ts` nie jest. Sonda
   `npm run test:boundaries` wstawia import `git-fetch` do planu, diffu, synchronizacji, polecenia
   `start`/`diff` i `main/` (lint ma paść), wstawia `child_process` do `runtime-plan*` i `runtime-sources*` oraz
   skanuje źródła pod kątem odwołań do `git-fetch` i `child_process` poza listą (obejmuje `require` i
   `import()`).
2. **Przypięcie do commita.** Po pobraniu manifest dostaje `source.commit` (pełny SHA-1 albo SHA-256).
   `cwm start` używa wyłącznie tej kopii: `~/.cwm/sources/git/<skrót adresu>/<commit>/`. Brak kopii albo
   brak `source.commit` to błąd planu z poleceniem `cwm plugin fetch <id>`. Ref (gałąź, tag) służy tylko
   do `add` i `update`; nic go nie rozwiązuje przy starcie, więc ruch gałęzi na serwerze nie zmienia niczego
   bez `update`. `fetch` pobiera po SHA i odrzuca odpowiedź z innym commitem.
3. **Pobranie.** `git` z `PATH` po ścieżce bezwzględnej (`realpath`, te same warunki właściciela i uprawnień
   co plik silnika, wspólna funkcja `executableRejection`), w pustym katalogu roboczym 0700 pod `sources/git/`,
   bez powłoki, we własnej grupie procesów. Środowisko budowane od zera (`buildGitEnv`): z procesu CWM tylko
   `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`; `HOME`, `XDG_CONFIG_HOME` i `TMPDIR` to katalog
   roboczy (żadnego `~/.netrc`, `~/.ssh`, `~/.gitconfig`), `GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`,
   `GIT_ALLOW_PROTOCOL=https`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_LFS_SKIP_SMUDGE=1`. Opcje `-c` przed każdym
   poleceniem (`gitHardeningArgs`): `core.hooksPath=/dev/null`, `protocol.allow=never` z jedynym wyjątkiem
   `https` (i `http` na pętli zwrotnej), `protocol.{file,ext,git,ssh}.allow=never`,
   `http.followRedirects=false`, `fetch.recurseSubmodules=false`, `filter.lfs.*` puste, `credential.helper=`
   puste, `transfer.fsckObjects` i `fetch.fsckObjects`, `core.protectHFS` i `core.protectNTFS`. Repozytorium
   robocze powstaje przez `git init --template=` (bez szablonu, więc bez hooków), a pobranie to
   `git fetch --depth=1 --no-tags --no-recurse-submodules -- <url> <ref|sha|HEAD>`.
4. **Adres i ref.** Dozwolone `https://`; `http://` tylko dla `localhost`, `127.0.0.0/8` i `::1` (ta sama reguła
   co `Checker.url` i adresy MCP; potrzebna do lokalnych serwerów i prób). Odrzucane: `file://`, `ext::`,
   `git://`, `ssh://`, ścieżki lokalne, nazwa użytkownika i hasło w adresie, zapytanie, fragment, białe znaki,
   znaki sterujące i `\`. Adres musi być w formie kanonicznej (`new URL(tekst).href === tekst`): `git`
   dostaje dokładnie ten tekst, który sprawdzono, więc `HTTPS://`, cyfry pełnej szerokości, `http:host:port/x`
   (które `git` czyta jak scp-ssh) i jawny domyślny port są odrzucane z podpowiedzią formy kanonicznej. Tę samą kontrolę (`gitUrlProblem`) robi CLI, walidator manifestu i `git-fetch.ts`
   (obrona w głąb). Ref: nazwa gałęzi, tagu albo pełny SHA; skrócony SHA, `..`, `//`, `.lock` i początkowy `-`
   są odrzucane. SSH nie jest obsługiwany w tym etapie (zob. „Poza zakresem”).
5. **Kontrola przed wypakowaniem.** `git ls-tree -r -l -z <commit>` jest sprawdzane przez czystą funkcję
   `checkGitTreeListing`: tylko tryby 100644 i 100755 (dowiązanie symboliczne to błąd, składnik `.git` to
   błąd), limity jak `readTree` (500 plików, 1 MiB na plik, 10 MiB razem). Submoduły (160000) nie są
   pobierane; to ostrzeżenie, w kopii zostaje pusty katalog, którego `readTree` nie widzi. `git read-tree` i
   `git checkout-index -a -f` wypakowują do katalogu roboczego poza repozytorium (`GIT_DIR` i `GIT_WORK_TREE`),
   więc w kopii nie ma `.git`. Atrybuty (`.gitattributes`) nie uruchamiają niczego, bo filtry wymagają
   konfiguracji, której nie ma. Limity procesu: 120 s na polecenie, 300 s łącznie, 64 MiB w katalogu
   roboczym podczas pobierania (kontrola co 200 ms, przed pobraniem sprawdzane jest wolne miejsce: co najmniej
   128 MiB), 4 MiB wyjścia; limit czasu i rozmiaru zabija całą grupę
   procesów (pomocnik `git-remote-https` też), a SIGINT, SIGTERM i SIGHUP robią to samo (komunikat
   `przerwano`). Katalog roboczy jest usuwany zawsze, a pozostałości po zabitym procesie (`.tmp-*` starsze
   niż godzina) przy następnym pobieraniu.
6. **Ta sama droga co `local`.** Wypakowane drzewo czyta `readTree` z `rejectHardlinks` (bez dowiązań, bez
   twardych dowiązań, bez kolizji wielkości liter, limity), potem plik po pliku, jak plugin `local`: migawka
   `plugins/<id>@<skrót>`, `extractPluginExecutables`, piny, `pluginExec`, zatwierdzenie. `cwm start`
   dodatkowo wymaga, żeby kopia i jej składniki ścieżki były zwykłymi katalogami użytkownika bez zapisu dla
   grupy i innych (`trustedDirectory`, ta sama kontrola co katalog marketplace'u) i sprawdza po odczycie, że
   katalog nadal rozwiązuje się do tej samej ścieżki.
7. **Zapis kopii.** Kopia trafia na miejsce przez nową funkcję writera `installScopedTree`: tryby plików
   (0600 albo 0700 z bitem wykonywania) i katalogów (0700) są ustawiane jawnie, niezależnie od `umask`, a
   zamiana katalogów zostawia poprzednią wersję jako `.nazwa.old-*`, usuwaną na końcu. Nazwy plików w środku
   nie są sprawdzane pod kątem chronionych nazw (plugin może mieć `.mcp.json` albo `CLAUDE.md`; kopia leży w
   `sources/` i jest tylko czytana, nic z niej nie trafia do natywnej konfiguracji). Ten sam commit z tym samym
   skrótem drzewa nie jest zapisywany ponownie.
7a. **Skrót drzewa w manifeście.** `fetch` i `update` zapisują `source.tree` (skrót drzewa zainstalowanej
   kopii). `cwm start` odmawia, gdy skrót drzewa kopii jest inny albo go brak, z podpowiedzią
   `cwm plugin fetch <id>`; `fetch` pobiera ponownie, gdy kopia się nie zgadza (nie mówi „na miejscu”), a gdy
   świeżo pobrany commit daje inny skrót niż zapisany, odmawia i odsyła do `update`. Dzięki temu podmiana
   kopii na dysku jest wykrywana przy starcie, nie dopiero przy zatwierdzeniu.
7b. **Straznik sieci.** `cwm start`, `cwm diff` i `cwm sync` wołają `denyNetwork()` na początku, a
   `fetchGitSource` rzuca błąd, gdy flaga jest ustawiona (druga warstwa po lincie). Lint zabrania ponadto
   `import()` i `require()` z argumentem niebędącym literałem oraz `process.binding` i `process.dlopen` w
   `src/`, a skan źródeł szuka `git-fetch` jako słowa (także w szablonach i z rozszerzeniem `.js`).
8. **Zatwierdzenie.** Pola jak dla `local` plus blok `git` `{url, ref, commit}` (adres po `sanitizeGitUrl`).
   Blok jest dodawany tylko dla pluginu z git, więc skróty `local` i `marketplace` się nie zmieniają
   (przypadki w `tests/unit/cwm-approval-hash.test.ts`). Zmiana adresu, refu albo commita pyta ponownie;
   `update` nie zatwierdza niczego: zmienia się skrót drzewa, więc pyta `cwm start`.
9. **Id i rejestr.** Id pluginów z git mają przestrzeń `git` (zarezerwowaną od ADR 0037); `--id` jest
   wymagane. `isPluginId` przyjmuje `marketplace/` i `git/`. Zasób leży w `registry/plugins/git/<nazwa>/`.
   `cwm plugin add git` sprawdza kolizję id przed siecią i w razie błędu po pobraniu usuwa świeżo utworzoną
   kopię. Firmy z `--enable` (istnienie, `plugins.forbid`) są sprawdzane przed siecią, a ścieżki błędów po pobraniu
    usuwają kopię tylko wtedy, gdy żaden zasób z rejestru jej nie używa. Pobieranie odbywa się poza blokadą
    `runtime/global` (trwa do kilku minut), a zapis manifestu pod nią.
10. **`update`.** Pobiera aktualny commit refu i zapisuje go w manifeście; pokazuje stary i nowy commit oraz
    listę zmienionych plików (różnica skrótów treści i bitu wykonywania obu drzew, do 50 wierszy, ścieżki ze
    znakami sterującymi wypisywane jako `\u{...}`; `checkGitTreeListing` takie ścieżki w ogóle odrzuca), o ile kopia
    starego commita jest na dysku. Wersja zasobu podąża za `version` z `plugin.json`, gdy ma format
    `MAJOR.MINOR.PATCH`. Stara kopia jest usuwana, gdy żaden inny zasób jej nie używa.
11. **`remove`.** Usuwa też kopię `sources/git/<skrót adresu>/<commit>/` (i pusty katalog repozytorium), jeśli
    żaden inny zasób nie wskazuje tego samego adresu i commita.

## Konsekwencje

- Plugin z git zatwierdzony na jednej maszynie wymaga `cwm plugin fetch` na drugiej (kopia nie jest w
  rejestrze, tylko w `sources/`); start bez niej odmawia, a nie pobiera po cichu.
- Pobieranie jest anonimowe. Prywatne repozytoria (token, SSH) nie działają; to świadome ograniczenie, nie
  błąd: pomocniki haseł, agent SSH i `~/.netrc` są odcięte.
- Serwer musi pozwalać na pobranie po SHA (`fetch` przy brakującej kopii); GitHub i GitLab pozwalają. Gdy
  commit zniknął z serwera (force push, usunięta gałąź), `fetch` kończy się błędem, a `update` przesuwa
  przypięcie na nowy commit.
- Wersje `git` bez `GIT_CONFIG_GLOBAL` (przed 2.32) nie są obsługiwane; środowisko i opcje `-c` zakładają
  nowoczesnego klienta.

## Ryzyko szczątkowe

- **Bajty z atrybutów.** `.gitattributes` (`working-tree-encoding`, `ident`, `text eol=`) może zmienić bajty
  wypakowane przez `checkout-index` względem blobów w commicie. `source.tree` wiąże zatwierdzenie z tym, co
  faktycznie wypakowano, ale nie z blobami. Lepsza opcja (kolejny krok): wypakowanie surowych blobów przez
  `git cat-file --batch` z pominięciem filtrów i atrybutów oraz offline weryfikacja obiektu commita (skrót
  SHA obiektu równy przypiętemu), tak by drzewo wynikało wyłącznie z commita.
- **Obiekt ze wspólnego magazynu forka.** Serwer z wspólnym magazynem obiektów (forki) może wydać commit,
  który nie jest osiągalny z podanego refu (commit „podszywacz” z innego forka). Przypięcie po SHA i
  zatwierdzenie pokazują, co zostanie uruchomione, ale CWM nie sprawdza, że commit leży na gałęzi z `ref`.
  Do zrobienia: ostrzeżenie w zatwierdzeniu, gdy commit nie jest osiągalny z refu (wymaga pobrania historii).
- **SIGKILL na CWM.** Proces `git` jest we własnej grupie procesów, więc po `kill -9` na samym CWM przeżywa
  do zerwania połączenia albo własnego limitu; katalog `.tmp-*` usuwa następne pobieranie (po godzinie).

- Kopia w `sources/` nie jest ponownie porównywana z commitem (to wymagałoby `git` przy starcie). Wiąże ją z
  zatwierdzeniem skrót drzewa i lista plików, ale ktoś z prawem zapisu w `~/.cwm` (ten sam użytkownik, root)
  może ją podmienić między zatwierdzeniem a startem; podmiana pliku zmienia skrót i pyta ponownie przy
  następnym starcie, nie w trakcie sesji (jak w ADR 0043).
- Zawartość pluginu jest nadal kodem z sieci: zatwierdzenie pokazuje hooki, serwery MCP i LSP oraz piny, ale
  zawartość katalogów `commands`, `agents`, `skills`, `outputStyles` nie jest analizowana (ADR 0040).
- `http.followRedirects=false`: adres, który przekierowuje (np. po zmianie nazwy repozytorium), kończy się
  błędem pobrania; trzeba podać końcowy adres.
- Użytkownik z `HTTPS_PROXY` w środowisku przekazuje go dalej do `git` (adres proxy może zawierać dane
  logowania; nie są logowane, ale są w środowisku procesu `git`).
- `git` wskazany przez `PATH` jest zaufany tak jak plik silnika (właściciel i uprawnienia, nie podpis).
  `/usr/bin/git` na macOS to powłoka `xcrun`, która potrzebuje narzędzi deweloperskich.
- Brak kontroli ruchu sieciowego poza protokołami i adresem: `git` może łączyć się z dowolnym hostem https
  z manifestu, w tym z adresami prywatnych sieci (SSRF do usług HTTP odpowiadających protokołem git smart-http
  jest mało prawdopodobne, ale nie jest blokowane). Adres w manifeście jest zaufany jak każde inne pole
  wpisane przez użytkownika.
- Windows: kontrola właściciela nie działa (brak uid), `cwm start` tam i tak odmawia.

## Poza zakresem

SSH (`ssh://`, `git@host:ścieżka`) z kluczem użytkownika bez agenta, pobieranie prywatnych repozytoriów,
marketplace'y zdalne, weryfikacja podpisów commitów i tagów, `runtime.git.path` (jawna ścieżka `git` jak
`runtime.claude.path`), submoduły.
