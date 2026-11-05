# ADR 0033: Eksport odmawia, gdy nie ma katalogu głównego narzędzia

Status: zaakceptowane (odpowiedź właściciela produktu na pytanie 8 z Etapu 0, 2026-11-03)
Data: 2026-11-03
Doprecyzowuje: ADR 0012 (co `WriteGate` może utworzyć), ADR 0022 (co znaczy "narzędzie jest zainstalowane")
Źródło: ARCHITECTURE 15.1, pytanie 8

## Kontekst

Pytanie brzmiało, czy aplikacja ma prawo utworzyć `~/.codex/skills` na maszynie, na której
Codeksa nie ma, czy odmawia eksportu, dopóki narzędzie nie jest zainstalowane. Generator
konfiguracji odmawia. Dla aplikacji to decyzja produktowa: utworzony z niczego katalog
`~/.codex` wygląda dla użytkownika jak ślad po narzędziu, którego nie instalował, a dla samego
narzędzia jak konfiguracja, której nikt nie zweryfikował.

Drugi powód wynika z audytu (ARCHITECTURE 1.2): `~/.agents` jest wspólnym katalogiem, który
Codex czyta, ale który istnieje także bez Codeksa. Gdyby jego obecność wystarczała, eksport
do "Codeksa" powstałby na maszynie bez Codeksa.

## Decyzja

Eksport do narzędzia jest dozwolony wtedy i tylko wtedy, gdy istnieje jego katalog główny:
`~/.claude` albo `~/.codex`, z uwzględnieniem `CLAUDE_CONFIG_DIR` i `CODEX_HOME`. Brakujące
podkatalogi wewnątrz istniejącego katalogu głównego są tworzone przy zapisie. `~/.agents`
nie przesądza o obecności Codeksa.

Trzy odpowiedzi z ARCHITECTURE 2.4:

- **Kto to wykonuje.** `LocationCatalog.toolHomeExists(tool)` sprawdza katalog główny
  (`FsLocationCatalog`, `src/infra/platform/locations.ts`). `ExportService.plan` pyta o niego
  przed wywołaniem eksportera, a `SyncService.status` i `SyncService.plan` przed każdym
  narzędziem. Katalog główny musi być katalogiem: zwykły plik o tej nazwie nie liczy się.
- **Co się dzieje, gdy się nie da.** Plan dostaje `toolMissing: true`, zero wpisów i
  `applicable: false`. Nic nie jest zapisywane, a interfejs mówi wprost, którego narzędzia
  brakuje (`missingTools` w `sync:status`, `toolMissing` w `export:plan`). Odmowa dotyczy też
  planów cofnięcia (`ExportService.adopt`).
- **Czy da się do tego dojść.** Tak: test `~/.agents bez ~/.codex nie jest domem Codeksa`
  w `tests/integration/locations.test.ts`, test planu `toolMissing` w
  `tests/unit/export-service.test.ts` i test `missingTools` w `tests/unit/sync-service.test.ts`.

## Stan wdrożenia

Obie połowy decyzji są w kodzie. Odmowa bez katalogu głównego: `tests/unit/export-service.test.ts`, `tests/unit/sync-service.test.ts` i `tests/integration/locations.test.ts`. Tworzenie brakujących roots i plików w istniejącym katalogu głównym: `pickRoot` (`src/adapters/shared/export/plan-support.ts`) wybiera pierwszy wykryty root także wtedy, gdy go nie ma, a wpisy dostają `create` (brakujący plik instrukcji to sam blok między markerami, brakujący `settings.json` i `hooks.json` to sam klucz `hooks`, brakujący `config.toml` to same segmenty agentów). `WriteGate` tworzy brakujący root z trybem 0700 i blokuje root, którego rodzica nie ma (`assertRootAnchored`). Testy: `tests/contract/export.test.ts` (świeży katalog główny, oba narzędzia), `tests/unit/adapters-export-claude.test.ts`, `tests/unit/adapters-export-codex.test.ts`, `tests/integration/write-gate-missing-root.test.ts` i `tests/integration/export-fresh-home.test.ts` (prawdziwy `WriteGate` na katalogu tymczasowym). Drugi root skilli Codeksa (`~/.agents/skills`) nie jest tworzony, bo zapis idzie do pierwszego.

## Konsekwencje

Użytkownik z narzędziem zainstalowanym, ale nieuruchomionym ani razu (bez `~/.codex/skills`),
dostaje podkatalogi i pliki utworzone przy pierwszym eksporcie. Odmowa dotyczy tylko braku
katalogu głównego.

Eksport do narzędzia, którego nie ma, jest niemożliwy z definicji, więc stan synchronizacji
takiego narzędzia nie istnieje. Widok Synchronizacja pokazuje je jako brakujące, a nie jako
"nigdy niezsynchronizowane".
