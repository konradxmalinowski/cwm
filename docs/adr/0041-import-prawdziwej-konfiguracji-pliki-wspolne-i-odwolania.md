# ADR 0041: Import prawdziwej konfiguracji, pliki wspólne i odwołania do katalogu natywnego

Status: zaakceptowane w zakresie decyzji właściciela (2026-11-12)
Data: 2026-11-12
Dotyczy: ADR 0039 (import, rodzaje `Settings` i `Command`), ADR 0040 (zatwierdzanie, profil, `cwm start`)
Źródło: próba `cwm import claude --dry-run` na prawdziwej konfiguracji właściciela (zawartość nie jest kopiowana do repozytorium); kod w `src/infra/cwm/import-*.ts`, `src/core/cwm/{hard-secrets,path-rewrite,cleanup-paths,settings-spec,native-settings}.ts`, `src/infra/cwm/runtime-plan.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

Etapy A i B działały na fixture'ach. Próba na prawdziwym `~/.claude` pokazała sześć luk: skille
instalowane jako dowiązania do drzewa wewnątrz `~/.claude` były pomijane w całości, większość plików
oznaczonych jako "możliwy sekret" to zwykły kod, agenci tracili klucz `memory`, wspólne przewodniki i
moduły agentów nie miały rodzaju zasobu, treść zasobów odwoływała się do `~/.claude/` (w sesji z
profilem czytałaby prawdziwy katalog) oraz `settings.json` gubił `attribution` i preferencje.

## Decyzje właściciela (2026-11-12)

1. **Dowiązania wewnątrz `--from`.** Dowiązanie jest śledzone tylko wtedy, gdy jego `realpath` to
   zwykły plik albo katalog wewnątrz `realpath(--from)` i poza pominiętymi obszarami (`skills/synced`,
   ukryte wpisy `skills/`, `.git`, `node_modules`, chronione nazwy, wszystko poza `skills/`, `agents/`,
   `commands/`). Do rejestru trafia kopia treści. Pętle i zerwane dowiązania są pomijane z raportem.
2. **Przegląd plików oznaczonych.** Plik pomocniczy z trafieniem klasyfikatora nie jest pomijany po
   cichu: plan wymienia go (ścieżka względem `--from`, powód, wiersz). Na terminalu wielokrotny
   wybór (domyślnie żaden), bez terminala `--include-flagged <ścieżka>`. Twardy sekret nigdy nie
   jest do dołączenia (`hard-secrets.ts`).
3. **Klucz `memory` agenta** (`user`, `project`, `local`) przechodzi do regenerowanego frontmattera;
   `color` był już dozwolony.
4. **Nowy rodzaj `Files`.** Wspólny materiał czytany po ścieżce.
5. **Przepisywanie odwołań** do natywnego katalogu w kopiach przy generowaniu profilu.
6. **Klucze `settings.json`**: `attribution`, `theme`, `tui`, `voice`, `voiceEnabled`,
   `preferredNotifChannel`, `enableWorkflows`. `skipDangerousModePermissionPrompt` nadal odrzucany.
7. **Testy**: wyjątek właściciela obejmuje tylko wykrywanie sekretów w `env`; ten ADR nie zmienia
   `classifyEnvValue` ani reguł `env`.

## Decyzja

### Dowiązania (IMP-01)

`followLink` (`import-source.ts`) rozwiązuje cel i sprawdza obszar. Katalog w drzewie jest czytany po
`realpath`, a łańcuch przodków chroni przed pętlą (także dowiązaniem do katalogu zawierającego korzeń
zasobu). Dowiązania na `skills/`, `agents/`, `commands/` i `settings.json` pozostają pomijane.
Skrót drzewa i pochodzenie liczone są od skopiowanych bajtów. Raport podaje liczbę śledzonych
dowiązań per zasób.

### Pliki oznaczone (IMP-03)

Każdy plik pomocniczy przechodzi `classifyFileName`, `classifyStrict` i `findHardSecret`. Twardy
sekret (blok klucza prywatnego, `AKIA`/`ASIA`, `sk-`/`sk-ant-`, `ghp_`/`github_pat_`/`glpat-`,
`xox?-`, JWT, adres z danymi logowania) oraz nazwa wysokiej pewności (`.env`, `*.pem`, `*.key`) dają
wpis `hard`, bez zawartości w pamięci. Reszta zachowuje bajty do ewentualnego dołączenia
(`withIncluded`). Dołączony plik wchodzi do zasobu i do skrótu drzewa tak jak każdy inny. Trafienie w
`SKILL.md`, `AGENT.md` albo `COMMAND.md` nadal pomija cały zasób. Skan twardych sekretów obejmuje
każdy plik pomocniczy, więc plik z samym adresem `://użytkownik:hasło@` też jest teraz oznaczany (do
tej pory klasyfikator go nie łapał).

