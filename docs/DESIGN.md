# CWM - Claude Workspace Manager - DESIGN.md

Kierunek wizualny jest zamknięty. Ten dokument opisuje wersję z **2026-10-20, po zmianie
kierunku**, z korektą kroju z **2026-11-11** (Space Grotesk zamiast poprzedniego kroju, wpis l w Decisions Log). Czarne tło, jeden kolor, groteskowy krój wyświetlny. Poprzednia wersja
(ciepły papier, żółć i zieleń, Newsreader) jest wycofana i zachowana tylko w Decisions
Log. Żywa wersja jest w `docs/design-preview.html`: typografia, paleta, komponenty, trzy
ekrany i stany na realnej treści produktu. Tokeny mają w obu plikach te same nazwy.

## Product Context

Aplikacja desktopowa zarządza skillami, agentami, komendami i instrukcjami Claude Code
i OpenAI Codex z jednego miejsca: import, normalizacja, konwersja, synchronizacja,
porównywanie, historia. Użytkownik to programista, który dziś ręcznie kopiuje pliki
między `~/.claude` i `~/.codex`.

Cechą wyróżniającą ten produkt na tle kategorii jest to, że **pisze do konfiguracji
użytkownika**. Plik, który nadpisze, może zawierać sekret, ręczną poprawkę albo ostatnią
działającą wersję. Stąd oś produktu: **poważne narzędzie do poważnej roboty**, a w praktyce
pewność przed akcją, nie szybkość akcji.

Oś mówi, czym produkt nie jest. Dlatego jest przełożona na trzy decyzje pozytywne, które
działają jak kontrakt:

1. **Zdanie zamiast tytułu.** Każdy ekran otwiera pełne zdanie w stronie czynnej,
   np. „Zapis zmieni 14 plików w 2 narzędziach".
2. **Liczby jako bohaterowie.** Liczba zmian, nadpisań i usunięć jest największym
   elementem ekranu.
3. **Kolor wyłącznie jako informacja.** Nigdy jako dekoracja.

Widoki produktu (z wymagań): Dashboard, Skills Library, Agents, Commands, Rules, Profiles,
Sync Center, Diff Viewer, Import Wizard, History, Settings, Diagnostics. Reguła
organizacyjna z `ARCHITECTURE.md` sekcja 13.1: każdy stan operacji na plikach ma swój widok
(plan, konflikt, trwa, powodzenie, częściowe powodzenie, błąd, wycofane).

## Aesthetic Direction

Materiał: **czerń i linia 1 px**. Czysta czerń jest wyłącznie tłem okna. Dekoracja jest
minimalna, całą pracę robią typografia i linie. Zero gradientów. Ponieważ nie ma
gradientów, a na jednolitej czerni nie ma z czego zbudować głębi, **powierzchnie muszą mieć
ton** (`surface`, `surface-raised`); głębia pochodzi z linii 1 px i zmiany tonu powierzchni.

Ton: przyrząd pomiarowy, nie magazyn. Layout jest wyrównany do lewej i asymetryczny,
**nic nie jest wyśrodkowane**. Ciemny motyw jest domyślny, jasny jest opcją (biały, nie
papier).

Tekst podstawowy nie jest czystą bielą (`#EDEDED`): badanie kategorii wykazało, że żaden z
trzech zbadanych produktów nie używa czystej bieli jako tekstu podstawowego.

### Trzy ryzyka, które właściciel wziął i które są wykonane, nie złagodzone

**Ryzyko 1: diff jak korekta redaktorska.** Łamana norma: zielone i czerwone tła wierszy.
Tu usunięcia są przekreślone i wyciszone (`text-muted`, `line-through`), dodania
podkreślone `cobalt-300` (2 px), **tła wierszy są neutralne**, a zmiana wiersza dostaje
znak w marginesie (plus, kreska, strzałka). Kolor nie opisuje linijek. Uzasadnienie:
dzisiejsza konwencja zużyła czerwień na rzeczy rutynowe (każda usunięta linijka), więc w
diffie przestała cokolwiek znaczyć. Tu kolor oznacza plik: nadpisanie pliku
niezarządzanego (`cobalt-200`) albo usunięcie z dysku (czerwień).

