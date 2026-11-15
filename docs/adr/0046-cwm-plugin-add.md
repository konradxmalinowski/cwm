# ADR 0046: `cwm plugin add|enable|disable|list|remove`

Status: zaakceptowane w zakresie planu (2026-11-15)
Data: 2026-11-15
Dotyczy: ADR 0043 (pkt 3, odłożone polecenie), ADR 0040 (zatwierdzanie), ADR 0045 (usuwanie zasobów)
Źródło: plan `plans/2026-11-15-cwm-plugin-add.md` (lokalny, poza repozytorium); kod w `src/infra/cwm/plugin-registry.ts`, `src/cli/commands/plugin.ts`; opis użytkowy w `docs/CLI.md`

## Kontekst

ADR 0043 świadomie nie dodał `cwm plugin add`: zasób `Plugin` leży w rejestrze globalnym, a włączenie
wymaga edycji `company.yaml`, której żadne polecenie nie robiło. Pierwsze użycie pokazało koszt: ręczny
manifest w `registry/plugins/marketplace/<plugin>/plugin.yaml` i ręczna edycja `plugins.enable`, przy
której pomyłka trafiła też do `mcp.enable`. Od tego czasu istnieją elementy, które to polecenie
składają: edycja YAML z zachowaniem komentarzy i walidacją wyniku (`resource-lists.ts`, ADR 0045),
mutex `runtime/global` (`withGlobalLock`) i czyszczenie odwołań przy usuwaniu zasobu.

## Decyzja

1. **`cwm plugin add <marketplace>/<plugin> [--id <id>] [--plugin-version <v>] [--enable <firma>...]`.**
   Wpis jest rozwiązywany tym samym `resolveMarketplacePlugin` co `cwm start` (marketplace
   zarejestrowany, wpis używalny, katalog zaufany), drzewo pluginu jest czytane `readTree` z odrzuceniem
   twardych dowiązań. Wersja: `--plugin-version`, inaczej `version` z `.claude-plugin/plugin.json`
   (gdy ma format `MAJOR.MINOR.PATCH`), inaczej `0.0.0`. Opcja nazywa się `--plugin-version`, bo
   `--version` przechwytuje globalna flaga programu (`-V, --version`) i nigdy nie dociera do podpolecenia.
2. **Id i kolizje.** Domyślnie `marketplace/<plugin>` (nazwa wpisu małymi literami); `--id` musi mieć
   przestrzeń `marketplace` (ADR 0043 pkt 3). Id zajęte przez inny marketplace albo inny plugin to
   błąd z podpowiedzią `--id marketplace/<marketplace>-<plugin>`. Id zajęte przez ten sam wpis to brak
   zmian (idempotentnie, także wersja się nie zmienia). Katalog zasobu bez poprawnego `plugin.yaml` to
   błąd z odesłaniem do `cwm doctor`, nie nadpisanie.
3. **Zapis.** Zasób przez `replaceScopedTree` (writer `~/.cwm`, zakres `homeScope`), edycja
   `plugins.enable` przez parser `yaml` na dokumencie (komentarze i reszta pliku zostają, w odróżnieniu
   od ręcznej edycji nie ma ryzyka dopisania do `mcp.enable`), wynik przechodzi `validateCompanyManifest`.
   Całość pod `runtime/global`. Wszystkie edycje firm są przygotowane i zwalidowane przed pierwszym
   zapisem: nieistniejąca firma albo `plugins.forbid` przerywa polecenie bez żadnej zmiany.
4. **`enable` i `disable <id> --company <firma>`** dopisują i usuwają id w `plugins.enable`. `enable`
   wymaga zasobu w rejestrze i odmawia przy `plugins.forbid`; `disable` działa też dla id bez zasobu
   (sprzątanie po ręcznych edycjach). Powtórzenie to `Bez zmian`, kod `0`.
5. **`list`** pokazuje pluginy z rejestru, źródło i firmy, które je włączają (`plugins.enable`).
6. **`remove <id>`** odmawia, gdy którakolwiek firma włącza plugin (nazwa firmy w komunikacie) albo gdy
   manifest którejś firmy jest niepoprawny (nie da się sprawdzić). Inaczej usuwa zasób, wpisy
   `exports.plugins`, członkostwo w pakietach i zaufane skróty oraz zatwierdzenia firm, tą samą
   kolejnością co `cwm sync`: odwołania najpierw, katalog (razem z kopiami `.old-*`) na końcu. Projekt
   z `~/.cwm`, który nadal wymienia plugin, daje tylko ostrzeżenie (jak w sync); projekty lokalne nie są
   przeszukiwane.
7. **Nic tu nie zatwierdza pluginu.** Zatwierdzenie zostaje przy `cwm start` (treść pluginu i blok
   `marketplace`, ADR 0043 pkt 6), a `cwm start --dry-run` pokazuje plugin jako `NOWE`. Dodanie do
   rejestru i włączenie w firmie nie uruchamia niczego z pluginu.
8. **`cwm marketplace show <nazwa> <plugin>`** buduje manifest tą samą funkcją co `plugin add`
   (`pluginManifestDocument`), więc podgląd i zapis nie rozjadą się.

## Konsekwencje

- Bez potwierdzenia na terminalu: to jawne polecenie o wąskim zakresie (rejestr i jedna lista w
  `company.yaml`), jak `cwm marketplace add`. Zatwierdzenie wykonawcze jest osobne i zostaje przy starcie.
- Brak kopii `company.yaml` przed edycją; zmiana to jeden wpis na liście, a writer jest atomowy.
- `cwm plugin add` nie aktualizuje wersji istniejącego zasobu. Nowa wersja pluginu w marketplace'ie
  zmienia drzewo i skrót, więc `cwm start` zapyta ponownie; `version` zasobu daje tylko ostrzeżenie o
  rozjeździe (ADR 0043 pkt 8).
- Nie ma blokady między równoległym `cwm plugin ...` a poleceniami, które `runtime/global` nie biorą
  (`cwm import`, `cwm company add`).
