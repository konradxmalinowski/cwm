# Materiały graficzne

last_updated: 2026-11-16

W tym katalogu nie ma jeszcze plików graficznych. Ten plik opisuje, co nagrać i jak, żeby
właściciel mógł to zrobić jednym podejściem. Gotowe pliki dodaje właściciel; nie generuj ich
automatycznie.

## Demo GIF do README (około 20 s)

Cel: pokazać, że `cwm run` najpierw tylko planuje, a dopiero `cwm start` uruchamia silnik.

Przygotowanie:

- Czysty katalog danych i syntetyczny projekt, żadnej prawdziwej konfiguracji ani nazw firm:
  `export CWM_HOME=$(mktemp -d)`, potem `cwm init`, `cwm company add acme`, `cwm project create ~/demo/acme-app --company acme`.
- Terminal 100 kolumn na 28 wierszy, duża czcionka, ciemny motyw bez własnych kolorów
  promptu. Nagrywaj `asciinema` plus konwersja albo ekranem (macOS: QuickTime, potem `ffmpeg`).

Scenariusz:

| Czas   | Polecenie                                       | Co widać                                           |
| ------ | ----------------------------------------------- | -------------------------------------------------- |
| 0-3 s  | `cd ~/demo/acme-app`                            | katalog projektu                                   |
| 3-10 s | `cwm run --dry-run "dodaj test do modułu auth"` | wybór workflow i plan startu, nic nie zapisano     |
| 10-14 s| `cwm approvals list`                            | zatwierdzenia zasobów w `~/.cwm`                   |
| 14-20 s| `cwm start`                                     | zatwierdzenie nowych zasobów i start silnika       |

Wyjście: GIF albo MP4 do 10 MB, szerokość 900 px, 12 do 15 klatek na sekundę, pętla.
Plik: `docs/assets/demo.gif`. W README umieść go pod angielskim opisem.

## Podgląd w mediach społecznościowych (social preview)

Wgrywa się go ręcznie w ustawieniach repozytorium (Settings, General, Social preview).

- Rozmiar 1280 x 640 px, PNG albo JPG, poniżej 1 MB.
- Zawartość: nazwa `CWM`, podpis `Claude Workspace Manager`, jedno zdanie
  "Local manager for AI coding tool configuration", bez zrzutu ekranu z prawdziwymi danymi.
- Styl zgodny z `docs/DESIGN.md` (jeden kolor i jego odcienie, kobalt; bez żółci i zieleni).
- Zostaw 40 px marginesu z każdej strony; część platform przycina krawędzie.
- Plik: `docs/assets/social-preview.png`.
