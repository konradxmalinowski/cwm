# ADR 0043: Pluginy z lokalnego marketplace'u

Status: zaakceptowane (decyzja właściciela z 2026-11-11: lokalny marketplace; szczegóły do potwierdzenia przy przeglądzie PR)
Data: 2026-11-13
Dotyczy: ADR 0037 (model zasobów), ADR 0040 (zatwierdzanie, `cwm start`), ADR 0042
Źródło: `src/core/cwm/{marketplace,manifest,validate-manifest,approval}.ts`, `src/infra/cwm/{marketplace,global-config,runtime-plan,engine-process}.ts`, `src/cli/commands/marketplace.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

`cwm start` obsługiwał tylko pluginy `source.type: local` (katalog w zasobie). Plugin z
`source.type: marketplace` kończył plan błędem, więc plugin firmowy, który żyje w lokalnym
marketplace'ie (katalog z `.claude-plugin/marketplace.json`), nie dawał się podpiąć. Pobieranie
z sieci (git, http, npm) jest poza zakresem: ten etap niczego nie ściąga.

## Decyzja

1. **Rejestracja globalna.** `~/.cwm/config.yaml` dostaje opcjonalne pole
   `marketplaces: { <nazwa>: { type: local, path: <ścieżka bezwzględna> } }`. Brak pola to brak
   marketplace'ów, więc stare pliki są nadal poprawne i `cwm init` go nie dopisuje. Nazwa to małe
   litery ASCII (wzorzec przestrzeni nazw id), ścieżka bezwzględna bez `.` i `..`, typ inny niż
   `local` to błąd walidacji z komunikatem. Nazwa rejestracji musi być równa `name` w
   `marketplace.json`.
2. **CLI `cwm marketplace add|list|remove|show`.** Zapis tylko przez writer `~/.cwm`, zmieniany
   jest wyłącznie klucz `marketplaces` (reszta pliku i komentarze zostają), a wynik przechodzi ten
   sam walidator co odczyt. `remove` odmawia, gdy zasób `Plugin` wskazuje na marketplace.
   `show <nazwa> <plugin>` wypisuje gotowy manifest zasobu.
3. **Bez `cwm plugin add`.** Zasób `Plugin` leży w rejestrze globalnym (`registry/plugins/<przestrzeń>/<nazwa>/`),
   nie w katalogu firmy (skan firmy nie obejmuje pluginów), a jego id musi mieć przestrzeń
   `marketplace` (obcej przestrzeni nie da się użyć bez importu), więc dwa marketplace'y z pluginami
   o tej samej nazwie kolidują w id. Włączenie wymaga edycji `company.yaml`, a żadne polecenie CWM
   nie edytuje manifestu firmy. Polecenie zapisujące rejestr globalny i `company.yaml` nie pasuje
   do istniejących wzorców zapisu, więc manifest pozostaje ręczny (`docs/CLI.md`), a `show` daje
   gotowy tekst. Do osobnej decyzji właściciela.
4. **Rozwiązanie przy `cwm start` i `--dry-run`.** `buildRuntimePlan`, `case 'plugin'`:
   - marketplace musi być zarejestrowany; katalog po `realpath` należy do bieżącego użytkownika, nie
     jest zapisywalny dla grupy i innych, a jego katalog nadrzędny ma właściciela root albo
     użytkownika i nie jest zapisywalny dla grupy i innych (wspólna funkcja `parentRejection` z
     kontroli binarki silnika). To samo dla `.claude-plugin/`, `marketplace.json` (zwykły plik, nie
     dowiązanie) i każdego składnika ścieżki do pluginu;
   - `marketplace.json`: odczyt `readTextWithin` z limitem 512 KiB przed dekodowaniem, UTF-8,
     bez zabronionych kluczy, ostra walidacja (nieznane pole korzenia, `metadata.pluginRoot` to błąd);
   - wpis po nazwie, porównanie `foldName`; nazwa spoza ASCII albo kolidująca z innym wpisem po
     zwinięciu wielkości liter i Unicode (`ＡＢＣ` i `abc`) to odmowa obu wpisów;
   - `source` musi być tekstem `./a/b`: bez `..`, ścieżki bezwzględnej, segmentów ukrytych, `\`,
     `%`, nazw urządzeń Windows (wspólna kontrola `Checker.relativePath`) i bez samego korzenia.
     Źródła obiektowe (`github`, `url`, `git`, `npm`) są odrzucane z powodem. Wpis z `hooks`,
     `mcpServers`, `lspServers`, `commands`, `agents`, `skills`, `outputStyles`, `strict: false` albo
     nieznanymi polami jest nieużywalny: silnik ładuje plugin z `--plugin-dir` i czyta `plugin.json`,
     więc deklaracje we wpisie nie zadziałałyby, a użytkownik myślałby, że są;
   - katalog pluginu: każdy składnik to zwykły katalog (`lstat`, dowiązanie nawet w obrębie
     marketplace'u to odmowa), do tego `realInside` względem korzenia.
5. **Dalej ta sama droga co `local`:** `readTree`, migawka `plugins/<slug>@<skrót>`,
   `extractPluginExecutables`, odroczone piny (`pendingPins`), zatwierdzenie.
6. **Pola zatwierdzenia.** Dla pluginu z marketplace'u dochodzi blok `marketplace`: nazwa
   marketplace'u, nazwa wpisu, tekst `source`, katalog marketplace'u i rozwiązana ścieżka pluginu
   po `realpath`. Blok jest dodawany tylko dla `marketplace`, więc skróty pluginów `local` nie
   zmieniają się (zabezpiecza to test w `tests/unit/cwm-approval-hash.test.ts`). Do skrótu nie
   wchodzi skrót całego `marketplace.json`: dopisanie innego pluginu do katalogu nie powinno pytać
   o ten, a to, co wpis zmienia dla tego pluginu (`source`), jest w ścieżce i w drzewie.
7. **`headersHelper`.** Potwierdzone: `.mcp.json` pluginu jest skanowany przez
   `extractPluginExecutables`, `headersHelper` trafia do `pluginExec.mcpServers` i przez
   `executionFields` do skrótu (oraz do ekranu zatwierdzania); zmiana helpera zmienia skrót.
   Dodano przypadek do `tests/unit/cwm-approval-hash.test.ts`.
8. **Wersje.** `version` z `plugin.json` albo wpisu różna od `version` zasobu to ostrzeżenie,
   nie błąd.

9. **Wyjście z migawki (dotyczy też `local`).** Polecenie hooka, `command`, `args`, `headersHelper`
   i `cwd` serwera MCP/LSP z `CLAUDE_PLUGIN_ROOT` i segmentem `..` (także `%2e%2e`, `\`) to błąd
   skanu, ta sama reguła co `resolveRef`. Wcześniej `exclude` pomijało każdy token z
   `CLAUDE_PLUGIN_ROOT`, więc `${CLAUDE_PLUGIN_ROOT}/../../x.sh` nie był pinowany. Teraz pomijane
   są tylko tokeny `${CLAUDE_PLUGIN_ROOT}/...` bez `..`.
10. **Piny serwerów.** Ścieżki bezwzględne i `~` w `command`, `args` i `headersHelper` serwerów
    MCP/LSP są pinowane tym samym `pinHookCommands` (ścieżki wyliczane ze zmiennych nie). Zmienia to
    skrót tylko pluginów, które mają takie ścieżki.
11. **Ścieżka `source`.** Do 1000 znaków, segment do 255 bajtów, bez znaków sterujących i
    formatujących (nowa linia, bidi). Błąd odczytu ścieżki jest powodem wpisu, nie przerwaniem
    polecenia. Teksty z pliku są w wyniku `cwm marketplace` escapowane.
12. **Twarde dowiązania.** `readTree` dla drzew pluginów (`local` i `marketplace`) odrzuca plik z
    `nlink > 1`; drzewa skilli i `Files` bez zmian.

## TOCTOU

Plan trzyma bajty w pamięci: `marketplace.json` jest czytany i parsowany raz, drzewo pluginu
czytane raz, a zatwierdzenie i migawka dotyczą tych samych bajtów (jak dla `local`). Okno między
sprawdzeniem ścieżki a `readTree` wymaga prawa zapisu w katalogach, których kontrola właściciela i
uprawnień nie pozwala innym zapisywać; dodatkowo po odczycie `start` sprawdza, że katalog pluginu
nadal rozwiązuje się do tej samej ścieżki. Pliki odczytywane są z `O_NOFOLLOW`.

## Ryzyko szczątkowe

- Użytkownik z prawem zapisu w katalogu marketplace'u (ten sam użytkownik, root) może go zmienić;
  zmiana pliku pluginu albo ścieżki pyta ponownie przy następnym starcie, ale nie w trakcie sesji.
- Skrypt wskazany w `headersHelper` albo w `command` serwera MCP pluginu spoza drzewa pluginu
  (ścieżka bezwzględna, `~`) nie jest przypinany skrótem; zatwierdzający widzi pełne polecenie.
  Ścieżki pod `${CLAUDE_PLUGIN_ROOT}` są w drzewie, więc obejmuje je lista plików.
- Sprawdzany jest tylko bezpośredni katalog nadrzędny katalogu marketplace'u, nie cały łańcuch
  przodków; zapisywalny przodek wyżej mógłby podmienić cały katalog.
- Kontrola właściciela i uprawnień nie działa na Windowsie (brak uid); `cwm start` tam odmawia.
- Dwa równoległe `cwm marketplace add` mogą sobie nadpisać zmianę w `config.yaml` (bez blokady).
- `cwm marketplace show` ocenia wpisy jak `cwm start`, ale w chwili wywołania; wynik może się
  zmienić między `show` a startem.