**Ryzyko 2: pierwszy ekran jako plakat.** Trzy gigantyczne liczby w Space Grotesk po
lewej (zmian, nadpisań, usunięć), obok pełne zdanie, pod spodem rejestr: wiersze po 40 px
rozdzielone liniami, przed każdym wąski margines ze znakiem korektorskim, na dole podwójna
linia i suma jak w rachunku. Przycisk zapisu stoi przy sumie, nie w pływającym pasku, i
podpisuje się liczbą: „Zapisz 14 zmian". **Zero jest wyciszone** (`text-muted`), a liczba
nadpisań jest w `cobalt-200`, a usunięć czerwona, tylko wtedy, gdy jest większa od zera.
Koszt tego ryzyka to pusty plan z trzema szarymi zerami. Jest rozwiązany, nie przemilczany:
zdanie niesie treść („Cele są zgodne z biblioteką, więc zapis nie zmieni żadnego pliku"), a
pod spodem stoi dowód pracy („Sprawdzono 128 plików w 2 narzędziach o 14:32:07. Zero
oznacza, że sprawdzono i nic się nie różni, nie że odczyt się nie udał"). Stan jest w
`design-preview.html` sekcja 6 oraz na żywo w makiecie 5a (przycisk „Odznacz wszystko").

**Ryzyko 3: nawigacja jako numerowany spis treści.** Łamana norma: pasek ikon. Tu spis
treści krojem wyświetlnym z numerami: „1. Biblioteka", „2. Import", „3. Eksport",
„4. Diagnostyka", „5. Synchronizacja", „6. Historia". **Zero ikon w nawigacji.** Aktualna
pozycja ma podkreślenie `cobalt-300` 2 px. Uzasadnienie: sześć rodzajów elementów biblioteki
w ikonach wyglądałoby jak sześć podobnych kółek. Numeracja jest stała: kolejne widoki
dostają kolejne numery, istniejące się nie przesuwają. Taki układ jest w
`src/renderer/app/app.component.html`; wcześniejszy przykład (Synchronizacja jako 3,
Historia jako 4) był planem sprzed kodu.

### Ryzyka odrzucone

- **Atkinson Hyperlegible Next jako font interfejsu.** Odrzucony przez właściciela. Nie
  wracać do niego. Dostępność jest zapewniona innymi środkami: kontrast co najmniej 4,5:1,
  widoczny fokus, pełna obsługa klawiatury, brak koloru jako jedynego nośnika znaczenia.
- **Ciepły papier i wielobarwna semantyka (żółć, zieleń).** Odrzucone przez właściciela po
  pierwszej wersji tego dokumentu. Nie wracać do ciepłych neutralnych ani do żółci i
  zieleni jako kolorów stanu.
- **Newsreader (serif).** Wycofany. Wysoki kontrast kresek na czystej czerni ciągnął w
  stronę eleganckiego magazynu, a to walczyło z osią „poważne narzędzie".

## Typography

Zasada podziału, obowiązuje bez wyjątków: **grotesk mówi, sans steruje, mono cytuje plik.
Nigdy odwrotnie.**

| Rola | Font | Gdzie |
|---|---|---|
| grotesk | **Space Grotesk** (SIL OFL 1.1) | zdanie otwierające ekran, tytuły głównych widoków i paneli, spis treści, wielkie liczby na plakacie. Nic więcej, poza gęstym UI |
| sans | **Source Sans 3** (Google Fonts) | nawigacja robocza, etykiety, treść, przyciski, kontrolki, metadane |
| mono | **Commit Mono** | ścieżki, diffy, frontmatter, skróty klawiszowe, wartości przed i po |

Dlaczego Space Grotesk (R-06 antislopa wymaga pisemnego uzasadnienia, bo to jeden z
„domyślnych" krojów modeli, więc wybór musi mieć powód poza modą). Powody są cztery.
Po pierwsze licencja: SIL OFL 1.1 pozwala dołączyć plik do publicznego repozytorium i
zachować go w paczce, czego licencja poprzedniego kroju nie dawała (wpis l).
Po drugie polskie znaki: pełne ą ć ę ł ń ó ś ź ż w podzbiorze latin-ext, sprawdzone w
pliku. Po trzecie rola: to grotesk o geometrycznej konstrukcji z cyframi o wyraźnych
kształtach (jedynka z flagą, płaska dwójka), więc liczby plakatu czytają się jako
odczyt przyrządu, a nie jako tekst. Po czwarte tryb użycia: krój występuje tylko w pięciu
rolach (zdanie, tytuły, spis treści, liczby), nigdy w treści, więc jego rozpoznawalność nie
robi z interfejsu szablonu; tożsamość niosą czerń, kobalt i podział „grotesk mówi, sans
steruje". Tytuły i liczby mają wagę 700, zdanie i spis treści 500.

Wąski zakres wag: **400** dla treści, **500** dla etykiet, **600** dla tytułów w sansie. W
groteska używamy tylko 500 i 700 (rodzina ma też 300, 400 i 600, ale nie są wczytywane,
żeby nie mnożyć plików; „semibold" w groteska pełni 700).

`font-variant-numeric: tabular-nums` jest włączone w kolumnach: rejestr, rachunek, tabela
biblioteki, tabela kontrastów. **Space Grotesk ma cyfry tabelaryczne (`tnum`, sprawdzone w
tabeli GSUB pliku `space-grotesk-latin-*-normal.woff2`: zero.tf do nine.tf)**, więc
dawna reguła „grotesk nie ma cyfr tabelarycznych" przestaje obowiązywać. Role się nie
zmieniają: kolumny nadal liczą się w Source Sans 3, a grotesk zostaje przy pojedynczych
liczbach. Różnica jest tylko taka, że gdyby kolumna liczb w groteska kiedyś była
potrzebna, `tabular-nums` zadziała.

### Skala

| Token | px / interlinia | Font | Waga | Rola |
|---|---|---|---|---|
| `number` | 96 / 96 | Space Grotesk | 700 | liczby plakatu, szerokie okno |
| `number-compact` | 56 / 56 | Space Grotesk | 700 | pas liczb nad rejestrem, wąskie okno |
| `sentence` | 28 / 36 | Space Grotesk | 500 | zdanie otwierające ekran (24 / 32 w wąskim oknie) |
| `title` | 20 / 28 | Space Grotesk | 700 | tytuły sekcji i paneli |
| `toc` | 18 / 28 | Space Grotesk | 500 | numerowany spis treści (16 / 28 gdy poziomy) |
| `body-raised` | 16 / 24 | Source Sans 3 | 400 | tekst podwyższony |
| `body` | 14 / 20 | Source Sans 3 | 400, 500 | treść, etykiety, przyciski |
| `meta` | 12 / 16 | Source Sans 3 | 400, 500 | metadane, nagłówki kolumn |
| `mono` | 13 / 20 | Commit Mono | 400 | ścieżki, diff, frontmatter |
| `mono-meta` | 12 / 16 | Commit Mono | 400 | skróty klawiszowe, numery linii |

Treść ma 14 px, metadane 12 px, tekst podwyższony 16 px. Mono ma 13 px obok sansa 14 px,
bo stała szerokość znaku sprawia, że przy równych px wygląda na większy.

### Stan faktyczny fontów, sprawdzony 2026-10-20

**Space Grotesk: pliki lokalne.** Wagi 500 i 700 w podzbiorach latin i latin-ext leżą w
`src/renderer/assets/fonts/` (12 do 13 KB każdy). Źródło: paczka npm
`@fontsource/space-grotesk` **5.3.0**, pliki bez modyfikacji, razem z pełnym tekstem
licencji w `LICENSE-space-grotesk` (copyright: The Space Grotesk Project Authors,
github.com/floriankarsten/space-grotesk). `angular.json` kopiuje cały katalog
`assets`, więc licencja trafia do zbudowanej paczki. **Polskie znaki: są** (latin-ext;
sprawdzone fontTools). Nie ma strzałki `→` (U+2192), więc w specimenie strzałka stoi tylko
w mono. `unicode-range` w `_fonts.scss` jest wzięty z `unicode.json` paczki, więc
przeglądarka sięga po plik latin-ext tylko dla polskich liter.

**Commit Mono: ładuje się z jsDelivr**, a nie jest fallbackiem. Nie ma go w Google Fonts, więc
podgląd używa `@font-face` z `@fontsource/commit-mono@5.3.0` (plik
`commit-mono-latin-400-normal.woff2`), a przed tym próbuje fontu zainstalowanego lokalnie.
`document.fonts` raportuje `Commit Mono 400` jako `loaded`.

- **Fallback.** Gdy font się nie wczyta, stos mono spada do
  `ui-monospace, SFMono-Regular, Menlo, monospace`. To jest fallback, nie Commit Mono. Strona
  podglądu pokazuje na żywo w sekcji 2, który z przypadków zachodzi dla każdego z trzech
  fontów.
- **Podzbiór latin.** Fontsource dostarcza tylko podzbiór latin, więc polskie znaki
  diakrytyczne w mono spadają do fallbacku. Dlatego treść diffów w podglądzie jest po
  angielsku (tak wyglądają realne definicje agentów), a mono służy ścieżkom i kluczom.
- **Aplikacja nie może zależeć od CDN.** Jest lokalna i ma działać offline. Wersja
  produkcyjna musi dołączyć pełny Commit Mono (z oficjalnego wydania), Space Grotesk i
  Source Sans 3 jako pliki lokalne.

## Color

**Jeden kolor i jego odcienie, plus czerwień.** Nic innego nie ma barwy. Dwa motywy przez
zmienne CSS: ciemny (domyślny) i jasny. Przełącznik ustawia `data-theme` na `<html>`; bez
wyboru działa `prefers-color-scheme` (system w jasnym trybie daje jasny, w pozostałych
przypadkach ciemny).

### Neutralne

| Token | Ciemny | Jasny | Użycie |
|---|---|---|---|
| `background` | `#000000` | `#FFFFFF` | tło okna (czysta czerń tylko tu) |
| `surface` | `#0A0A0A` | `#F7F7F7` | spis treści, panel szczegółu, karty |
| `surface-raised` | `#141414` | `#EDEDED` | wiersz bieżący i najechany |
| `hairline` | `#262626` | `#D4D4D4` | linie 1 px |
| `text` | `#EDEDED` | `#111111` | treść (nie czysta biel) |
| `text-muted` | `#8A8A8A` | `#5A5A5A` | metadane, wyciszone zero, granice pól |

### Rampa kobaltu

| Token | Ciemny | Jasny | Rola |
|---|---|---|---|
| `cobalt-100` | `#D6E0FF` | `#0B1550` | tekst na powierzchni akcentowej |
| `cobalt-200` | `#A8BEFF` | `#16268F` | **sygnał „nadpisze istniejący plik"** |
| `cobalt-300` | `#7F9FFF` | `#2A47C7` | baza: akcja, zaznaczenie, fokus, podkreślenie dodań w diffie |
| `cobalt-400` | `#4F68C4` | `#6079DB` | wyciszony akcent, obramowania aktywne |
| `cobalt-500` | `#2A3A6E` | `#C9D5FA` | powierzchnia akcentowa podniesiona |
| `cobalt-600` | `#1B2A5E` | `#DDE5FF` | wypełnienie powierzchni akcentowej |

Jasny motyw jest rampą **odwróconą rolami, nie numerami**: baza akcji jest ciemniejsza
(`#2A47C7`), a `cobalt-200`, czyli najintensywniejszy stopień, jest od niej jeszcze
ciemniejszy, bo sygnał nadpisania musi być najbardziej kontrastowym stopniem wobec tła w obu
motywach. Powierzchnie `cobalt-500` i `cobalt-600` są w jasnym motywie jasnymi tintami.
Pomocniczy token `on-accent` (`#000000` ciemny, `#FFFFFF` jasny) to etykieta na wypełnieniu
`cobalt-300`. Alias `accent` = `cobalt-300`.

### Czerwień

| Token | Ciemny | Jasny |
|---|---|---|
| `destructive` | `#F2705D` | `#B3261E` |

Czerwień jest **jedynym innym kolorem w całym systemie** i znaczy: **ta operacja usuwa coś,
co istnieje teraz, a przywrócenie wymaga osobnego, świadomego kroku.** Dotyczy to usunięcia
pliku z dysku oraz błędu, po którym aplikacja nie przywróciła poprzedniego stanu (plik, który
istniał, nie wrócił sam). **Nigdzie więcej, w żadnym stanie, w żadnej ilustracji.**

Reguła jest oparta na prawdzie, nie na skrócie. „Tego nie cofniesz" byłoby nieprawdą, bo
architektura gwarantuje kopię przed każdym zapisem. Czerwień ma jednak uzasadnienie
materialne: usunięcie jest **gorsze od nadpisania**. Po nadpisaniu plik dalej istnieje i ma
treść; po usunięciu nie ma go wcale, a odzyskanie wymaga, żeby użytkownik wiedział o
Historii, znalazł ją i wykonał osobną operację. Konwencja nie czyta instrukcji.

### Skala intensywności: reguła nadrzędna

**Intensywność koloru rośnie z wagą konsekwencji. Zaznaczenie to baza kobaltu, nadpisanie to
najjaśniejszy kobalt plus słowo, usunięcie to czerwień (ta operacja usuwa coś, co istnieje
teraz, a przywrócenie wymaga osobnego, świadomego kroku). Potwierdzony wynik nie dostaje
koloru w ogóle.**

| Waga konsekwencji | Wygląd |
|---|---|
| zapisane i potwierdzone | **bez koloru**: kolor `text` plus słowo („Zapisano"). Sukces nie potrzebuje pilności, a każdy kolor wydany na sukces osłabia sygnał zagrożenia |
| zaznaczenie, akcja, fokus | `cobalt-300` |
| **nadpisze istniejący plik** | `cobalt-200`, najjaśniejszy (w jasnym motywie najciemniejszy) stopień, **plus słowo „nadpisze", plus waga 700**, plus pasek 3 px i tło `cobalt-600` |
| **usunięcie**: znika coś, co istnieje teraz, przywrócenie osobnym krokiem | `destructive` |
| **zablokowane**: aplikacja nie potrafi zrobić kopii | **bez koloru**: pasek 4 px w `text`, słowo „Zablokowane", powód |

To zastępuje żółć. Konsekwencje, które są częścią reguły:

- **Kolor nigdy nie jest jedynym nośnikiem znaczenia.** Sygnał nadpisania niesie zestaw:
  słowo, waga, znak zamiany (dwie strzałki) w marginesie, pasek i tło. Barwa `cobalt-200`
  wobec `cobalt-300` jest różnicą jasności, nie odcienia (patrz niżej), więc nie wolno na
  niej polegać samodzielnie.
- **Poziom zgodności nie używa koloru.** `Pełna`, `Częściowa`, `Z ostrzeżeniami`, `Brak
  konwersji` pokazują słowo i cztery segmenty (4, 3, 2, 0 wypełnionych). Brak koloru jest
  dziś mocniej uzasadniony niż przy poprzedniej palecie: jedyny kolor poza kobaltem to
  czerwień, a ta jest zarezerwowana na usunięcie.
- **Błąd odwracalny jest neutralny.** Gdy aplikacja wycofała nieudany zapis, błąd dostaje
  gruby pasek (4 px) w kolorze `text` i słowo „Błąd". Czerwień dostaje błąd, po którym
  aplikacja nie przywróciła stanu i odzyskanie wymaga ręcznego kroku. Błąd walidacji pola:
  ramka 2 px w `text` i słowo „Błąd".
- **Diff:** tła wierszy neutralne. Kolor niesie plik, nigdy linijka.
- **Usunięcie jest czerwone, mimo że kopia jest w Historii.** Aplikacja zawsze robi kopię
  przed zapisem (`ARCHITECTURE.md` 8.3), więc usunięcie jest odtwarzalne. Ale plik znika z
  dysku, a odtworzenie jest osobną, świadomą operacją, o której użytkownik musi wiedzieć.
  Czerwień opisuje tę materialną różnicę, nie „nieodwracalność".
- **Operacja bez możliwości zrobienia kopii jest zablokowana, nie czerwona.** Jeśli aplikacja
  nie potrafi zabezpieczyć kopią (brak uprawnień, cel poza zakresem kopii zapasowej),
  **odmawia wykonania i mówi dlaczego**, zamiast ostrzegać i robić. Czerwień ostrzega przed
  konsekwencją, którą użytkownik może świadomie przyjąć. Brak możliwości odtworzenia nie jest
  konsekwencją do przyjęcia, tylko warunkiem, którego nie spełniamy. Stan „Zablokowane" jest
  neutralny (pasek 4 px w `text`, słowo, powód) i ma własną kartę w sekcji 6 podglądu.
  **Konsekwencja architektoniczna poza tym dokumentem:** gwarancja „kopia przed zapisem" musi
  być **twardym warunkiem wstępnym** zapisu, nie ostrzeżeniem. Architekt powinien
  odzwierciedlić to w kontrakcie adaptera (`ARCHITECTURE.md` sekcje 5 i 8.3, ADR 0012 i 0013):
  adapter lub `WriteGate` musi umieć zwrócić wynik „nie da się zabezpieczyć kopią" (z powodem
  dla użytkownika) jeszcze na etapie planu, a plan oznacza taki plik jako zablokowany i nie
  dopuszcza go do `sync:apply`.

### Akcent

Kobalt (`cobalt-300`) służy do zaznaczenia, fokusu, głównej akcji i podkreśleń. **Nigdy jako
wypełnienie dużej powierzchni** (wypełnieniem jest wyłącznie mały przycisk głównej akcji i
zaznaczone pole wyboru). Powierzchnie akcentowe (`cobalt-600`, `cobalt-500`) są
zarezerwowane dla zdarzenia nadpisania: pasek nad diffem, wiersz rejestru, panel szczegółu.

### Kontrast (wyliczony, nie założony)

Wzór WCAG 2.x: luminancja względna sRGB, współczynnik (L1 + 0,05) / (L2 + 0,05). Liczone
skryptem w Node z kodów hex powyżej. Strona podglądu przelicza je jeszcze raz w przeglądarce
przy każdym załadowaniu i zgłasza rozbieżność (przy ostatnim sprawdzeniu: zero
rozbieżności). Cel: 4,5:1 dla tekstu, 3:1 dla obramowań, w obu motywach.

| Para (tekst na tle) | Ciemny | Jasny |
|---|---|---|
| `text` na `background` | 17.94:1 (AAA) | 18.88:1 (AAA) |
| `text` na `surface` | 16.91:1 (AAA) | 17.63:1 (AAA) |
| `text` na `surface-raised` | 15.74:1 (AAA) | 16.13:1 (AAA) |
| `text-muted` na `background` | 6.08:1 (AA) | 6.90:1 (AA) |
| `text-muted` na `surface` | 5.73:1 (AA) | 6.44:1 (AA) |
| `text-muted` na `surface-raised` | 5.34:1 (AA) | 5.89:1 (AA) |
| `cobalt-300` na `background` | 8.31:1 (AAA) | 7.44:1 (AAA) |
| `cobalt-300` na `surface` | 7.83:1 (AAA) | 6.94:1 (AA) |
| `cobalt-300` na `surface-raised` | 7.29:1 (AAA) | 6.35:1 (AA) |
| `cobalt-200` na `background` | 11.47:1 (AAA) | 12.30:1 (AAA) |
| `cobalt-200` na `surface` | 10.82:1 (AAA) | 11.48:1 (AAA) |
| `cobalt-200` na `surface-raised` | 10.07:1 (AAA) | 10.50:1 (AAA) |
| `cobalt-200` na `cobalt-600` | 7.45:1 (AAA) | 9.79:1 (AAA) |
| `cobalt-300` na `cobalt-600` | 5.40:1 (AA) | 5.92:1 (AA) |
| `cobalt-100` na `cobalt-600` | 10.37:1 (AAA) | 13.52:1 (AAA) |
| `cobalt-100` na `cobalt-500` | 8.28:1 (AAA) | 11.62:1 (AAA) |
| `destructive` na `background` | 7.25:1 (AAA) | 6.54:1 (AA) |
| `destructive` na `surface` | 6.84:1 (AA) | 6.10:1 (AA) |
| `destructive` na `surface-raised` | 6.36:1 (AA) | 5.58:1 (AA) |
| `on-accent` na `cobalt-300` | 8.31:1 (AAA) | 7.44:1 (AAA) |
| `cobalt-400` na `background` (obramowanie) | 4.11:1 (3:1 ✓) | 4.00:1 (3:1 ✓) |
| `cobalt-400` na `surface-raised` (obramowanie) | 3.61:1 (3:1 ✓) | 3.41:1 (3:1 ✓) |
| `text-muted` na `surface` (obramowanie) | 5.73:1 (3:1 ✓) | 6.44:1 (3:1 ✓) |


**Stopnie sygnałowe, wartości najgorszego przypadku** (najniższa wartość spośród tła,
powierzchni i podniesionej powierzchni):

| | Ciemny | Jasny |
|---|---|---|
| `cobalt-200` na `cobalt-600` (sygnał na własnej powierzchni) | 7.45:1 | 9.79:1 |
| `destructive` na `surface-raised` | 6.36:1 | 5.58:1 |
| najniższy tekst w całej tabeli | `text-muted` na `surface-raised`, 5.34:1 | `destructive` na `surface-raised`, 5.58:1 |

Poprzedni najcieńszy margines (ostrzeżenie `warning` w jasnym motywie, 4.72:1) **zniknął**:
najniższa wartość tekstu w całym systemie to dziś 5.34:1 (ciemny) i 5.58:1 (jasny).
Obramowania `cobalt-400` mają 4.11:1 na czerni (ciemny) i 4.00:1 na bieli (jasny); na
`surface-raised` 3.61:1 (ciemny) i 3.41:1 (jasny), więc wszystkie przechodzą 3:1 (WCAG 1.4.11). Granice pól
używają `text-muted`, bo `hairline` ma zbyt mały kontrast, żeby oznaczać kontrolkę.

### Czy cobalt-200 da się odróżnić od cobalt-300

To warunek, od którego zależy, czy ten system nadal chroni użytkownika przed utratą danych,
więc różnica jest policzona osobno, a nie wywnioskowana z kontrastu wobec tła:

| Miara różnicy cobalt-200 i cobalt-300 | Ciemny | Jasny |
|---|---|---|
| Współczynnik kontrastu WCAG | 1.38:1 | 1.65:1 |
| Różnica jasności CIE L* | 10.6 | 14.1 |
| Różnica barwy CIEDE2000 (ΔE00) | 9.1 | 11.6 |


Odczyt: w ciemnym motywie różnica między stopniami to 10.6 jednostki jasności L* i
ΔE00 = 9.1. To różnica wyraźnie widoczna obok siebie (próg „dwóch różnych kolorów" to
ok. 2 do 5), ale **mała jako kontrast jasności (1.38:1)**: oba stopnie są jasnymi
błękitami tego samego odcienia. W jasnym motywie jest lepiej (1.65:1, ΔE00 = 11.6), bo tam
rampa jest rozciągnięta w stronę ciemnego. Z tego wynikają dwie decyzje:

1. `cobalt-200` nigdy nie niesie sygnału sam. Nadpisanie ma pasek 3 px, tło `cobalt-600`,
   słowo „nadpisze", wagę 700 i znak zamiany. W realnym rejestrze (makieta 5a, sekcja 3
   podglądu) wiersz nadpisania wyróżnia się od wiersza zaznaczonego głównie tłem i paskiem,
   a dopiero w drugiej kolejności odcieniem tekstu.
2. Nie wolno zbliżać `cobalt-200` do `cobalt-300` (np. przyciemniać bazy w ciemnym motywie),
   bo różnica jest już na granicy komfortu.

## Spacing

Baza 4 px. Skala: 4, 8, 12, 16, 24, 32, 48, 64 (tokeny `--s1` do `--s8`). Gęstość
**compact**: kategoria pracuje w 12 do 14 px, więc ten produkt też.

| Element | Wymiar |
|---|---|
| wiersz rejestru, wiersz tabeli | 40 px (w dwóch liniach na wąskim oknie: min. 56 px) |
| przycisk, pole | 32 px wysokości (mały przycisk 24 px) |
| padding obszaru roboczego | 24 px (16 px na wąskim oknie) |
| padding panelu szczegółu | 24 px / 16 px |
| promień | 2 px (kontrolki), 0 (ramki i karty) |
| linie | 1 px `hairline`; podwójna linia 3 px `double` tylko nad sumą |

## Layout

Trzyczęściowa rama: **spis treści** (192 px) | **obszar roboczy** (elastyczny) | **panel
szczegółu** (280 px). Wyrównanie do lewej, asymetria, **nic nie jest wyśrodkowane**.

Rama reaguje na szerokość **własnego kontenera** (`container-type: inline-size`), nie
okna, więc ta sama makieta działa w oknie aplikacji i w podglądzie:

| Szerokość ramki | Układ |
|---|---|
| powyżej 1000 px | trzy części |
| 721 do 1000 px | spis treści i obszar roboczy, panel szczegółu pod obszarem roboczym |
| do 720 px | jedna kolumna: spis treści jako poziomy pas, zdanie, **liczby w poziomym pasie nad rejestrem**, rejestr, panel |

Na wąskim oknie hierarchia zostaje ta sama: zdanie otwiera ekran, liczby są największym
elementem, wiersz rejestru składa się w dwie linie (ścieżka nad, cel i skutek pod). Bardzo
długa ścieżka na 360 px może zająć dodatkową linię; ścieżki nie są skracane wielokropkiem w
rejestrze wąskiego okna, bo ukrywanie ścieżki odbiera pewność, po którą ten produkt istnieje.

`ROADMAP.md` Etap 8 wymaga działania od 1024 px bez poziomego przewijania. Ten system
schodzi niżej, do 360 px.

Ekran **Centrum synchronizacji**: kontekst (12 px) → zdanie → liczby po lewej i fakty o
planie po prawej → rejestr z przyciskami „Zaznacz wszystko" i „Odznacz wszystko" →
rachunek z przyciskiem zapisu przy sumie. **Przeglądarka diffów**: zdanie → pasek
zdarzenia (`cobalt-600` przy nadpisaniu) → diff z czterema kolumnami (numer starej linii,
numer nowej, margines ze znakiem, treść) → legenda znaków. **Biblioteka**: zdanie z
liczbami wyliczonymi z widocznych wierszy → filtr → tabela z kolumnami zgodności per
narzędzie.

### Poziom zgodności

Każdy element biblioteki pokazuje poziom zgodności jako jawną własność, per narzędzie.
Odpowiada czterostopniowemu `CompatibilityLevel` z `ARCHITECTURE.md` sekcja 4.3:
`full` = Pełna, `partial` = Częściowa, `lossy` = Z ostrzeżeniami, `unsupported` = Brak
konwersji. Utrata formatu ma być widoczna przed eksportem, nie zaskakiwać po: panel
szczegółu pokazuje powody, atrybuty tracone (`lostAttributes`) i dopisywane
(`addedAttributes`). Element, który dla danego narzędzia jest natywny (np. serwer MCP w
Claude Code), pokazuje „Natywny" bez segmentów, zgodnie z macierzą (`n/d`).

## Motion

Minimalny i funkcjonalny.

| Zdarzenie | Czas | Uwagi |
|---|---|---|
| wiersze planu wchodzą | 120 ms każdy, odstęp 40 ms | jeden po drugim, `translateY(4px)` i opacity, liczone do 12 wierszy |
| potwierdzenie zapisu | 80 ms | docisk (`translateY(1px) scale(.985)`) i powrót |
| zmiana szerokości ramki | 120 ms | tylko w podglądzie |
| szkielet ładowania, zmiana motywu, fokus | brak | szkielet jest statyczny, bez shimmeru |

`prefers-reduced-motion: reduce` jest respektowane bezwarunkowo: animacje i przejścia są
wyłączone globalnie, a wiersze po prostu są. Podgląd pokazuje na żywo, co zgłasza system.

### Klawiatura jest pełnoprawnym interfejsem

| Skrót | Działanie |
|---|---|
| `j` / `k` | następny i poprzedni wiersz rejestru, tabeli, zmiana w diffie |
| spacja | zaznacza lub odznacza wiersz rejestru |
| `Enter` | otwiera diff bieżącego wiersza |
| `/` | filtr biblioteki |

Skróty są widoczne w marginesie rejestru małym monem (`kbd`, 12 px), nie ukryte w menu.
**Fokus:** pierścień 2 px w `cobalt-300`, odsunięty o 2 px, a szczelinę wypełnia kolor tła
(`box-shadow: 0 0 0 2px background`), więc pierścień nie zlewa się z elementem na żadnej
powierzchni. W rejestrze pierścień obejmuje cały wiersz od wewnątrz. Widoczny w obu
motywach: `cobalt-300` na `background` ma 8.31:1 (ciemny) i 7.44:1 (jasny).

## Decisions Log

### Zmiana kierunku, 2026-10-20 (obowiązuje)

Właściciel produktu odrzucił ciepły materiał i wielobarwną semantykę po pierwszej wersji
tego dokumentu. Zachowane bez zmian: oś i trzy decyzje pozytywne, trzy ryzyka, Source Sans 3
w interfejsie, Commit Mono do plików, baza 4 px i gęstość compact, ruch minimalny, pełna
klawiatura, brak gradientów, wyrównanie do lewej.

| # | Decyzja | Kto |
|---|---|---|
| 1 | Czarne tło (`#000000` / `#FFFFFF`), bez ciepłego papieru. Czysta czerń tylko jako tło, tekst `#EDEDED` zamiast czystej bieli | właściciel produktu |
| 2 | Jeden kolor (kobalt) i jego odcienie zamiast wielobarwnej semantyki. Żółć i zieleń wypadają z palety całkowicie | właściciel produktu |
| 3 | Czerwień jako jedyny inny kolor, wyłącznie dla nieodwracalnego (`#F2705D` / `#B3261E`) | właściciel produktu |
| 4 | Rezygnacja z serifa (Newsreader) | właściciel produktu |
| 5 | Powierzchnie z tonem (`#0A0A0A`, `#141414`), bo bez gradientów i na jednolitej czerni nie ma z czego zbudować głębi | konsultacja |
| 6 | Rampa kobaltu `cobalt-100` do `cobalt-600` i jej wersja dla jasnego motywu | konsultacja |
| 7 | Nowa skala semantyczna: intensywność rośnie z wagą konsekwencji. `cobalt-300` akcja, `cobalt-200` nadpisanie (plus słowo, waga, pasek, tło), czerwień nieodwracalne, sukces bez koloru | konsultacja |
| 8 | (wycofane 2026-11-11, patrz wpis l) Cabinet Grotesk (Fontshare) zamiast Newsreadera, do zdania, tytułów, spisu treści i liczb. Podział ról: grotesk mówi, sans steruje, mono cytuje plik | konsultacja |
| 9 | Fokus w `cobalt-300` ze szczeliną w kolorze tła (zamiast pierścienia „w kolorze papieru") | konsultacja |

### Korekta reguły czerwieni, 2026-10-20 (obowiązuje, zastępuje brzmienie z wpisów 3, 7 i 21)

Autor wszystkich trzech wpisów: **konsultacja po zgłoszeniu wykonawcy**. Wykonawca zgłosił
napięcie między czerwienią dla usunięć a regułą „tego nie cofniesz", skoro aplikacja zawsze
robi kopię przed zapisem. Rozstrzygnięcie: **kolor zostaje, zmienia się reguła.**

| # | Korekta | Kto |
|---|---|---|
| 22 | Reguła czerwieni brzmi: **ta operacja usuwa coś, co istnieje teraz, a przywrócenie wymaga osobnego, świadomego kroku.** Stare brzmienie („czerwień znaczy wyłącznie «tego nie cofniesz»") było **nieprawdziwe wobec gwarancji kopii** i zepsułoby się przy pierwszym użytkowniku, który zauważy, że usunięty plik da się odzyskać z Historii. Usunięcie jest materialnie gorsze od nadpisania, więc czerwień zostaje | konsultacja po zgłoszeniu wykonawcy |
| 23 | Nowy przypadek: operacja, której aplikacja nie potrafi zabezpieczyć kopią, jest **zablokowana, nie czerwona**. Aplikacja odmawia i mówi dlaczego | konsultacja po zgłoszeniu wykonawcy |
| 24 | Konsekwencja architektoniczna reguły 23 (twardy warunek wstępny „kopia przed zapisem", wynik „nie da się zabezpieczyć kopią" w kontrakcie adaptera) przekazana do architekta | konsultacja po zgłoszeniu wykonawcy |

Poprawione brzmienia (zachowane w historii, nie usunięte):

| Wpis | Stare brzmienie | Status |
|---|---|---|
| 3 | „Czerwień jako jedyny inny kolor, wyłącznie dla nieodwracalnego" | poprawione przez 22: „nieodwracalne" było nieprawdziwe |
| 7 | „czerwień nieodwracalne" w skali semantycznej | poprawione przez 22 i 23 |
| 21 | „czerwień tylko dla błędu bez cofnięcia" | poprawione: czerwień dla błędu, po którym stan nie wrócił i odzyskanie wymaga ręcznego kroku |
| c (wykonawcze) | „Usunięcie jest czerwone mimo kopii w Historii, do rewizji" | rozstrzygnięte przez 22: czerwień zostaje, zmieniło się uzasadnienie |

### Z pierwszej wersji, nadal obowiązujące

| # | Decyzja | Kto |
|---|---|---|
| 10 | Oś „poważne narzędzie do poważnej roboty" i trzy decyzje pozytywne | właściciel produktu |
| 11 | Akcent kobaltowy (wybrany nad pomarańczem, bo leży najdalej od sygnału nadpisania) | właściciel produktu |
| 12 | Ryzyka 1 do 3: diff korektorski, plakat z liczbami, spis treści bez ikon | właściciel produktu |
| 13 | Ryzyko odrzucone: Atkinson Hyperlegible Next jako font interfejsu | właściciel produktu |
| 14 | Source Sans 3 jako sans, Commit Mono jako mono | konsultacja |
| 15 | Odstępy: baza 4 px, gęstość compact, wiersz 40 px | konsultacja |
| 16 | Trzyczęściowa rama, wyrównanie do lewej, nic wyśrodkowane | konsultacja |
| 17 | Ruch: wiersze 120 ms jeden po drugim, zapis 80 ms, reduced-motion bezwarunkowo | konsultacja |
| 18 | Klawiatura jako pełnoprawny interfejs, skróty widoczne w marginesie | konsultacja |
| 19 | Poziom zgodności jako jawna własność elementu biblioteki (z propozycji Codeksa) | konsultacja |
| 20 | Poziom zgodności bez koloru (słowo i cztery segmenty). Po zmianie palety jeszcze mocniej uzasadnione | wykonawca, potwierdzone przez właściciela |
| 21 | Błąd odwracalny neutralny, czerwień tylko dla błędu bez cofnięcia | wykonawca, potwierdzone przez właściciela |

### Wycofane wraz ze zmianą palety

| Decyzja z pierwszej wersji | Status |
|---|---|
| Ciepły atrament i papier (`#14110F` / `#F4EFE3`) | wycofana, patrz 1 |
| Żółć (`warning`) dla nadpisania pliku niezarządzanego | wycofana, zastąpiona przez `cobalt-200` (patrz 7) |
| Zieleń (`success`) dla potwierdzonego wyniku zapisu. Ta decyzja stała się bezprzedmiotowa, bo zieleni nie ma; sukces jest bez koloru | wycofana, patrz 7 |
| Newsreader (serif) | wycofana, patrz 4 i 8 |
| Pierścień fokusu w kolorze `text` z kobaltowym offsetem | wycofana, patrz 9 |

### Decyzje wykonawcze, nieobjęte briefem (do potwierdzenia)

| # | Decyzja | Powód |
|---|---|---|
| a | Tło wiersza i paska nadpisania w `cobalt-600`, pasek 3 px w `cobalt-200` | różnica `cobalt-200` od `cobalt-300` jest za mała, żeby nieść sygnał sama (patrz Kontrast) |
| b | W jasnym motywie `cobalt-200` jest ciemniejszy od bazy | najintensywniejszy stopień musi być najbardziej kontrastowy wobec tła w obu motywach |
| c | Usunięcie jest czerwone mimo kopii w Historii | **rozstrzygnięte** wpisem 22: czerwień zostaje, reguła przepisana |
| d | Liczba „zmian" w plakacie jest sumą wszystkich plików (zawiera nadpisania i usunięcia); rachunek rozbija ją na rozłączne kategorie | zdanie „Zapis zmieni 14 plików" i przycisk „Zapisz 14 zmian" wymagają jednej sumy |
| e | Granice pól `text-muted`, nie `hairline` | `hairline` ma za mały kontrast dla WCAG 1.4.11 |
| f | Promień 2 px na kontrolkach | kierunek przyrządu, bez zaokrągleń typowych dla kategorii |
| g | Mono 13 px przy sansie 14 px | optyczne wyrównanie, stała szerokość znaku |
| h | (zastąpione wpisem l) Tytuły w groteska mają wagę 700 | Cabinet Grotesk nie ma wagi 600 |
| i | (zastąpione wpisem m) Cabinet Grotesk tylko do pojedynczych liczb | brak cyfr tabelarycznych |
| j | Zaznaczone pole wyboru wypełnione `cobalt-300` | zaznaczenie to `cobalt-300` wg nowej skali; mały element, nie duża powierzchnia |
| k | Pozycje spisu treści bez ekranu w podglądzie (Import, Historia) są tekstem, nie linkami | brak martwych kontrolek |

### Korekta kroju i decyzje w planie eksportu, 2026-11-11 (korekta kroju obowiązuje, zastępuje wpisy 8, h i i)
| # | Decyzja | Powód |
|---|---|---|
| l | Space Grotesk (SIL OFL 1.1, `@fontsource/space-grotesk` 5.3.0) zamiast Cabinet Grotesk. Te same role, wagi 500 i 700 | licencyjny, decyzja właściciela z 2026-11-11, patrz niżej |
| m | Reguła „grotesk nie ma cyfr tabelarycznych" przestaje obowiązywać. Role bez zmian: kolumny liczą się w Source Sans 3 | Space Grotesk ma `tnum` |
| n | Spis treści 192 px zamiast 168 px | „5. Synchronizacja" w Space Grotesk 18 px jest szersze niż pole 136 px i dotykało krawędzi panelu; krój jest szerszy niż Cabinet Grotesk |
| o | Konflikt planu eksportu z `options` to grupa radio w sekcji Decyzje, bez opcji zaznaczonej z góry. Opcja „Zamień ten fragment na blok aplikacji” dostaje sygnał „Nadpisze” (zmienia istniejący tekst pliku), „Dopisz blok na końcu” jest neutralna. Wybór przelicza plan, nowy `planId` jest jedynym wykonywalnym. Konflikt bez `options` zostaje informacją. Ostrzeżenie wpisu zaczynające się od „Nadpisze” (zastąpienie katalogu skilla) dostaje sygnał nadpisania z listą plików, które znikną | decyzja użytkownika musi być jawna, a nadpisanie ma jeden znak rozpoznawczy |

**Powód licencyjny (wpis l).** Cabinet Grotesk jest objęty ITF Free Font License 2.0
(Indian Type Foundry, Fontshare, wersja z 17 sierpnia 2026, plik `License/FFL.txt`
z oficjalnej paczki `api.fontshare.com/v2/fonts/download/cabinet-grotesk`). Licencja pozwala
osadzić font w aplikacji („You may embed the Font Software in mobile or desktop applications
and digital documents for the uses permitted under this License"), ale zabrania dwóch rzeczy,
które robiło to repozytorium:

> The Font Software may not, beyond the permitted copies and uses defined herein, be
> distributed, duplicated, loaned, resold, sublicensed, transferred, donated, given away or
> otherwise made available to any other person or entity, whether for free or for a fee. This
> includes distributing the Font Software through another font website, font library,
> marketplace, repository, download service, application or platform [...]

> You may not modify, edit, adapt, translate, reverse engineer, decompile, disassemble or
> otherwise alter the Font Software [...]. This includes modifying or replacing glyphs,
> subsetting, format conversion, or altering font names [...]

Pliki `cabinet-grotesk-500.woff2` i `-700.woff2` leżały w publicznym repozytorium i miały inny
rozmiar niż oficjalne, więc łamały oba zakazy. Historii gita nie przepisujemy (decyzja
właściciela z 2026-11-11); pliki są usunięte z drzewa roboczego od commita `2f2713d`.

## Pochodzenie kierunku

Kierunek powstał z **trzech niezależnych propozycji**: konsultacji, Codeksa i osobnego
agenta. Właściciel produktu wybrał oś, akcent i trzy ryzyka, a po pierwszej wersji
przebudował materiał (czerń, jeden kolor, bez serifa). Resztę przyjęto z konsultacji, a z
propozycji Codeksa zachowano poziom zgodności jako jawną własność elementu, bo służy
prawdzie produktu.

Badanie kategorii (Raycast, Linear, Zed) dało następujący obraz:

- **Raycast** używa Intera 424 razy.
- **Linear** używa Intera 386 razy plus Berkeley Mono.
- **Zed** używa własnego zedMono 526 razy plus serif.
- Tła są prawie czarne i nigdy czyste.
- Dominujące rozmiary to 12 do 14 px.
- Żaden z tych produktów nie używa czystej bieli jako tekstu podstawowego.

Z tego wzięto: ciemny motyw jako domyślny, gęstość 12 do 14 px, parowanie sansa z
monospace i tekst nie-biały. Nie wzięto: Intera ani chłodnego metalu, bo to wspólny
mianownik kategorii. Jedno świadome odejście od badania: tło jest **czystą** czernią
(decyzja właściciela), co kategoria omija, a co wymusiło tonalne powierzchnie.

**Najważniejszy wniosek: żaden z tych trzech produktów nie pisze do konfiguracji
użytkownika, więc cała kategoria optymalizuje szybkość akcji, a ten produkt musi
optymalizować pewność przed akcją.** To uzasadnia wszystkie trzy ryzyka:

- diff jak korekta oszczędza czerwień na to, co znika z dysku (ryzyko 1),
- plakat z liczbami mówi, co się stanie, zanim użytkownik cokolwiek zatwierdzi (ryzyko 2),
- spis treści zamiast ikon odbiera interfejsowi „narzędziowy" wygląd launchera, który
  zachęca do szybkiego klikania (ryzyko 3).
