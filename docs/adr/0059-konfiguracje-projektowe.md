# ADR 0059: konfiguracje projektowe, pierwszy zakres

Status: zaakceptowane
Data: 2026-11-18
Zastępuje: ADR 0032 (MVP obsługuje tylko konfiguracje globalne)
Dotyczy: ADR 0008 (granica IPC), ADR 0012 (`WriteGate`), ADR 0015 (materializacja), ADR 0022 (warstwa lokalizacji), ADR 0053 (katalogi chronione), ADR 0054 (eksport ZIP)

## Kontekst

ADR 0032 ograniczył aplikację do katalogów globalnych (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.agents`).
Uzasadnienie miało trzy części: aplikacja nie zna listy projektów, renderer nie może podać ścieżki, a
element jednego projektu nie może trafić do innego. Wartość `project` w `classification.scope` została w
modelu jako etykieta, której nic nie egzekwowało.

Użytkownicy trzymają skille, agentów, komendy i `CLAUDE.md` w repozytoriach. Bez projektów biblioteka
tego nie widzi, a eksport nie umie tam pisać. CLI ma już pojęcie projektu (`~/.cwm`, `project.yaml`,
`src/infra/cwm/project-dir.ts`), ale to manifest CWM dla `cwm start`, a nie katalog konfiguracji narzędzia:
CLI celowo nie pisze do `.claude/` ani `CLAUDE.md` w repozytorium. Aplikacja nie przejmuje więc tego
rejestru, tylko ma własny.

## Rozważane opcje

**Ścieżka projektu z pola tekstowego w rendererze.** Odrzucone: łamie regułę 1 z ARCHITECTURE 7.2
(renderer nie podaje ścieżek) i otwiera kanał, którym skompromitowany renderer wskaże dowolny katalog.

**Wspólny rejestr z CLI (`~/.cwm`).** Odrzucone na teraz: projekt CLI to manifest CWM, a nie miejsce
konfiguracji narzędzia, a `~/.cwm` ma jednego pisarza, `src/infra/cwm/writer.ts` (ADR 0038). Projekt może
być w obu rejestrach naraz; łączenie ich to osobna decyzja.

**Rejestr w `userData` i katalog wyłącznie z natywnego okna w main.** Wybrane.

## Decyzja

1. **Rejestr projektów.** `userData/projects.json` (`format: cwm-projects`, wersja 1, tryb 0600, zapis
   atomowy): identyfikator `proj-<16 hex>`, nazwa (do 80 znaków, bez znaków sterujących), katalog po
   `realpath` i data dodania. Najwyżej 64 projekty, ten sam katalog nie wchodzi dwa razy. Nazwy są
   unikalne bez względu na wielkość liter: przy kolizji w chwili dodania nazwa dostaje w nawiasie nazwę
   katalogu nadrzędnego (a gdy i ta jest zajęta, numer), a zmiana nazwy na zajętą jest odrzucana
   (`name-taken`). Uszkodzony plik daje pustą listę zamiast błędu startu. Przy wczytaniu każdy wpis
   przechodzi od nowa politykę z punktu 2 (`projectDirPolicyProblem`); wpis, który jej nie przechodzi (np.
   ręcznie zmieniony plik), zostaje na liście jako niedostępny z powodem: nie da się go skanować ani
   wybrać jako celu, można go tylko usunąć.
2. **Wybór katalogu tylko w main.** `projects:add` nie przyjmuje ładunku i otwiera `dialog.showOpenDialog`
   (`openDirectory`). Wynik okna nie jest zaufany: `checkChosenProjectDir` odrzuca ścieżkę względną i UNC,
   brak katalogu, plik i wybrany katalog będący dowiązaniem symbolicznym, a potem na `realpath` uruchamia
   politykę `projectDirPolicyProblem`. Polityka odrzuca: ścieżkę UNC także po rozwiązaniu dowiązań, korzeń
   dysku, każdą ścieżkę ze składnikiem `.git`, katalog domowy i każdy jego katalog nadrzędny, katalogi pod
   punktami montowania `/Volumes`, `/mnt` i `/media` (dyski zewnętrzne, sieciowe i wymienne; komunikat mówi
   to wprost), katalogi systemowe (POSIX: `/usr`, `/etc`, `/bin`, `/System`, `/Library` i ich wnętrze oraz
   katalogi zbiorcze jak `/home`, `/Users`, `/var`, `/tmp`; Windows: `Windows`, `Program Files`,
   `ProgramData` i `Users`), katalogi z kluczami i danymi logowania (`~/.ssh`, `~/.aws`, `~/.gnupg`,
   `~/.config`, `~/.kube`) oraz katalog, który leży w konfiguracji narzędzia albo w danych aplikacji lub je
   zawiera, w tym same katalogi `~/.claude`, `~/.codex`, `~/.gemini`, `~/.agents` i `~/.cwm` (te same
   katalogi chronione co w ADR 0053). Zapisany jest `realpath`; dowiązania wyżej w ścieżce (np. `/var` na
   macOS) są rozwiązane. Renderer dostaje wyłącznie `projectId`, nazwę i ewentualny powód niedostępności.
3. **Rooty projektowe.** Tabela `PROJECT_CANDIDATES` w `src/infra/platform/locations.ts`, obok `CANDIDATES`,
   jest jedynym miejscem, które zna ścieżki w projekcie (ADR 0022). W tym zakresie tylko Claude Code:

   | Narzędzie | Rodzaj roota | Ścieżka w projekcie | Stan |
   |---|---|---|---|
   | Claude Code | skille | `.claude/skills` | [D] |
   | Claude Code | agenci | `.claude/agents` | [D] |
   | Claude Code | komendy | `.claude/commands` | [D] |
   | Claude Code | instrukcje | `CLAUDE.md` w korzeniu | [D] |
   | Claude Code | hooki | `.claude/settings.json` | [?] poza zakresem |
   | Codex | instrukcje, skille | `AGENTS.md`, `.codex/` | [?] poza zakresem |
   | Gemini CLI | instrukcje, skille, komendy | `GEMINI.md`, `.gemini/` | [?] poza zakresem |

   [D] znaczy: format pliku jest ten sam co w katalogu globalnym, więc adapter i eksporter działają bez
   zmian, tylko dostają rooty projektu. `.claude/settings.json` nie jest rootem, bo ten plik trzyma też
   uprawnienia projektu, a zapis hooków do repozytorium to osobna decyzja. `FsProjectCatalog` liczy
   `rootId` tym samym HMAC z trwałą solą co rooty globalne (z prefiksem projektu w danych), więc kopie
   zapasowe i Historia odnajdują root po restarcie. Etykieta to nazwa projektu i ścieżka względna
   (`acme-app: .claude/skills`), nigdy ścieżka bezwzględna.
4. **Bez dowiązań w rootach.** Przy każdym użyciu (`roots()`) katalog projektu musi istnieć, nie być
   dowiązaniem, mieć ten sam `realpath` co w rejestrze i przejść politykę z punktu 2; inaczej projekt jest
   niedostępny (`project-invalid`) do czasu ponownego dodania. Inny błąd odczytu niż brak wpisu (np. brak
   uprawnień) też daje `project-invalid`. Root, na którego ścieżce (`.claude`, `.claude/skills`,
   `CLAUDE.md`) leży dowiązanie, nie jest zwracany wcale. Przeciw podmianie między planem a zapisem
   (TOCTOU) działają trzy kontrole: synchroniczne `resolvePath` sprawdza katalog i składniki roota; katalog
   projektu jest drugą granicą zawierania, więc `locateTarget` w `write-path-guard.ts` i `locate` czytnika
   źródła wymagają, żeby root po `realpath` leżał w katalogu projektu; a `WriteGate` tuż przed każdym
   zapisem wpisu uruchamia `projectRootIntactSync` jeszcze raz i przy zmianie przerywa zapis i cofa go.
5. **Import z projektu.** Kanał `import:scan-project { projectId }`: ten sam przebieg i te same adaptery
   co `import:scan`, na istniejących rootach projektu. Zapisany element dostaje `classification.scope:
   project` i `classification.projectId`. Element biblioteki o tym samym typie i slugu, ale z innym
   przypięciem (globalny albo z innego projektu), jest `conflict`, a nie `changed`: zastąpienie
   przeniosłoby go między zakresami. Wchodzi pod nową nazwą przez istniejący mechanizm ADR 0057. Działa
   to w obie strony: skan globalny nie nadpisze elementu projektu.
6. **Model.** `ItemClassification.projectId` jest opcjonalny; walidator przyjmuje go tylko w formacie
   identyfikatora z rejestru i tylko przy `scope: project`. Etykieta `project` bez pola (zapis sprzed tej
   decyzji albo wybór w formularzu) niczego nie wiąże i zachowuje się jak dotąd. Przypięcia nie zmienia
   formularz: `library:save` przenosi `projectId` z zapisanego elementu i wymusza `scope: project`, a
   formularz pokazuje zamiast listy zakresu zdanie o przypięciu.
7. **Zakres egzekwowany w core.** `ExportService.plan` dostaje cel: katalog globalny albo
   `{ projectId, includeGlobal }`. Reguła (`core/services/export/project-scope.ts`): element przypięty
   trafia tylko do swojego projektu; element globalny trafia do projektu tylko z `includeGlobal`, ale
   nigdy element prywatny ani z trafieniem klasyfikatora sekretów (repozytorium trafia do Gita i dalej,
   więc ta zgoda ich nie obejmuje); do katalogu globalnego nie trafia żaden element przypięty. Odmowa jest
   wpisem w `refusals` planu, a eksporter nie dostaje odmówionego elementu wcale. `SyncService` pomija
   elementy przypięte w stanie i w planie (synchronizacja dotyczy katalogów globalnych). Eksport ZIP
   zatrzymuje element z etykietą `project` albo z `projectId` z powodem `project`, bez możliwości zgody, jak
   w ADR 0054: archiwum służy do przekazania dalej, a element przypięty wraca tylko do swojego repozytorium.
8. **Zakres egzekwowany w main.** Niezależnie od core main sprawdza gotowy plan
   (`main/services/project-scope-check.ts`) w `export:plan` i `sync:plan`: każdy wpis pisze do rootów celu
   (właściciel roota z rejestru, `null` dla globalnych), a każdy element we wpisie może do tego celu
   trafić (z tą samą regułą dla elementów prywatnych i z sekretem, na polu `restricted` planu). Kanał
   `export:plan` buduje plan przez `preview`, sprawdza go i dopiero wtedy wywołuje `retain`, więc plan
   odrzucony z kodem `scope-violation` w ogóle nie istnieje w serwisie i nie da się go zatwierdzić.
   `projectId` z renderera jest walidowany co do formatu, a jego istnienie i ważność katalogu sprawdza
   rejestr.
9. **Zapis do repozytorium.** Ta sama bramka, ta sama kopia zapasowa przed zapisem, ten sam plan z
   podglądem i jawnym zatwierdzeniem, ta sama Historia i cofnięcie. Dwie różnice: do projektu zawsze idzie
   kopia plików (dowiązanie do `userData` trafiłoby do Gita jako ścieżka z tego komputera), a zapis do
   projektu nie zostawia stanu synchronizacji. Warunek z ADR 0033 (katalog główny narzędzia musi istnieć)
   dotyczy tu katalogu `.claude`: bez niego skille, agenci i komendy są zablokowane, a `CLAUDE.md` w
   korzeniu działa. Aplikacja nie zmienia `.gitignore` i niczego nie commituje; kreator mówi wprost, że
   Git zobaczy zmiany.
10. **IPC.** Nowe kanały: `projects:list`, `projects:add` (bez ładunku), `projects:rename { projectId,
    name }`, `projects:remove { projectId, confirmed? }` i `import:scan-project { projectId }`.
    `export:plan` dostaje opcjonalne `projectId` i `includeGlobal` (to drugie tylko razem z pierwszym), a
    `ExportPlanDto` pole `project`. `projects:remove` bez `confirmed` zwraca liczbę elementów przypiętych do
    projektu; z `confirmed: true` odpina je w bibliotece (zakres prywatny, bez `projectId`, wpis w Historii
    z notatką `odpieto=<projectId>`) i dopiero potem usuwa wpis. Błąd odpięcia zostawia projekt na liście.
    Dlatego `projects:remove` jest w `WRITE_CHANNELS`; pozostałe kanały `projects:*` piszą tylko plik
    rejestru.
11. **Interfejs.** Import, krok 1: sekcja "Z projektu" między lokalizacjami narzędzi a repozytorium Git,
    z listą projektów (przeskanuj, zmień nazwę, usuń z listy) i przyciskiem "Dodaj projekt". Eksport: w
    "Cel eksportu" każdy projekt jako opcja "Projekt „nazwa” (Claude Code)", pod nią zdanie o Gicie i
    pole "Dołącz elementy globalne". Plan pokazuje cel.

## Konsekwencje

Instrukcje i skille z repozytoriów trafiają do biblioteki i wracają do swojego repozytorium z tym samym
planem, kopią i Historią co eksport globalny. Element projektu nie przecieka do `~/.claude` ani do innego
projektu, a pilnują tego dwie niezależne kontrole: planowanie w core i sprawdzenie planu w main.

Koszty i ograniczenia, na które się godzimy:

- Ten sam slug w dwóch projektach albo w projekcie i globalnie wymaga nowej nazwy, bo nazwy w bibliotece są
  unikalne per typ (ADR 0017). Najczęściej dotyczy to `CLAUDE.md`, który ma stały slug.
- `CLAUDE.md` projektu jest w bibliotece elementem `global-instruction` z zakresem `project`; rodzaj
  `project-instruction` z modelu zostaje nieużywany.
- Usunięcie projektu z listy odpina jego elementy do zakresu prywatnego. Element prywatny nie wraca do
  innego repozytorium nawet z `includeGlobal`, więc żeby trafił do projektu, trzeba go zaimportować z niego
  ponownie albo świadomie zmienić zakres w formularzu.
- Projekt na dysku zewnętrznym albo zamontowanym (`/Volumes`, `/mnt`, `/media`) jest odrzucany: takie
  katalogi znikają i wracają pod inną ścieżką, a zapis do nich nie ma gwarancji kopii zapasowej po
  odłączeniu dysku. To dotyczy też WSL, gdzie dyski Windowsa są pod `/mnt`.
- Przeniesienie albo zmiana nazwy katalogu projektu na dysku wyłącza projekt; trzeba go usunąć z listy i
  dodać ponownie, a stare elementy mają wtedy stary `projectId`.
- Plik, który zapis tworzy w projekcie, może się znaleźć w commicie użytkownika. Aplikacja ostrzega, ale nie
  zmienia `.gitignore`.

## Otwarte (poza tym zakresem)

- Synchronizacja z projektem (stan, różnice i przyjmowanie zmian z repozytorium). Dziś eksport do projektu
  działa, ale Centrum synchronizacji widzi tylko katalogi globalne.
- Rooty projektowe Codeksa (`AGENTS.md`, `.codex/`) i Gemini CLI (`GEMINI.md`, `.gemini/`), z regułą
  pierwszeństwa dla `AGENTS.md` zagnieżdżonych w podkatalogach.
- Hooki i ustawienia projektu (`.claude/settings.json`, `.claude/settings.local.json`) oraz `.mcp.json`.
- Przepięcie elementu do innego projektu albo odpięcie bez ponownego importu.
- Wspólny rejestr z projektami CLI (`~/.cwm`) albo import listy projektów z niego.
- Widok projektu w bibliotece (filtr po projekcie, nazwa projektu w szczegółach elementu).
