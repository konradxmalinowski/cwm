# ADR 0050: workflow `orchestrated` jako skompilowana komenda

Status: zaakceptowane w zakresie planu (2026-11-16)
Data: 2026-11-16
Dotyczy: ADR 0037 (zasób `Workflow`, kroki, resolver), ADR 0040 (zatwierdzanie, profil), ADR 0049 (`cwm run`, workflow `instructional`, SEC-01 do SEC-05)
Źródło: plan `plans/2026-11-16-cwm-orchestrated.md` (lokalny, poza repozytorium); kod w `src/core/cwm/orchestration.ts`, `src/core/cwm/validate-resource.ts`, `src/infra/cwm/runtime-plan.ts`, `src/infra/cwm/workflow-registry.ts`, `src/cli/commands/run.ts`, `src/cli/commands/workflow.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

ADR 0049 zostawił workflow `orchestrated` bez wykonania: `cwm run` odmawiał go komunikatem „nieobsługiwany”.
Decyzja właściciela (2026-11-16): `orchestrated` jest kompilowany do jednej komendy `cwm-<nazwa>`, tak jak
`instructional`. Komenda prowadzi jedną interaktywną sesję przez kroki w ustalonej kolejności, a każdy krok
deleguje do swojego agenta narzędziem subagentów silnika. CWM nie uruchamia osobnych procesów na krok i nie
wprowadza modelu procesów: cała orkiestracja to treść komendy, którą wykonuje silnik.

## Decyzje

1. **Krok ma opcjonalne `task`.** `WorkflowStep` dostaje `task?: string` (manifest: `spec.steps[].task`). To jedna
   linia do 1000 znaków, bez nowych linii, tabulatorów, znaków sterujących i formatujących (`validateStepTask`).
   Jedna linia znaczy, że `task` nie może udawać nagłówka, kolejnego kroku ani otworzyć frontmattera. Zależności
   (istniejące kroki, brak cyklu) walidowane jak dotąd; agent kroku jest zależnością workflow, więc resolver
   odrzuca agenta nieistniejącego, wyłączonego albo zabronionego, zanim powstanie plan.
2. **Kolejność jest czystą funkcją** (`orderSteps`, `src/core/cwm/orchestration.ts`): porządek topologiczny
   warstwami. Etap n to kroki, których zależności leżą w całości w etapach wcześniejszych; w obrębie etapu
   obowiązuje kolejność z deklaracji. Kroki jednego etapu nie zależą od siebie, więc komenda oznacza je jako
   możliwe równoległe. Cykl i nieznany krok to błąd (walidator łapie je wcześniej, funkcja zostaje samodzielna).
3. **Treść komendy** składa `composeOrchestration`: treść `source` (frontmatter i `$ARGUMENTS` jak w komendzie),
   potem sekcja kroków, na samym końcu wiersz `Task: $ARGUMENTS`, ale tylko gdy sam `source` nie ma placeholdera.
   Sekcja zawiera stałą instrukcję po angielsku (wykonuj etapy po kolei, krok deleguj do wskazanego agenta, przekaż mu
   zadanie i wyniki kroków, od których zależy, przy błędzie przerwij, zakończ podsumowaniem), a dla każdego kroku:
   numer etapu, id, agenta, zależności i polecenie (`none, use the overall task`, gdy brak `task`). Stała część nie
   zawiera odwrotnych apostrofów, `!` ani `$`, więc nic z niej nie tworzy wstawki ani placeholdera.
4. **Nazwa agenta jest taka, jaką widzi silnik.** Plan zapamiętuje przy generowaniu agentów, jaką nazwę dostał
   każdy: `name` z frontmattera zapisanego do profilu, a bez niego nazwa pliku (część id po `/`). Agent zasobu
   obowiązkowego leży w pluginie CWM firmy, więc jego nazwa to `cwm-<firma>:<nazwa>`; pozostali są w profilu bez
   przedrostka. Ponieważ nazwy znane są dopiero po przejściu całej listy zasobów, workflow `orchestrated` jest
   planowany po pętli zasobów (`planWorkflow` w `runtime-plan.ts` obsługuje oba typy tym samym kodem). Nazwa,
   która nie pasuje do `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (frontmatter agenta to dowolny tekst), jest błędem
   planu z nazwą kroku, bo trafiałaby do treści komendy. Nazwa
   z dwukropkiem (zlewałaby się z przedrostkiem pluginu, np. agent profilu `cwm-acme:reviewer` i obowiązkowy `reviewer`
   firmy `acme`), nazwa równa wbudowanemu typowi subagenta silnika (`general-purpose`, `Explore`, `Plan`,
   `statusline-setup`, `claude-code-guide`) i nazwa, pod którą w planie występują dwaj różni agenci, to błędy
   planu z nazwą kroku (SEC-ORCH-01). Brak agenta w profilu to błąd planu z nazwą kroku
   (zabezpieczenie na wypadek, gdyby plan dostał konfigurację z pominięciem resolvera).
