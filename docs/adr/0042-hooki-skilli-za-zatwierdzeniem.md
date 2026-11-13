# ADR 0042: Hooki w frontmatterze skilla, tylko za zatwierdzeniem

Status: zaakceptowane (decyzja właściciela, 2026-11-12)
Data: 2026-11-12
Dotyczy: ADR 0039 (IMP-05, odrzucanie `hooks` we frontmatterze), ADR 0040 (zatwierdzanie), ADR 0041
Źródło: `src/core/cwm/{content,settings-spec,approval}.ts`, `src/infra/cwm/{import-source,runtime-plan}.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

IMP-05 odrzucał klucz `hooks` w każdym zasobie z frontmatterem. Skille ochronne (na przykład
"careful", który dodaje hook `PreToolUse` dla `Bash` uruchamiający skrypt sprawdzający z natywnego
katalogu konfiguracji) nie dawały się zaimportować.

## Decyzja

1. **Tylko Skill.** Frontmatter skilla może zawierać `hooks`. Agent, komenda i pliki `Files`
   (`.md` w `skills/` i `agents/`) nadal odrzucają `hooks`. `permissionMode` i `mcpServers` są
   odrzucane we wszystkich rodzajach, także w skillu. Warianty zapisu klucza (`Hooks`) są odrzucane.
2. **Te same reguły co Settings.** Walidator jest wspólny (`readHookEvents`): tylko `type: command`,
   `matcher`, `timeout` 1..600, polecenie do 4096 znaków bez znaków sterujących i formatujących, bez
   sekretu, nazwa zdarzenia wg wzoru `PreToolUse`, limit zdarzeń. Dodatkowo pole `statusMessage`
   jako zwykły tekst z tymi samymi regułami tekstu (długość, znaki sterujące, sekret). W Settings
   `statusMessage` nadal jest nieznanym polem.
3. **Frontmatter z modelu.** Profil dostaje `hooks` odtworzone wyłącznie ze zwalidowanego modelu.
   Surowy fragment YAML nie jest kopiowany; sprawdzenie odtworzenia (ponowny parse i porównanie)
   obejmuje także `hooks`.
4. **Zawsze zatwierdzenie.** Skill z niepustymi `hooks` wymaga zatwierdzenia przy `cwm start`.
   Pola zatwierdzenia mają pełne obiekty hooków (`hooks`) i piny skryptów (`pins`), liczone ze
   źródła tym samym `pinHookCommands` co Settings. Ścieżka wskazująca plik, który plan sam zapisze
   do profilu, jest pinowana skrótem planowanych bajtów. Piny liczone są dopiero po zebraniu całego
   planu, więc nie zależą od kolejności zasobów (skrypt może leżeć w drzewie skilla albo `Files`
   przetwarzanych później); to samo dotyczy pinów Settings i pluginów. Ścieżki bez możliwości przypięcia są
   oznaczone i dają ostrzeżenie. Zmiana hooka albo przypiętego skryptu zmienia skrót i pyta ponownie.
   Pola `hooks` i `pins` są dodawane tylko wtedy, gdy hooki są, więc skróty już zatwierdzonych
   zasobów się nie zmieniają. Ekran zatwierdzania wypisuje pola w całości.
5. **Import.** `cwm import claude` zachowuje `hooks` skilla i dopisuje do raportu "hooki skilla:
   wymaga zatwierdzenia" oraz stan pinów skryptów. Nie zmienia to `contentFlags` w manifeście.
6. **Nazwa zsyntetyzowana.** Gdy żaden klucz agenta nie przeżyje, nagłówek dostaje `name:`;
   ta nazwa przechodzi teraz kontrolę duplikatów nazw agentów (`claimAgentName`).

## Weryfikacja na żywym silniku (Claude Code 2.1.323, profil testowy)

- Agent z hookiem `Stop` w pierwszym bloku frontmattera odpalił marker; ten sam agent z drugim
  blokiem `hooks` zaraz po pierwszym nie odpalił drugiego markera. Agent, którego treść zaczyna się
  od `# t`, `---` i `hooks:`, nie odpalił markera. Silnik nie czyta frontmattera poza pierwszym blokiem.
- Skill z hookiem `PreToolUse` dla `Bash` odpalił marker, gdy został użyty (`/acme-careful ...`), a przy
  tym samym poleceniu bez skilla marker nie powstał.

## Ryzyko szczątkowe

Pin obejmuje pliki wskazane w poleceniu hooka, nie ich zależności (skrypt może wczytywać inne pliki).
Zatwierdzający widzi pełne polecenie i oznaczenia ścieżek nieprzypiętych.
