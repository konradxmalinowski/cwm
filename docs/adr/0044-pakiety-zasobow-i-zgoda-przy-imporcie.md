# ADR 0044: Pakiety zasobów i zgoda przy imporcie

Status: zaakceptowane w zakresie decyzji właściciela (2026-11-14); punkty z sekcji „Do potwierdzenia przez właściciela” czekają
Data: 2026-11-14
Dotyczy: ADR 0040 (zatwierdzanie i `cwm start`), ADR 0041 (import, przepisywanie odwołań), ADR 0042 (hooki skilli), ADR 0039 (import)
Źródło: plan `plans/2026-11-14-cwm-pakiety.md` (lokalny, poza repozytorium); kod w `src/core/cwm/pack.ts`, `src/infra/cwm/{pack-derive,pack-import,packs,native-rewrite}.ts`, `src/infra/cwm/runtime-plan.ts`, `src/cli/commands/{import,start,approvals,pack}.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

Pierwsze prawdziwe użycie: `cwm start` w projekcie z zaimportowaną konfiguracją pytał kilkadziesiąt
razy (61 skilli z `allowed-tools` lub wstawkami `!`, 4 skille z hookami, firma, projekt, plugin,
ustawienia). Zatwierdzanie zbiorcze (PR #10) zmniejszyło to do jednego pytania plus pytań osobnych
dla zasobów z ostrzeżeniem, ale właściciel chce innego modelu: zgoda jest udzielana raz, przy
imporcie, a `cwm start` pyta dopiero, gdy coś się zmieniło.

## Decyzje właściciela (2026-11-14)

1. Zasoby są grupowane w **pakiety**.
2. Potwierdzenie `cwm import` na terminalu zatwierdza też pakiety.
3. `cwm start` nie pyta o zasoby, których zaufany skrót pakietu nadal pasuje. Gdy pakiet się zmienił,
   pyta **raz na pakiet**, z listą zmian (dodane, usunięte, zmienione z polami było/jest).
4. Skille z hookami wchodzą do pakietów; ich hooki i piny skryptów są w całości na ekranie importu.
5. Zasoby poza pakietami (firma, projekt, MCP, pluginy, dodane ręcznie) zatwierdzane są jak dotąd,
   razem ze zbiorczym pytaniem z PR #10.

## Decyzja: co wchodzi do zaufanego skrótu pakietu

Wymóg bezpieczeństwa: skrót zapisany przy imporcie musi obejmować wszystko, co wpływa na wykonanie i
trafia później do profilu. Dziś skrót zatwierdzenia jest liczony w `buildRuntimePlan` **per firma** i
zawiera rzeczy zależne od profilu: odwołania przepisane na ścieżkę profilu firmy i piny bajtów, które
plan sam zapisze. Przy imporcie nie ma firmy ani profilu, więc taki skrót nie dałby się policzyć, a
zgoda zapisana przy imporcie nie mogłaby go potem rozpoznać.

Rozbiór pól (kolumna „W skrócie pakietu” mówi, czy pole jest zapisane przy imporcie i porównywane przy starcie):

| Pole zatwierdzenia | Zależy od firmy lub profilu? | W skrócie pakietu | Uzasadnienie |
|---|---|---|---|
| definicja zasobu (`source`, `nativeDir`, `root`, `path`, zależności, flagi) | nie, to manifest z rejestru | tak, jako `def` (sha256 kanonicznego JSON), dla każdego członka, także bez pól wykonawczych (zmiana `root` albo `path` zasobu `Files` przenosi pliki w profilu) | zmiana `source` albo `nativeDir` zmienia, który plik i które odwołania trafią do profilu |
| treść drzewa zasobu | nie, to bajty z rejestru | tak, jako `tree` (ten sam `treeSha256` co w planie, ale z bajtów sprzed przepisywania) | pokrywa każdy plik, który zostanie skopiowany do profilu, w tym skrypty i pliki oznaczone przy imporcie jako możliwy sekret |
| `allowed-tools`, `tools`, `model`, wstawki `!`, hooki skilla | nie, wyprowadzone z treści | tak, w polu `exec` | to pola, które ekran zatwierdzania pokazuje w całości |
| pola `Settings` (`hooks`, `permissions`, `env`, `enforce`, `attribution`, `preferences`) | nie, to manifest | tak, w `exec` | te same pola, co dziś |
| piny skryptów hooków poza profilem (ścieżka, sha256 z dysku, powód braku pinu) | nie zależy od firmy, zależy od hosta | tak, w `exec.pins` | skrypt poza rejestrem nie jest kopiowany; zmiana jego treści musi pytać (ADR 0042) |
| `sourceSha256` planowanych bajtów (po przepisaniu odwołań i odtworzeniu frontmattera) | tak, bo zawiera ścieżkę profilu firmy | nie | jest funkcją treści i ścieżki profilu, więc pokrywa go `tree`; porównanie z planem jest kontrolą spójności (niżej) |
| treść pól po przepisaniu odwołań (np. wstawka `!` ze ścieżką do `~/.claude/...`) | tak, ścieżka profilu | tak, ale z **znacznikiem profilu** (`/cwm-pack-profile`) zamiast ścieżki firmy | ten sam kod przepisuje odwołania przy imporcie (na znacznik) i przy starcie (na profil); wyprowadzenie z rejestru ma dać to samo co plan, po zamianie ścieżki |
| piny skryptów hooków, które leżą w profilu (przepisane `~/.claude/...`) | tak: zależą od tego, które zasoby firma włączyła i od zapisanych bajtów | jako **powiązanie** `{rel, właściciel, skrót drzewa właściciela}` w `fields.bindings` | patrz niżej: powiązanie zapisane przy zgodzie musi zgadzać się z planem |
| klucz i firma w dokumencie zatwierdzenia | tak | nie | zgoda pakietu jest globalna (patrz „Do potwierdzenia”); skrót członka nie zawiera nawet nazwy pakietu, więc zmiana nazwy pakietu jej nie unieważnia |
| `projectDir`, `commandPath`, skróty poleceń MCP | tak (projekt) | nie dotyczy | MCP i pluginy nie wchodzą do pakietów |
| ostrzeżenia planu | tak | nie | to wynik, nie wejście; ostrzeżenia z pól niezależnych są na ekranie importu |

Funkcja `deriveMember` (`src/infra/cwm/pack-derive.ts`) liczy pola niezależne z bajtów rejestru i jest
wywoływana w dwóch miejscach, z tym samym wejściem: przy imporcie z bajtów planu (i ponownie z plików
na dysku po zapisie) oraz w `buildRuntimePlan` z tych samych bajtów, które plan czyta do profilu.
Dzięki temu nie ma drugiego odczytu rejestru między zgodą a zapisem do profilu.

Skrót członka to `sha256("cwm-pack-member-v1\n" + canonicalJson({v, engine, key, fields}))`, gdzie
`fields = {def, tree, files, filesMore, exec}`. Lista `files` (do 40 ścieżek ze skrótami 16-znakowymi)
służy tylko do pokazania, który plik się zmienił; o zaufaniu decyduje pełny `tree`. Zasób bez pól
wykonawczych ma `def: null` i `exec: null`, więc zmiana samego jego opisu nie pyta.

### Kiedy nie wolno zatwierdzać automatycznie

Zgoda pakietu obejmuje zasób tylko wtedy, gdy spełnione są wszystkie warunki. W przeciwnym razie
zasób wraca na ekran pytania (jedno pytanie na pakiet):

1. **Skrót członka zgadza się z zapisanym.** Brak wpisu to „dodany”, inny skrót to „zmieniony” (z
   różnicą pól `def`, `tree`, `files`, `exec`). Ręczna edycja plików w rejestrze zmienia `tree`, więc
   zawsze pyta; nigdy nie ma cichej zgody.
2. **Wyprowadzenie zgadza się z planem.** Pola treści policzone przez plan po przepisaniu odwołań na
   prawdziwy profil, po zamianie ścieżki profilu na znacznik, muszą być równe polom wyprowadzonym z
   rejestru. Różnica to blokada: pole nie da się wyprowadzić deterministycznie.
3. **Skrypty hooków z profilu mają powiązanego właściciela z tego samego pakietu.** Hook skilla po
   przepisaniu odwołań często wskazuje plik z profilu (np. `~/.claude/skills/helper/run.sh`). Który
   zasób go zapisze, zależy od zestawu zasobów, więc plik nie może zostać zatwierdzony „kto
   pierwszy, ten lepszy”. Skrypt z drzewa samego zasobu pokrywa `tree`. Skrypt dostarczany przez
   inny zasób wchodzi do pól jako powiązanie `{rel, owner, ownerTree}`: przy imporcie z planu
   importu (właściciel z tego samego importu), a gdy plan go nie zna, jako `owner: null`
   („właściciel ustalany przy starcie” na ekranie importu). Przy starcie plan liczy powiązania ze
   swojego zestawu plików; inny właściciel albo inne drzewo właściciela to zmiana pola i pytanie o
   pakiet z różnicą. Dodatkowo właściciel musi być członkiem **tego samego pakietu** o zgodnym
   zaufanym skrócie; właściciel z innego pakietu, spoza pakietów (plugin, zasób firmy) albo bez
   właściciela w planie to blokada. Dzięki temu zasób dołączony później (np. `Files` z innej
   firmy), który zaczyna dostarczać skrypt, nigdy nie jest cicho akceptowany.
4. **Polecenie hooka nie zawiera wprost ścieżki profilu firmy.** Taka ścieżka zależy od firmy, a pin
   z dysku mógłby być starszy niż bajty, które plan zapisze. To blokada.
5. **Plik zaufanego skrótu jest poprawny** (zwykły plik, właściciel, brak zapisu dla grupy, walidator,
   skrót członka równy skrótowi z jego pól). Uszkodzony plik przerywa start, nic z pakietu nie jest zatwierdzone.

**Blokada nie jest odmową.** Zasób z blokadą jest pokazany w pytaniu pakietu z powodem, a zgoda jest
zapisywana jak zwykłe zatwierdzenie firmy (`~/.cwm/approvals/<firma>.yaml`), nie w zaufanym skrócie
pakietu. Kolejny start tej firmy nie pyta, dopóki jego skrót się nie zmieni.

Zgoda per firma (`approvals/<firma>.yaml`) ma pierwszeństwo: zasób, który ma pasujący wpis firmy,
jest zatwierdzony niezależnie od pakietu.

## Miejsce i format

- Definicja pakietu: `~/.cwm/packs/<przestrzeń>/<nazwa>.yaml` (`kind: Pack`, `spec.members` jako
  `rodzaj:id`). To dane do edycji i do przeglądu. Pakiet ma przestrzeń nazw zasobów: `global/<nazwa>`
  dla zasobów `global/*`, `<firma>/<nazwa>` dla zasobów firmy. Zasób należy najwyżej do jednego pakietu;
  zasób zadeklarowany w dwóch pakietach zostaje bez pakietu (z ostrzeżeniem), czyli wraca do zwykłego
  zatwierdzania. Katalog `packs/` leży poza `registry/` i `companies/`, więc skaner rejestru go nie widzi
  i nie trzeba zmieniać `cwm init` (powstaje przy pierwszym zapisie).
  Alternatywy odrzucone: sekcja w `config.yaml` (miesza dane użytkownika z danymi, które zapisuje
  tylko CWM, i rosłaby z każdym importem) oraz plik pakietu obok zasobów w rejestrze (trzeba by
  uczyć skaner rejestru nowego rodzaju katalogu i rozdzielać pakiety firm).
- Zaufane skróty: `~/.cwm/approvals/packs/<przestrzeń>/<nazwa>.json`. Pliki leżą w katalogu zatwierdzeń,
  ale w podkatalogu, więc lista firm z `approvals/*.yaml` ich nie widzi. Tryby i sprawdzenia są takie jak
  przy zatwierdzeniach firm (0600, właściciel, brak zapisu dla grupy, odczyt przez `readTextWithin`,
  zapis atomowy w `homeScope`). **Format to JSON, nie YAML**: parser manifestów ma limit 256 tys.
  jednostek, a pakiet z kilkudziesięcioma skillami z listami plików i polami wykonawczymi może go
  przekroczyć. Plik jest zapisywany tylko przez CWM.
- Blokada: zapis zaufanych skrótów idzie pod mutexem `runtime/global` (ten sam mutex co dla firm).
  `global` jest zarezerwowaną przestrzenią nazw i nie może być id firmy, więc nie koliduje z żadną firmą.
  Każdy plik jest scalany pod blokadą: wpisy o tych samych kluczach są zastępowane, reszta zostaje.

## Grupowanie przy imporcie

W kolejności (zasób, który już jest w pakiecie, zostaje w swoim):

1. Import do firmy: jeden pakiet o nazwie firmy (`<firma>/<firma>`).
2. Import globalny: wspólny **katalog źródłowy po realpath** dla skilli, agentów i komend, gdy nie jest
   to natywny katalog rodzaju (`<from>/skills`): np. skille gstack dowiązane z jednego repozytorium dają
   pakiet z nazwą tego katalogu (co najmniej dwa zasoby).
3. Wspólny **przedrostek nazwy** (pierwszy segment przed `-`, co najmniej 3 znaki, co najmniej dwa
   zasoby; `Files` bez przedrostka `skills-` i `agents-`): `antislop` i `antislop-ui` to pakiet `antislop`.
   Zasób dołącza też do pakietu o nazwie równej jego przedrostkowi, jeśli taki już powstał z kroku 2.
4. Reszta według rodzaju: `skills`, `agents`, `commands`, `files`, `settings`.

Pakiet nie przekracza 400 członków (dalsze trafiają do `<nazwa>-2` i tak dalej). Nazwę można zmienić
(`cwm pack rename`), zasób przenieść (`cwm pack move`; zgoda nie przechodzi razem z zasobem).

## Zgoda przy imporcie

Ekran importu pokazuje po tabeli planu sekcję „Pakiety”: dla każdego pakietu członków z polami
wykonawczymi z polami **w całości** (`allowed-tools`, wstawki `!`, hooki, piny skryptów z sha256 albo
powodem braku pinu, ostrzeżenia), reszta jako liczba. Potwierdzenie „Zapisać N zasobów i zatwierdzić M
pakietów” zapisuje zasoby, definicje pakietów i zaufane skróty. Po zapisie każdy członek jest
wyprowadzany jeszcze raz z plików na dysku i musi dać ten sam skrót co plan, który zatwierdził
użytkownik; inaczej nie dostaje zgody (zapis się nie udał albo plik zmieniono po planie).
Bez terminala nic się nie zapisuje (ani zasoby, ani zgody, ani definicje pakietów), a import z oczekującymi
zasobami albo pakietami kończy się kodem `1` (`ok: false` w `--json`); `--dry-run` pokazuje to samo, co ekran.
Zasób, w którego tekście jest zarezerwowany znacznik profilu (`/cwm-pack-profile`), nie jest objęty zgodą pakietu.

**Migracja.** Ponowny `cwm import` tego samego, niezmienionego źródła ma status `bez zmian`, ale gdy
pakiety albo ich zgody jeszcze nie istnieją, pyta „Utworzyć i zatwierdzić M pakietów? Zasoby w rejestrze
zostają bez zmian” i zapisuje wyłącznie definicje i zaufane skróty (bez kopiowania zasobów). Nie ma
osobnego polecenia: ścieżka bez ręcznej edycji YAML to ten sam import.

## `cwm start`

Wyniki oceny (`evaluatePackMembers`, czysta funkcja w rdzeniu) mają trzy stany: zasób objęty zgodą
pakietu (zatwierdzony bez pytania, powód „pakiet X zatwierdzony <data>” w `--dry-run`), oczekujący
(nowy albo zmieniony, z różnicą pól) i zablokowany. Oczekujące zasoby są grupowane po pakiecie, a dla
każdego pakietu jest jedno pytanie z listą zmian i listą członków usuniętych z rejestru. Zgody są
zapisywane na końcu, po wszystkich pytaniach, więc odmowa w dowolnym miejscu nic nie zapisuje.
Do zaufanych skrótów trafiają tylko zasoby pokazane w pytaniu i właściciele skryptów bez pól wykonawczych z ich listy zmian (właściciel z polami ma własne pytanie w swoim pakiecie):
niezauważona zmiana zasobu bez pól wykonawczych nie jest cicho odnawiana (inaczej zasób, od którego
zależy hook z innej firmy, dostałby zgodę bez pytania).

## Odwołanie

`cwm approvals revoke pack:<id>` usuwa zaufane skróty pakietu i unieważnia wygenerowane profile wszystkich
firm (zgoda pakietu jest wspólna). `revoke --all` odwołuje też wszystkie pakiety; `--company` ich nie
dotyczy. `revoke <klucz zasobu>` (bez `--company`) usuwa też zaufany wpis tego zasobu ze wszystkich pakietów i
unieważnia profile; z `--company` albo `revoke --company <id>` CWM ostrzega, które zasoby nadal objęte
są zgodą pakietów. `approvals list` wypisuje pakiety z kluczem `pack:<id>`. Odwołanie pakietu nie
usuwa zgód firm na te same zasoby (`skill:...` w `approvals/<firma>.yaml`), bo są osobne. `pack move`
usuwa wpis zasobu ze starego pakietu (pod mutexem), a zgoda nie przechodzi do nowego.

## Do potwierdzenia przez właściciela

1. **Zgoda pakietu jest wspólna dla firm (ryzyko zaakceptowane przez właściciela).** Obowiązuje we
   wszystkich obecnych i przyszłych firmach; hooki i narzędzia zatwierdzonego skilla działają ze
   zmiennymi `envRef` tej firmy, w której uruchomiono sesję. Włączenie zasobu globalnego w nowej firmie
   niczego nie pyta, jeśli jego treść i pola wykonawcze się nie zmieniły. Alternatywa: zgoda per para
   (pakiet, firma).
2. **Zasoby bez pól wykonawczych nie pytają.** Zmiana treści `SKILL.md` bez `allowed-tools`, hooków i
   wstawek `!` nie wywołuje pytania (jak dziś). Wyjątkiem jest zasób, z którego pochodzi skrypt hooka
   innego członka pakietu.
3. **Pytanie pakietu pokazuje zasoby z blokadą razem z pozostałymi**, ale ich zgoda ląduje w
   zatwierdzeniach firmy, nie w pakiecie.

## Ryzyko szczątkowe

- Pin obejmuje pliki wskazane w poleceniu hooka, nie ich zależności (ADR 0042). Skrypty wywoływane
  przez zmienną (`${CLAUDE_SKILL_DIR}/...`, `$HOME/...` rozwijane w czasie działania) są oznaczone jako
  nieprzypięte i widoczne na ekranie importu z ostrzeżeniem.
- Wstawki `!` nie są pinowane (jak dotąd): zatwierdzona jest ich treść, a plik, który wywołują, jest
  częścią drzewa któregoś zasobu tylko wtedy, gdy leży w rejestrze.
- Proces tego samego użytkownika może zmienić pliki w `~/.cwm` (definicje pakietów, zaufane skróty):
  poza modelem, jak przy zatwierdzeniach firm. Skrót członka liczony z jego pól utrudnia tylko
  niespójną edycję.
- Zgoda pakietu jest wspólna dla wszystkich obecnych i przyszłych firm, a hook zatwierdzonego skilla widzi w swoim środowisku `envRef` każdej firmy, w której działa. Włączenie zasobu globalnego w nowej firmie niczego nie pyta przy niezmienionej treści (zaakceptowane przez właściciela).
- Skrypt hooka z profilu bez właściciela w tym samym pakiecie nie jest objęty zgodą pakietu (blokada, zgoda per firma); zmiana właściciela albo jego drzewa wywołuje pytanie. Zasób ze skryptem hooka z profilu, którego właścicielem jest zasób obowiązkowy (`mandatory`, trafia do
  pluginu CWM, nie do `claude/`), nie ma właściciela w profilu: blokada, czyli zgoda per firma.
- Wyprowadzenie zależy od katalogu domowego (przepisywanie odwołań do `~/.claude`): przy innym `HOME` niż
  przy imporcie pola mogą się różnić i pakiet zapyta ponownie. To kierunek bezpieczny.
- Zgoda pakietu nie ma HMAC (jak zatwierdzenia firm, ADR 0040).