5. **Zatwierdzenie jak komenda.** Treść idzie przez `parseContent('command')`, więc `allowed-tools` w `source` i
   wstawki `!` (także w `task`) wymuszają zatwierdzenie z pełną treścią wstawek, a skrót wygenerowanej treści
   (`source.sha256`) wchodzi do pól zatwierdzenia (`EXECUTION_RELEVANT_FIELDS.workflow` bez zmian). Zmiana kroku,
   agenta albo `task` zmienia treść, więc workflow, który już wymaga zatwierdzenia, pyta ponownie. Workflow bez
   tych cech nie wymaga zatwierdzenia, tak samo jak zwykła komenda i `instructional`: sama delegacja do agenta
   nie jest polem wykonawczym, a agent ma własne zatwierdzenie, jeśli ma `tools` albo wstawki.
6. **Własności bezpieczeństwa z ADR 0049 zostają.** Zadanie dalej idzie jednym argumentem silnika (`/<polecenie>
   <zadanie>`, przed nim `--`). Placeholdery liczą się wzorcami silnika (`usesTaskPlaceholder`, bez granic słów).
   `task` kroku nie zmienia sposobu doklejenia zadania (SEC-01):
   - wiersz `Task: $ARGUMENTS` jest doklejany wyłącznie na podstawie samego `source`; `$ARGUMENTS` w `task` go
     nie wyłącza i nie dubluje;
   - wiersz stoi **na końcu** treści, po sekcji kroków. Wstawka zaczęta w `source` albo w `task` bez domknięcia
     nie ma za doklejonym wierszem żadnego odwrotnego apostrofu, więc nie może objąć placeholdera;
   - sprawdzenie powłoki (`taskReachesShell`) działa na `source` i sekcji razem, bez doklejonego wiersza: placeholder
     w którymkolwiek `task` (albo w `source`) plus dowolny znacznik wstawki w całym tekście to błąd planu i odmowa
     `cwm workflow add`. Jest to celowo to samo, konserwatywne kryterium co dla `instructional`, więc `source` z
     wstawką `!` nie zniesie kroku z `$ARGUMENTS` w `task`;
   - tekst przed doklejonym wierszem zadania nie może mieć niedomkniętej wstawki (blok ```! albo ~~~! bez
     zamknięcia, `!` z odwrotnym apostrofem bez zamknięcia): to błąd planu i odmowa `cwm workflow add`. Silnik, który
     uznałby otwartą wstawkę za ciągnącą się do końca tekstu, nie obejmie wiersza zadania (SEC-ORCH-03);
   - `task` jest jedną linią (pkt 1) i nie przechodzi przez żaden własny parser: wstawka w nim jest wykrywana
     wzorcami silnika (`extractInlineCommands`) na całej treści, więc nie da się jej ukryć ani wstrzyknąć bez
     zatwierdzenia.
7. **`cwm run`** przestaje odmawiać `orchestrated`. Wybór, routing, shadowing (SEC-04, SEC-05), argv i limity
   bez zmian. Podsumowanie (i `--dry-run`, `--explain`) wypisuje etapy z krokami, nazwami agentów i zależnościami;
   `--json` dodaje `workflow.type` i `workflow.stages[]` (`index`, `steps[]` z `id`, `agent`, `dependsOn`, `task`).
8. **`cwm workflow add --type orchestrated`** przyjmuje `--step <id>=<agent>` (powtarzalne, kolejność deklaracji
   wyznacza kolejność w etapie), `--after <id>=<dep1>,<dep2>` i `--step-task <id>=<tekst>`; `--from` albo
   `--from-command` nadal podaje treść wstępną. Agent musi istnieć w rejestrze (inaczej odmowa z nazwą kroku),
   a treść przechodzi te same kontrole co plan (`parseContent`, powłoka, cechy do zatwierdzenia). Opcje kroków z
   typem `instructional` i `orchestrated` bez kroków to błąd użycia (kod 2). `cwm workflow show` pokazuje etapy.

## Konsekwencje i ryzyko szczątkowe

- **CWM nie gwarantuje wykonania.** To model w silniku czyta instrukcję i wywołuje subagentów; kolejność etapów,
  równoległość i przekazanie wyników to prośba w treści komendy, nie mechanizm. Zła delegacja albo pominięty krok
  jest możliwy. Dowodem poprawności CWM jest wygenerowana treść i nazwy agentów, nie przebieg sesji.
- Delegowanie wymaga w silniku narzędzia subagentów. Generator nie dopisuje `allowed-tools` do komendy: jeśli
  firma ogranicza narzędzia, autor `source` ma je podać, a wtedy workflow podlega zatwierdzeniu (pkt 5).
- Zmiana nazwy agenta (`name` we frontmatterze) albo przesunięcie zasobu między profilem a pluginem zmienia treść
  komendy i jej skrót, więc podlega `cwm diff` i, gdy workflow wymaga zatwierdzenia, ponownej zgodzie.
- Błąd „agent nieaktywny” zwykle zgłasza resolver (`zależy od agent:<id>, który jest wyłączony`) bez nazwy kroku;
  wariant z nazwą kroku z planu jest drugą linią obrony.
- Sekcja kroków i `task` są tekstem dla modelu: autor workflow z zatwierdzenia firmy odpowiada za jego treść (jak za
  treść komendy). Jednowierszowość `task` ogranicza wstrzyknięcie struktury, nie jej sens.
- Workflow `orchestrated` zajmuje tę samą przestrzeń nazw poleceń `cwm-<nazwa>` co `instructional`; kolizje to błąd planu.
- Argumenty silnika w `cwm run` (np. `--model`) nadal nie są przyjmowane (ADR 0049).