### Rodzaj `Files`

Manifest `Files`: `metadata.id` (`<przestrzeń>/<nazwa>`), `version`, `spec.root` (`skills` albo
`agents`), `spec.path` (ścieżka względna, walidowana jak inne; bez chronionych nazw, `synced` i
`files.yaml`). Treść leży w katalogu zasobu pod tą samą ścieżką co w profilu, a `spec.path` jest
wspólnym przedrostkiem wszystkich plików (generator odrzuca niezgodność). Limity jak dla skilla (500
plików, 10 MiB, 16 poziomów, plik do 1 MiB). Źródła: `.md` wprost w `skills/`, katalog `skills/<x>` bez
`SKILL.md`, podkatalog `agents/<x>`. Nazwa zasobu to `skills-<x>` albo `agents-<x>`, bo ścieżka w
profilu musi być identyczna ze źródłową.

Zbiory zasobów (`global`, firma, projekt, `exports`, `imports`, `disableOptional`) mają klucz
`files`; `Skill.dependencies.files` jest liczone jako zależność. Lista dozwolonych ścieżek profilu
(`validateCleanupPath`) przyjmuje `claude/skills/<plik>.md`, `claude/skills/<x>/...` z nazwą pierwszego
segmentu także wielkimi literami oraz `claude/agents/<x>/...`; `claude/skills/<katalog>` bez pliku
nadal jest odrzucany.

**Zatwierdzanie.** `Files` to dane: `executionFields` jest `null`, dopóki żaden plik nie ma pól
wykonawczych. Zasób z `mandatory` też trafia do profilu pod zwykłą ścieżką (nie do pluginu z
przedrostkiem): to dane, a agenci odwołują się do nich po nazwie, której plugin by nie zachował.
Wyjątek (świadome odstępstwo od "bez zatwierdzenia"): silnik czyta `agents/` rekurencyjnie, więc
plik `.md` w `agents/<podkatalog>/` może być agentem. Takie pliki przechodzą przy imporcie i
generowaniu `parseContent('agent')` (klucze `hooks`, `mcpServers`, `permissionMode` odrzucają plik),
a wstawki `!` dają zasobowi zatwierdzenie z treścią wchodzącą do skrótu (`tools`, `allowed-tools` i `model` odrzucają plik, patrz poprawki). Plik
wykonywalny albo z `!` w `skills/` pozostaje daną, dopóki nie wskaże go hook (poza zakresem).

### Przepisywanie odwołań

`nativeDirPattern` i `rewriteNativeConfigRefs` (`path-rewrite.ts`, czyste) zamieniają `~/.claude`,
`$HOME/.claude`, `${HOME}/.claude` oraz bezwzględną ścieżkę `<home>/.claude` (i jej `realpath`) na
ścieżkę profilu `<runtime>/<firma>/claude`. Granice: bez poprzedzających `[\w./~$}-]` i bez
następującego `[\w-]` lub `.litera`, więc `~/.claude.json` zostaje. Przepisywane są pliki tekstowe
UTF-8 bez NUL i bez bitu wykonywania, przed `parseContent`, więc flagi, wstawki `!` i skrót
zatwierdzenia opisują bajty, które trafią do profilu (APR-04). Hooki nie są przepisywane. Katalog
`--from` jest zapisany w manifeście zasobu (`spec.nativeDir`, patrz poprawki niżej) i też jest
przepisywany; pochodzenie plików (ADR 0039 pkt 8) nadal nie trafia do rejestru.

### `settings.json`

`Settings` dostaje opcjonalne `attribution` (`commit`, `pr`; do 2048 znaków, bez sekretu, `\n` i `\t`
dozwolone, pusty tekst znaczy "bez dopisku") i `preferences` (krótkie nazwy trybów, flagi
logiczne, `voice.enabled`, `voice.mode`). Scalanie: ten sam klucz o różnych wartościach to błąd
resolvera także między `enforce: true` i `false`. Pola wchodzą do skrótu zatwierdzenia tylko, gdy są,
więc skróty zatwierdzonych `Settings` bez nich się nie zmieniają. Idą do `settings.json` profilu, a
przy `enforce: true` do pliku `--settings`.

## Poprawki po przeglądzie (2026-11-12)

