# ADR 0049: `cwm run` (wybór workflow z opisu zadania) i `cwm workflow`

Status: zaakceptowane w zakresie planu (2026-11-15)
Data: 2026-11-15
Dotyczy: ADR 0037 (zasób `Workflow`, resolver), ADR 0040 (zatwierdzanie, profil, `cwm start`), ADR 0044 (pakiety), ADR 0046 (zapis do rejestru i list), ADR 0047 (`prepareRun`)
Źródło: plan `plans/2026-11-15-cwm-run.md` (lokalny, poza repozytorium); kod w `src/core/cwm/routing.ts`, `src/cli/commands/run.ts`, `src/cli/commands/workflow.ts`, `src/infra/cwm/workflow-registry.ts`, `src/infra/cwm/runtime-plan.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

Zasób `Workflow` istnieje od ADR 0037 razem z regułami `routing` (`mode`, `priority`, `examples`,
`keywords`), ale `cwm start` pomijał go z notatką „workflow nie jest generowany”. Użytkownik, który
ma kilka powtarzalnych procedur (migracja schematu, naprawa błędu, notatki do wydania), musiał sam
pamiętać, którą komendę wpisać. Decyzja właściciela: `cwm run "<zadanie>"` dobiera workflow z reguł
routingu i uruchamia start z tym workflow jako pierwszym poleceniem sesji, pokazując wybór i powód.

## Decyzje

1. **Routing jest czystą funkcją w `src/core/cwm/routing.ts`.** Bez modelu językowego, sieci i
   losowości: wynik zależy tylko od tekstu zadania i reguł workflow. Teksty są sprowadzane przez
   `foldName` (NFKC, małe litery, bez znaków łączących) oraz zwinięcie liter bez rozkładu (`ł`, `ø`,
   `ß`), potem dzielone na słowa po znakach spoza `\p{L}\p{N}`.
2. **Wzór wyniku** (stałe w `routing.ts`):
   - słowo kluczowe: **4 pkt**, fraza wielowyrazowa dodatkowo **+2 pkt za każde kolejne słowo**;
     trafienie to spójny podciąg słów zadania (granice słów wynikają z tokenów), każde słowo
     kluczowe liczy się raz;
   - przykład (`routing.examples`): bierzemy najlepszy. Słowa przykładu po odrzuceniu krótszych niż 3
     znaki i pospolitych (krótka lista angielskich i polskich); `punkty = 6 * (wspólne / słowa
     przykładu) * min(1, wspólne / 2)`. Jedno wspólne słowo liczy się za pół, więc samo „test” nie
     wybiera workflow;
   - `priority` (0 do 1000): `+2 * min(priority, 100) / 100`, tylko gdy jest jakiekolwiek trafienie.
     Sam priorytet nigdy nie wybiera workflow;
   - wynik = słowa + przykład + priorytet, zaokrąglony do 0,01.
3. **Progi.** `MIN_ROUTING_SCORE = 4`: jedno słowo kluczowe wystarcza, pojedyncze wspólne słowo
   przykładu nie. `ROUTING_MARGIN = 1`: lider jest wyraźny, gdy ma co najmniej 1 pkt przewagi nad
   drugim; mniejsza przewaga to remis. Przy tych stałych `priority` 50 lub więcej rozstrzyga dwa
   trafienia o równej treści, a niższy tylko przesuwa wynik.
4. **Wybór.** Tylko workflow z `routing` i `mode` innym niż `manual` biorą udział w automacie
   (`manual` i brak `routing` dają „ręczny”: wynik 0, dostępny przez `--workflow` i jako domyślny).
   Kolejność wyników: automatyczne przed ręcznymi, potem wynik, `priority`, id. Przy remisie albo
   braku trafienia na terminalu pojawia się lista do wyboru (do 10 pozycji, posortowana), a bez
   terminala albo z `--dry-run` polecenie kończy się kodem 1 z listą i podpowiedzią `--workflow`.
5. **Workflow domyślny** (`project.yaml`: `spec.workflows.default`, `company.yaml`: `workflows.default`;
   oba pola opcjonalne, projekt przesłania firmę). Wygrywa tylko tam, gdzie nie ma wyraźnego trafienia:
   gdy żaden wynik nie osiąga progu, albo gdy jest w grupie remisowej (wtedy jest rozstrzygającym
   głosem). Wyraźnego lidera nie przebija nigdy. Domyślny spoza aktywnych workflow jest pomijany z
   ostrzeżeniem (nie blokuje, gdy opis ma wyraźne trafienie).
6. **Uruchomienie to ten sam start.** `prepareRun` i reszta `startCommand` zostały rozdzielone na
   `prepareRun` i `launchPrepared` (`start.ts`); `cwm run` woła obie, więc zatwierdzenia, izolacja,
   blokady sesji, zapis profilu i `buildEngineArgv` są tym samym kodem co w `cwm start`. Wybór
   workflow wymaga `effective` z resolvera, dlatego `prepareRun` zwraca je razem z planem.
7. **Workflow `instructional` to komenda profilu.** Plan (`runtime-plan.ts`) zapisuje treść `source`
   jako `claude/commands/cwm-<nazwa>.md` (`<nazwa>` to część id po `/`). Zasób obowiązkowy
   (`origin: mandatory`) trafia do pluginu CWM firmy (`sessions/<projekt>/plugin/commands/`), a
   polecenie ma przedrostek pluginu: `/cwm-<firma>:cwm-<nazwa>`. Treść idzie przez `parseContent('command')`,
   czyli te same reguły frontmattera co komenda. Brakujący `$ARGUMENTS` (i `$1`) jest dopisywany na końcu jako wiersz
   `Task: $ARGUMENTS`, żeby silnik dostał opis zadania. Nazwa zajęta przez inną komendę to błąd planu.
   Workflow `orchestrated` nie jest generowany (notatka w planie), a `cwm run` odmawia go z komunikatem
   „nieobsługiwany”; wykonanie kroków i agentów to osobny etap.
8. **Zatwierdzenie jak komenda.** `workflow` jest rodzajem zatwierdzenia (`ApprovalKind`, klucz
   `workflow:<id>`, `EXECUTION_RELEVANT_FIELDS.workflow`): `needsApproval` i `executionFields` liczą
   te same pola co dla komendy (`allowed-tools`, wstawki `!` w całości, skrót wygenerowanej treści).
   Treść bez tych cech nie wymaga zatwierdzenia, jak zwykła komenda; zmiana treści z takimi cechami
   pyta ponownie. Zatwierdzenia dotyczą wszystkich aktywnych workflow profilu (jak wszystkich
   komend), nie tylko wybranego: start nie rozróżnia, które polecenie zostanie użyte. Workflow
   nie należy do pakietów (ADR 0044), więc zawsze pyta firma.
9. **`$ARGUMENTS` nie trafia do powłoki.** Silnik podstawia `$ARGUMENTS[n]`, `$ARGUMENTS` i `$n` przez
   `replaceAll`, bez granic słów, także wewnątrz wstawek `!`. CWM nie odtwarza jego parsera wstawek:
   treść workflow z `$ARGUMENTS` albo `$<cyfra>` (wzorzec bez `\b` i bez `(?!\d)`, więc łapie też
   `$ARGUMENTSx` i `$10`) razem z dowolnym znacznikiem wstawki (`` !` ``, ```` ```! ````, `~~~!`) w całym tekście
   jest błędem planu i odmową `cwm workflow add` (SEC-01). Sprawdzany jest tekst źródłowy, bez doklejonego
   przez CWM wiersza `Task: $ARGUMENTS`.
10. **Zadanie jako argument silnika.** `workflowPrompt` składa jeden argument `/<polecenie> <zadanie>`.
    Zaczyna się od `/`, więc zadanie z `-` na początku nie może stać się flagą, a `buildEngineArgv`
    wstawia przed nim `--`. `checkPassThroughArgs` działa bez zmian na argumentach. Zadanie przechodzi
    `validateTask`: niepuste, do 4000 znaków, bez znaków sterujących i formatujących (poza nową linią i
    tabulatorem; bez NUL, ESC, nadpisań kierunku). Tekst idzie przez `argv`, bez powłoki, i nie jest zapisywany w profilu ani w logu;
    pojawia się tylko w wypisie `--dry-run` (argumenty silnika). Argumenty silnika po `--` nie są w tym etapie przyjmowane: wszystkie słowa
    po opcjach są zadaniem.
11. **Rozszerzenia schematu (poza specyfikacją, za zgodą właściciela).** `config.yaml`:
    `resources.mandatory|optional.workflows`; `company.yaml`: `workflows.default`; `project.yaml`:
    `spec.workflows.default`. Wszystkie opcjonalne, więc dotychczasowe manifesty przechodzą bez zmian.
12. **`cwm workflow add|list|show`.** `add <id> --from <plik.md> | --from-command <id>` zapisuje
    `workflow.yaml` (typ `instructional`, wersja `1.0.0`, `routing`) i `workflow.md`; id `global/<nazwa>`
    trafia do rejestru, `<firma>/<nazwa>` do `companies/<firma>/workflows/<nazwa>/`.
    `--enable <firma>` dopisuje id do `resources.enable.workflows` (firma-właściciel tylko u siebie,
    odmowa przy `disableOptional`), `--global optional|mandatory` do `config.yaml`. Zapis przez writer
    `~/.cwm`, edycja listy parserem `yaml` z walidacją wyniku, całość pod `runtime/global`; te same
    kontrole treści co plan (`parseContent`, odmowa `$ARGUMENTS` we wstawce) wykonują się już przy
    dodawaniu. Istniejące id z inną treścią albo regułami to odmowa, z tą samą treścią to brak zmian.
    `show` pokazuje routing, polecenie i cechy do zatwierdzenia.

13. **Wstawki jak w silniku (SEC-02).** `extractInlineCommands` i `hasInlineCommands` (`content.ts`) używają
    wzorców silnika: wstawka w wierszu `(?<=^|\s)!`([^`]+)`` (może obejmować nowe linie) oraz blok ```` ```! ````
    w dowolnym miejscu, także jednowierszowy; blok dodatkowo z ogrodzeniem `~~~` (szerzej niż silnik). Dotyczy
    też skilli, agentów i komend: zasób, który wcześniej miał niewidoczną wstawkę, dostaje teraz pole
    `inlineSnippets` i pyta o zatwierdzenie, więc jego skrót się zmienia (zamierzone).
14. **Domyślny workflow w zatwierdzeniach (SEC-03).** `spec.workflows.default` projektu wchodzi do pól
    zatwierdzenia pary projekt-firma, a `workflows.default` firmy do pól `company:<id>`, tylko gdy są
    ustawione (skróty bez nich się nie zmieniają). Zmiana domyślnego workflow w repozytorium pyta ponownie.
15. **Kolizje nazw (SEC-04, SEC-05).** Natywny `.claude/commands/cwm-<nazwa>.md` projektu zasłania polecenie
    z profilu, więc `cwm run` odmawia wybranego workflow, którego polecenie jest zasłonięte (`plan.shadowedWorkflowCommands`);
    `cwm start` zostaje przy ostrzeżeniu. Polecenie `cwm-<nazwa>` kolidujące ze skillem o tej samej nazwie
    w profilu jest błędem planu.

## Konsekwencje i ryzyko szczątkowe

- Workflow z wieloma słowami kluczowymi albo wysokim `priority` może przechwytywać routing (zbiera trafienia
  w opisach, które powinny iść gdzie indziej); wybór, wynik i powód są zawsze wypisywane przed startem, a
  `--explain` pokazuje wszystkie wyniki. Reguły dodaje właściciel zasobu, więc ocena ich treści należy do zatwierdzenia
  firmy, a nie do CWM (SEC-06).
- `cwm start` generuje teraz polecenia `cwm-<nazwa>` dla aktywnych workflow `instructional`: zmienia
  się zawartość profilu (widoczne w `cwm diff`) i może pojawić się pytanie o zatwierdzenie.
- Routing jest leksykalny: odmiany słów (`błąd`, `błędy`) są różnymi słowami, więc słowa kluczowe i
  przykłady trzeba podać w formach, które padają w opisach. Brak stemmingu to świadomy wybór (powtarzalność).
- Wartości progów (4, 1, +2 za priorytet) pochodzą z rozsądnych założeń, nie z pomiaru na prawdziwych
  opisach zadań; `--explain` pokazuje pełną tabelę do dostrojenia reguł.
- Workflow `orchestrated` zostaje bez wykonania, a `cwm run` nie przyjmuje dodatkowych argumentów
  silnika (np. `--model`); oba odłożone.
- `cwm run --json` działa tylko z `--dry-run`, bo sesja silnika jest interaktywna i wymieszałaby
  wyjście.
