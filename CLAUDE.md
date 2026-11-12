# CWM - Claude Workspace Manager

Lokalna aplikacja desktopowa (Electron + Angular) do zarządzania konfiguracją narzędzi AI
do programowania: skille, agenci, komendy, instrukcje, reguły i hooki, z jednego miejsca.
Pierwsze dwa obsługiwane narzędzia to Claude Code i OpenAI Codex.

Dawna nazwa to Universal AI Skills Manager (v0.1.0 jest opublikowane pod nią). Nazwa techniczna
to `cwm`, a w kodzie i dokumentach stara nazwa zostaje tylko tam, gdzie jest celowa: odczyt
starych formatów, migracja katalogu danych, historia w ADR i `docs/ROADMAP.md` (ADR 0035).
Kontrakt nazw: most w rendererze `window.cwm`, zmienne `CWM_*`, prefiks logów `[cwm]`,
`userData` w `<appData>/CWM`, pakiet deb i polecenie na Linuksie `claude-workspace-manager`, marker bloku `cwm:start`/`cwm:end`, format kopii `cwm-backup`.
Nie wprowadzaj starych nazw do nowego kodu.

## Dokumentacja projektu

Czytaj w tej kolejności, zanim zaczniesz jakąkolwiek pracę:

- `docs/00-wymagania-zrodlowe.md` - specyfikacja właściciela produktu. Dokument źródłowy,
  do którego wszystko inne się odnosi, nigdy go nie zastępuje.
- `docs/ARCHITECTURE.md` - architektura hexagonalna, cztery warstwy, granice modułów,
  model kanoniczny, kontrakt adapterów, model procesów, granica IPC, model bezpieczeństwa.
- `docs/ROADMAP.md` - struktura katalogów, plan etapów z kryteriami akceptacji, ryzyka.
- `docs/CLI.md` - polecenie `cwm`: komendy, układ `~/.cwm`, przykładowe manifesty, kody wyjścia.
- `docs/adr/` - rekordy decyzji architektonicznych. Zanim zaproponujesz zmianę technologii
  albo podejścia, sprawdź, czy nie ma już ADR, który to rozstrzyga.
- `CHANGELOG.md` - zmiany użytkownika per wydanie (Keep a Changelog, SemVer). Każda zmiana
  widoczna dla użytkownika dostaje wpis pod `## [Unreleased]`.

## Design System

**Zawsze czytaj `docs/DESIGN.md` przed jakąkolwiek decyzją wizualną albo dotyczącą UI.**
Wszystkie fonty, kolory, odstępy i kierunek estetyczny są zdefiniowane tam. Nie odstępuj
od nich bez wyraźnej zgody właściciela produktu. W trybie QA zgłaszaj każdy kod, który
nie zgadza się z `DESIGN.md`.

Podgląd systemu do otwarcia w przeglądarce: `docs/design-preview.html`.

Dwie reguły, które najłatwiej złamać przez przypadek:

- **Jeden kolor i jego odcienie.** Kobalt plus czerwień jako jedyny wyjątek. Żółć i zieleń
  nie istnieją w tym systemie, nawet w ilustracjach i ikonach.
- **Czerwień znaczy wyłącznie usunięcie:** coś, co istnieje teraz, znika, a przywrócenie
  wymaga osobnego kroku. Także wtedy, gdy kopia jest w historii. Operacja bez możliwości
  kopii nie jest czerwona, tylko zablokowana. Intensywność koloru rośnie z wagą
  konsekwencji, a nie z ważnością elementu na ekranie (`DESIGN.md`, sekcja „Czerwień”).

## Granice warstw

`src/core/` nie importuje `electron`, `node:fs`, `better-sqlite3` ani Angulara.
`src/adapters/` nie importuje `node:fs` ani `node:child_process`. Renderer nie importuje
z `main/`, `infra/`, `adapters/` ani `preload/`.

Reguły są wymuszone lintem i sprawdzane przez `npm run test:boundaries`, który wstawia
zakazane importy i wymaga, by lint padł. Nie obchodź ich komentarzem wyłączającym regułę.

## Bezpieczeństwo

Aplikacja ma dostęp do katalogów, w których mogą leżeć tokeny i certyfikaty. Obowiązuje
`docs/ARCHITECTURE.md`, sekcja o modelu bezpieczeństwa. Trzy rzeczy bez wyjątków:
renderer nigdy nie dostaje ścieżki, tylko nieprzezroczysty identyfikator; nic z importu
nie jest wykonywane; żadna zmiana w konfiguracji użytkownika bez jawnego zatwierdzenia
i bez kopii zapasowej.

Testy nigdy nie zapisują do prawdziwej konfiguracji użytkownika. Harness w `tests/harness/`
odmawia startu, jeśli katalog bazowy leży w katalogu konfiguracyjnym któregoś
z obsługiwanych narzędzi.

## Fixture'y

Repozytorium jest publiczne. Każdy fixture jest syntetyczny, nazwy w konwencji `acme-*`.
Nigdy nie kopiuj prawdziwej konfiguracji użytkownika ani jej fragmentów do testów.