- **Files nie niesie manifestu skilla.** Plik o nazwie `skill.md` (bez względu na wielkość liter) jest
  odrzucany w walidatorze (`spec.path`), przy imporcie (plik pominięty z raportem) i w planie
  generowania (błąd). Katalog z `skill.md` w dowolnej wielkości liter jest `Skill` (zmieniany na
  `SKILL.md`, z filtrem frontmattera i zatwierdzeniem), nie `Files`. Plik `.md` rodzaju `Files` w
  `skills/` przechodzi te same reguły frontmattera co skill (klucze wykonawcze odrzucają plik, `tools`
  i wstawki `!` dają zatwierdzenie z polami w całości), w `agents/` jak agent. Katalogi `Files` w
  `skills/` są rejestrowane jako zajęte, a klucze kolizji (`Collector`, nazwy) są w NFC bez
  rozróżniania wielkości liter (SEC-005).
- **`synced` bez względu na wielkość liter** w `cleanup-paths.ts`, walidatorze i imporcie (SEC-002).
- **Jedna reguła obszaru.** Cel dowiązania nie może być korzeniem obszaru (`skills/`, `agents/`,
  `commands/`), a ta sama reguła (`synced`, ukryty wpis `skills/`, `.git`, `node_modules`, chronione
  nazwy) obejmuje `relative(from, realpath(wpis))` każdego wpisu drzewa, więc dowiązanie do katalogu
  zawierającego `synced` też jest filtrowane (SEC-003).
- **Nazwa celu dowiązania.** Klasyfikator nazw plików sprawdza także nazwę celu (dowiązanie
  `notes.txt` do `.env` jest twardym sekretem).
- **Jeden klasyfikator.** Reguły wysokiej pewności są w `secret-classifier.ts` (`findHardSecret`).
  Długie linie są skanowane oknami z nakładką, nie pomijane. `sk-` tylko w znanych kształtach
  (`sk-` plus 20 znaków base62, `sk-ant-`, `sk-proj-`). Adres z danymi logowania, którego hasło jest
  wzorem (`user:password`, `${VAR}`, `<...>`, `***`) albo host to `example`/`localhost`, jest miękki
  (do przeglądu); reszta jest twarda.
- **Aliasy.** Dowiązanie najwyższego poziomu do innego wpisu tego samego obszaru (albo do celu
  innego dowiązania) jest raportowane jako alias i pomijane.
- **Twarde dowiązania** (`nlink > 1`) są pomijane z powodem w raporcie (SEC-004).
- **Katalog natywny w manifeście.** `Skill`, `Agent`, `Command` i `Files` mają opcjonalne
  `spec.nativeDir` (`realpath(--from)`), a `cwm start` przepisuje także odwołania do tej ścieżki.
  Skutek: zatwierdzenia zasobów, których treść wspomina katalog natywny, zmienią skrót (bajty po
  przepisaniu są inne) i zostaną zapytane raz po aktualizacji. Ponowny import dopisuje pole, więc
  zasoby dostaną status `zmieniony`.
- **Files bez bitu wykonywania** (zawsze 0600) w imporcie i w profilu (SEC-007).
- **Plik dołączony do modułu** (`withIncluded`) przechodzi te same reguły frontmattera; odrzucony
  jest raportowany jako "dolaczony plik odrzucony" i nie jest oznaczony jako dołączony.

## Druga weryfikacja bezpieczeństwa (2026-11-12)

- **Jedno zwinięcie nazw** (`foldName`: NFKC, małe litery, bez znaków łączących, bez końcowych kropek
  i spacji) dla każdego porównania pilnującego granicy: manifest skilla, `synced`, chronione nazwy,
  ukryte wpisy, `.git`/`node_modules`, kolizje (`Collector`, `taken`, drzewo skilla) i
  `cleanup-paths`. `ſkill.md`, `SKİLL.md`, `ＳＫＩＬＬ.ｍｄ` i `skill.md.` są manifestem skilla.
  Dodatkowo nazwy spoza ASCII w drzewach skilli, agentów, komend i `Files` są pomijane (konfiguracja
  właściciela jest ASCII; zamyka to klasy podobnych znaków poza NFKC). Katalog z lookalike'iem
  manifestu jest pomijany w całości.
- **Frontmatter `.md` w `Files`** (`skills/` i `agents/`) nigdy nie jest surowy: odtwarzany z
  dozwolonych kluczy; klucz scalania `<<`, znacznik `...` oraz klucze wykonawcze (`hooks`,
  `mcpServers`, `permissionMode`, `tools`, `allowed-tools`, `model`) odrzucają plik.
- **Adres z pustym użytkownikiem** (`://:hasło@host`) podlega tej samej regule twardy/miękki.
- **UTF-16** (BOM albo naprzemienne bajty zerowe) jest skanowany także po zdekodowaniu, twardym i
  miękkim klasyfikatorem.
- **`spec.nativeDir`** dla `Files` jest zapisywane przy imporcie (wcześniej brakowało go w manifeście
  `Files`) i używane przy przepisywaniu.
