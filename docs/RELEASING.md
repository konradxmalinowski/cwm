# Wydawanie

last_updated: 2026-11-16

Procedura wydania wersji CWM. Wydania robi opiekun repozytorium. Pakiet jest `private`, więc
nie ma publikacji do npm; wydanie to szkic na GitHubie z instalatorami i `SHA256SUMS`.
Wydania są niepodpisane (ADR 0003), a autoaktualizacji nie ma.

## Zanim zaczniesz

- `main` ma zielone CI: bramki jakości, skan sekretów, cztery cele budowania i cztery paczki.
- Licencja to MIT (`LICENSE`, pole `license` w `package.json`). `private: true` w `package.json`
  blokuje tylko publikację do npm.
- Wszystkie zmiany widoczne dla użytkownika mają wpis pod `## [Unreleased]` w `CHANGELOG.md`.

## Kroki

1. **Gałąź wydania.** `git switch -c chore/release-X.Y.Z` z aktualnego `main`.
2. **Wersja.** Zmień `version` w `package.json` i uruchom `npm install --package-lock-only`, żeby
   `package-lock.json` miał tę samą wersję. Wersjonowanie to SemVer; przed 1.0 zmiana
   niezgodna wstecz podnosi środkową liczbę.
3. **Dziennik zmian** (Keep a Changelog). W `CHANGELOG.md`:
   - zmień `## [Unreleased]` na `## [X.Y.Z] - RRRR-MM-DD` i usuń z wstępu zdania o niescalonych
     gałęziach,
   - dodaj nowy, pusty `## [Unreleased]` nad nim,
   - zaktualizuj linki na dole pliku: `[Unreleased]` porównuje `vX.Y.Z...HEAD`, a `[X.Y.Z]`
     wskazuje na `releases/tag/vX.Y.Z`,
   - odśwież `THIRD_PARTY_NOTICES.md`: `npm run notices`. Skrypt czyta tylko `package-lock.json`
     (zależności produkcyjne) i przerywa, gdy pakiet nie ma pola licencji;
     `node scripts/third-party-notices.mjs --check` pokazuje rozjazd bez zapisu.
4. **Dokumentacja.** Sprawdź, czy `README.md`, `docs/CLI.md` i `docs/INSTALACJA.md` nie
   opisują stanu sprzed wydania, i zaktualizuj `last_updated`.
5. **Weryfikacja lokalna.** `npm run lint`, `npm run typecheck`, `npm run test:boundaries`,
   `npm test`, `npm run build`.
6. **Próba pipeline'u.** W zakładce Actions uruchom workflow `Release` ręcznie na gałęzi
   wydania (`workflow_dispatch`, `dry_run` włączone). Buduje cztery cele, scala sumy i sprawdza
   je, ale nie tworzy wydania.
7. **Pull request i scalenie.** Otwórz PR (`chore: release X.Y.Z`), poczekaj na zielone CI i
   scal do `main`.
8. **Tag.** Na zaktualizowanym `main`:

   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Workflow `Release` odrzuci tag, który nie zgadza się z `version` w `package.json`.

9. **Szkic wydania.** Tag uruchamia `release.yml`: cztery cele, `SHA256SUMS` i szkic wydania
   na GitHubie (`gh release create --draft`). Workflow nie publikuje sam.
10. **Opis wydania.** Uzupełnij szkic: opis po polsku i krótkie streszczenie po angielsku,
    wpisy z dziennika zmian, informacja o niepodpisanych plikach i link do
    `docs/INSTALACJA.md`.
11. **Publikacja.** Pobierz pliki ze szkicu, sprawdź `SHA256SUMS` (`sha256sum -c` albo
    `shasum -a 256 -c`), zainstaluj przynajmniej jeden plik na czystym systemie, potem opublikuj
    szkic.

## Wycofanie błędnego wydania

Gdy opublikowane wydanie jest zepsute albo zawiera coś, czego nie powinno:

1. **Przestań je polecać od razu.** Zmień wydanie z powrotem na szkic (`gh release edit vX.Y.Z
--draft`) albo usuń je (`gh release delete vX.Y.Z`). Pobrane już pliki zostają u
   użytkowników, więc przy problemie bezpieczeństwa napisz o tym w ogłoszeniu.
2. **Tag.** Jeśli tag nie był nigdzie używany, usuń go: `git push --delete origin vX.Y.Z` i
   `git tag -d vX.Y.Z`. Nie przesuwaj tagu na inny commit; popraw wersję nową etykietą.
3. **Dziennik zmian.** Oznacz wersję w `CHANGELOG.md` jako wycofaną: `## [X.Y.Z] - RRRR-MM-DD [YANKED]`
   z jednym zdaniem o powodzie.
4. **Poprawka.** Przygotuj wydanie `X.Y.(Z+1)` według kroków wyżej. Wersji nie używa się
   ponownie.
5. **Sekret w paczce.** Traktuj go jako ujawniony: unieważnij go u wystawcy, a dopiero potem
   sprzątaj historię. Zgłoszenie bezpieczeństwa: `SECURITY.md`.