- **Alias między obszarami**: wpis `skills/x -> agents/m` jest aliasem. Ukryte wpisy są blokowane
  także w `agents/` i `commands/`, również przez dowiązanie.
- **Nazwa agenta**: dwa zasoby z tym samym `name` we frontmatterze (łącznie z plikami `.md` w
  `Files` pod `agents/`) to błąd planu `cwm start`, z nazwami obu.

## Drugi frontmatter (krytyczne, obowiązuje od Etapu A)

Odtworzenie frontmattera pomijało nagłówek, gdy żaden klucz nie przeżył. Wtedy treść pliku zaczynała
się od blokiem `---`, którego CWM nie analizował, a silnik uznawał go za frontmatter (`hooks`,
`permissionMode`, `allowed-tools` trafiały do profilu bez zatwierdzenia). Reguły, w
`parseContent` (import i generowanie profilu dla `Skill`, `Agent`, `Command` i `.md` w `Files`,
także dla plików już będących w rejestrze):

1. Gdy źródło miało frontmatter, wynik nigdy nie ma pustego bloku `---\n---`: pusty blok i treść w
   ksztalcie YAML z późniejszym `---` czyta parser kończący blok na `\n---` jako frontmatter (NEW-C2).
   `Skill`, `Agent` i `Command` zawsze mają co najmniej `name:` (zachowane z źródła albo nazwa
   zasobu), a `.md` w `Files` bez zachowanych kluczy traci nagłówek w całości.
2. Po odtworzeniu `splitFrontmatter(wynik)` musi dać dokładnie zachowane klucze (albo brak
   frontmattera) i oryginalną treść, a wynik przechodzi te same kontrole co wejście; inaczej plik
   jest odrzucany.
3. Odrzucana jest treść (po frontmatterze, albo cały plik bez frontmattera wg parsera CWM), która po
   obcięciu białych znaków, BOM, `\r`, NBSP, U+2028/2029, znaków zerowej szerokości i komentarzy
   HTML: zaczyna się od linii `---` albo `...`; zaczyna się od linii zaczynającej się `---` lub `+++`,
   ale niebędącej dokładnie `---` (`--- # x`, `---yaml`, `+++`); albo zaczyna się od prologu w
   kształcie YAML (`klucz: wartość`, `- element`, wcięcie, mapa lub lista przepływowa; puste wiersze i
   komentarze `#` nie przerywają prologu) zakończonego linią `---` lub `...` w pierwszych 64 KiB.
   Plik bez frontmattera zaczynający się od białych znaków i `---` jest niewidoczny dla CWM, więc też
   jest odrzucany. Poziomą linię `---` w środku treści, po zwykłym zdaniu, reguła nie dotyka.

Testy regresji (osobno dla `Skill`, `Agent` i `Command`, a przypadki wrogie także dla `Files`): dwa i
trzy bloki, pusty pierwszy blok, puste wiersze przed `---`, CRLF, BOM, U+2028/U+2029, NBSP, separator
U+2028 zamiast `\n`, prolog YAML (mapa, lista, mapa przepływowa, wcięcie, komentarz), `--- # x`,
`---yaml`, `+++`, komentarz HTML i linia zerowej szerokości przed `---`.

## Ryzyko szczątkowe

- **TOCTOU (SEC-006).** Między skanem a zapisem proces tego samego użytkownika może podmienić plik
  źródłowy albo cel dowiązania. Zapis idzie z planu, który użytkownik widział, ale plan nie chroni
  przed taką zmianą. Proces tego samego użytkownika jest poza modelem zagrożeń (jak w ADR 0040).
- **Klucz `memory` agenta (SEC-009)** to dane, nie wykonanie: włącza trwałą pamięć agenta (silnik
  zapisuje ją w swoim katalogu), nie uruchamia poleceń i nie zmienia uprawnień, więc nie wchodzi do
  pól wykonawczych zatwierdzenia.

## Konsekwencje

- Na próbie na prawdziwej konfiguracji liczba importowanych zasobów wzrosła z 48 do 118, a liczba
  pominięć spadła z 225 do 26 (liczby zbiorcze w opisie PR).
- Drzewo przekraczające 500 plików jest nadal pomijane w całości (limit z ADR 0039 pkt 9 bez zmian).
- Istniejący `~/.cwm` potrzebuje ponownego `cwm init`, żeby dostać `registry/files/`; bez niego
  `cwm doctor` ostrzega.
- Plik `.md` w `Files` z wstawką `!` wymaga zatwierdzenia przy `cwm start`.
- Testy: nie dodano nowych; istniejący test odcisku zatwierdzenia dostał pole `files` w fixture'ze
  (zmiana typu `ResourceSet`).
