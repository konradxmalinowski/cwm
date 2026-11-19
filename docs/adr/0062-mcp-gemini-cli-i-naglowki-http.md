# ADR 0062: serwery MCP w Gemini CLI i nagłówki HTTP jako odniesienia

Status: zaakceptowane
Data: 2026-11-19
Uzupełnia: ADR 0061 (reguły bezpieczeństwa i zakresów MCP)
Dotyczy: ADR 0012 (`WriteGate`), ADR 0055 (Gemini CLI), ADR 0059 (projekty), ADR 0060 (jednorazowy znacznik zgody)

## Kontekst

ADR 0061 odblokował jawny eksport serwerów MCP między Claude Code i Codeksem, a dwie rzeczy zostawił otwarte: Gemini CLI
(serwery MCP w `settings.json`, globalnie i w projekcie) oraz nagłówki HTTP. Serwer HTTP z nagłówkami był odmową, bo
biblioteka trzymała same nazwy nagłówków, a serwer bez nich zwykle nie działa. Wszystkie trzy narzędzia umieją jednak
wziąć wartość nagłówka ze zmiennej środowiskowej, więc nagłówek da się przenieść tak samo jak zmienną `env`: jako
odniesienie, nigdy jako wartość.

Formaty, na których stoi ta decyzja. [D] znaczy: potwierdzone w dokumentacji narzędzia (stan z 2026-11-19), [?] znaczy:
przyjęte, niepotwierdzone.

| Narzędzie | Pole | Znaczenie | Stan |
|---|---|---|---|
| Gemini CLI | `mcpServers` w `~/.gemini/settings.json` (użytkownik) i `.gemini/settings.json` w korzeniu projektu | serwery MCP; `gemini mcp add` pisze do jednego z tych plików zależnie od zakresu | [D] |
| Gemini CLI | `command`, `args`, `env`, `cwd` | serwer stdio | [D] |
| Gemini CLI | `url` | serwer SSE | [D] |
| Gemini CLI | `httpUrl` | serwer streamable HTTP; przy kilku polach pierwszeństwo `httpUrl`, `url`, `command` | [D] |
| Gemini CLI | `headers` | nagłówki dla `url` i `httpUrl` | [D] |
| Gemini CLI | `timeout`, `includeTools`, `excludeTools`, `description` | bez odpowiednika w bibliotece | [D] |
| Gemini CLI | `trust` | `true` pomija wszystkie potwierdzenia wywołań narzędzi tego serwera | [D] |
| Gemini CLI | `$NAZWA` i `${NAZWA}` w `env` | rozwijane przy starcie serwera (dokumentacja MCP) | [D] |
| Gemini CLI | `$NAZWA`, `${NAZWA}`, `${NAZWA:-domyślna}` w każdym napisie `settings.json`, także w `headers` | rozwijane przy wczytaniu ustawień (dokumentacja configuration); strona o MCP opisuje rozwijanie tylko w `env` | [D] |
| Gemini CLI | pole `type` | nieopisane w dokumentacji; transport wynika z pola adresu | [?] |
| Claude Code | `headers` z `${NAZWA}`, np. `"Authorization": "Bearer ${API_KEY}"` | rozwijane w `command`, `args`, `env`, `url` i `headers`; zmienne z danymi logowania samego Claude Code i dostawców chmury czyta w `url` i `headers` jako puste | [D] |
| Codex | `bearer_token_env_var = "NAZWA"` | zmienna z tokenem wysyłanym w `Authorization` jako `Bearer` | [D] |
| Codex | `env_http_headers = { "X-Nagłówek" = "NAZWA" }` | nazwa nagłówka na nazwę zmiennej, wartość ze środowiska | [D] |
| Codex | `http_headers = { "X-Nagłówek" = "wartość" }` | wartości wpisane wprost | [D] |

Ponieważ Gemini CLI rozwija zmienne w nagłówkach, eksport nagłówków do Gemini CLI jest dozwolony. Gdyby dokumentacja
tego nie mówiła, nagłówki do Gemini CLI byłyby odmową z tym powodem.

## Rozważane opcje

**Kopiowanie wartości nagłówków.** Odrzucone z tego samego powodu co kopiowanie `env` w ADR 0061: token trafiłby do
biblioteki, a z eksportem do `.mcp.json` albo `.gemini/settings.json` do Gita.

**Mapowanie nazwy nagłówka na zmienną podane ręcznie w formularzu.** Odrzucone na teraz: biblioteka nie ma formularza
edycji serwera MCP (ADR 0061, otwarte). Odniesienie jest brane ze źródła, a serwer z wartością wpisaną wprost
użytkownik poprawia w narzędziu źródłowym i importuje ponownie.

**Nagłówek jako odniesienie do zmiennej, z opcjonalnym schematem, ze źródła.** Wybrane.

## Decyzja

1. **Model nagłówka.** `headers` w `toolSetting.value` to lista `{ name, ref, scheme }`. `scheme` to `Bearer`, `Basic`
   albo `null` (sama wartość zmiennej). `ref` to nazwa zmiennej u użytkownika albo `null`, gdy źródło miało wartość
   wpisaną wprost. Lista samych nazw z ADR 0061 jest nadal czytana: każda nazwa to nagłówek bez odniesienia.
   **Wartości nagłówków nie trafiają do biblioteki nigdy.**
2. **Import nagłówków.** Claude Code: wartość `${X}`, `Bearer ${X}` albo `Basic ${X}` daje `ref = X`; Gemini CLI tak
   samo, a dodatkowo `$X`. Każda inna wartość (token, `${X:-domyślna}`, tekst wokół odniesienia) zostawia samą nazwę z
   ostrzeżeniem, a wartość jest pomijana. Codex: `bearer_token_env_var` to `Authorization` ze schematem `Bearer`,
   `env_http_headers` to nagłówki z `ref` równym nazwie zmiennej, `http_headers` daje same nazwy (wartości są wpisane
   wprost). Nazwa nagłówka spoza tokenu HTTP z RFC 7230 (spacja, dwukropek, CR, LF, znak sterujący, ponad 128 znaków)
   albo ze znakiem `$` odrzuca cały serwer przy imporcie: taki napis nie trafia do biblioteki. **Odniesienie, które
   samo wygląda na token** (`refLooksLikeToken`: `textHasSecret`, czyli znane prefiksy i długi ciąg o wysokiej
   entropii, albo ciąg szesnastkowy od 32 znaków, albo UUID), np. `bearer_token_env_var = "ghp_..."` albo
   `"Bearer ${ghp_...}"`, jest traktowane jak wartość wpisana wprost: zostaje sama nazwa nagłówka z ostrzeżeniem, a
   tekst nie trafia do biblioteki. To samo dotyczy odniesień w `env`: zmienna zostaje pod własną nazwą.
3. **Eksport nagłówków.** Serwer http albo sse przechodzi eksport tylko wtedy, gdy **każdy** nagłówek ma odniesienie:
   nagłówek bez `ref` to odmowa z powodem (serwer bez nagłówka nie zadziała, a wartości nie kopiujemy). Odmową są też:
   nazwa spoza tokenu HTTP, nagłówek powtórzony (bez rozróżnienia wielkości liter), ponad 32 nagłówki, nagłówki
   sterujące połączeniem albo niosące sesję (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`,
   `Upgrade`, `TE`, `Trailer`, `Expect`, `Cookie`, `Proxy-Authorization`, `Proxy-Connection`), `ref` o niepoprawnej
   nazwie, wyglądający na token (`refLooksLikeToken`, powód bez wartości), z listy `isSettingsEnvNameDenied` albo z
   prefiksem danych logowania narzędzi, chmury i popularnych usług (`ANTHROPIC_`, `CLAUDE_`, `OPENAI_`, `CODEX_`,
   `GEMINI_`, `GOOGLE_`, `GCLOUD_`, `AWS_`, `AZURE_`, `GITHUB_`, `GH_`, `GITLAB_`, `NPM_`, `HF_`, `HUGGING_FACE_`,
   `SLACK_`, `DOCKER_`, `DIGITALOCEAN_`, `CLOUDFLARE_`, `CF_`, `STRIPE_`, `TWILIO_`, `SENTRY_`). Ta reguła rozszerza
   ochronę Claude Code: nagłówek wysyła wartość pod adres serwera, więc odniesienie do tokenu innej usługi byłoby
   wyciekiem. Nagłówek, którego zmienna ma nazwę sekretu (`nameLooksSecret`, np. `ACME_API_KEY`), przechodzi, ale
   podgląd potwierdzenia ma przy serwerze osobne zdanie "Nagłówek X wyśle wartość zmiennej Y, która wygląda na dane
   logowania, do hosta H" (`headerNotices`), oznaczone jako dane logowania. Zapis:
   - Claude Code i Gemini CLI: `"Nazwa": "${REF}"` albo `"Nazwa": "Bearer ${REF}"` (`Basic` tak samo).
   - Codex: `Authorization` ze schematem `Bearer` to `bearer_token_env_var = "REF"`, nagłówek bez schematu to wpis w
     `env_http_headers`. `Basic` i `Bearer` w innym nagłówku niż `Authorization` to odmowa, bo Codex nie ma odniesienia
     z prefiksem. `http_headers` aplikacja nie zapisuje nigdy.
   Nagłówki serwera stdio są pomijane z ostrzeżeniem. Podgląd potwierdzenia pokazuje nagłówki jako
   `Nazwa: Bearer ${REF}`, a wycinek pliku zostawia odniesienia i nazwy zmiennych z `env_http_headers` widoczne.
4. **Gemini CLI: import.** Nowy root `mcp` Gemini CLI: `~/.gemini/settings.json` (z `GEMINI_CLI_HOME` jak inne rooty
   tego narzędzia) i `.gemini/settings.json` w projekcie z rejestru (ADR 0059). To ten sam plik co root hooków, ale osobny
   root z innym `rootId`; z pliku czytany jest wyłącznie klucz `mcpServers`. Transport wynika z pola: `command` to stdio,
   `url` to sse, `httpUrl` to http. Serwer z więcej niż jednym z tych pól jest pomijany z powodem (Gemini wybrałby jedno
   według pierwszeństwa, a użytkownik mógłby nie wiedzieć które). Te same reguły odrzucenia co w ADR 0061 (sekret,
   token, niewidoczny znak, `$` w poleceniu, argumencie i adresie, nazwa serwera). **`trust` nie jest importowany
   nigdy**, także jako nazwa pola w `unmappedKeys`; dla `trust: true` import dodaje ostrzeżenie. `cwd`, `timeout`,
   `includeTools`, `excludeTools` i inne pola trafiają do `unmappedKeys` jako same nazwy z wartością `null`.
5. **Gemini CLI: eksport.** Wpis bez `trust`, `cwd` i limitów czasu: `{ command, args, env }` dla stdio, `{ httpUrl,
   headers }` dla http, `{ url, headers }` dla sse; zmienne `env` jako `"${REF}"`. Pola istniejącego wpisu, które
   zmieniają uprawnienia serwera, nie giną po cichu:
   - `trust: true` przy innej definicji: powód konfliktu mówi, że zastąpienie je usunie, a po decyzji wpis planu ma
     ostrzeżenie. Przy tej samej definicji nic nie jest zapisywane (wpis `unchanged`), ale plan ostrzega, że serwer ma w
     pliku `trust: true` i Gemini CLI nie pyta o wywołania jego narzędzi; aplikacja nie usuwa tego pola bez zmiany
     definicji.
   - `includeTools` i `excludeTools` tylko zawężają narzędzia serwera, więc zastąpienie je **zachowuje** (lista napisów
     przepisana z obecnego wpisu), a powód konfliktu i ostrzeżenie wpisu to mówią. Porównanie definicji ich nie
     uwzględnia, więc ponowny plan daje `unchanged`.
   Zapis idzie istniejącym mechanizmem `json-key` z ADR 0061
   (klucz `mcpServers`, porównanie drzewa poza kluczem i w kluczu), wspólnym z Claude Code. Hooki Gemini CLI też leżą
   w `settings.json`, a jeden plan nie może zapisać jednego pliku dwoma wpisami: plan z hookami i serwerami MCP Gemini
   CLI odmawia serwerów MCP z prośbą o osobny plan.
6. **Zakres Gemini CLI.** Jak `.mcp.json`: serwer z `.gemini/settings.json` jest przypięty do projektu i trafia tylko do
   projektu, z którego pochodzi (w Claude Code albo w Gemini CLI), serwer globalny trafia do projektu tylko z
   "Dołącz elementy globalne" i osobnym potwierdzeniem `mcpGlobalToProject`. Reguły zakresu są w core
   (`scopeRefusal`) i niezależnie w main (`planScopeViolation`), bez zmian w kodzie zakresu. Kreator eksportu ma przy
   każdym projekcie drugi cel "Projekt (Gemini CLI, serwery MCP)"; inne elementy Gemini CLI nie mają rootów w projekcie
   i są odmawiane.
7. **Potwierdzenie i Historia.** Bez zmian w mechanizmie z ADR 0061: plan zapisujący serwer MCP do Gemini CLI dostaje
   jednorazowy znacznik, a `ExportService.apply` niezależnie odmawia bez `mcpConfirmed`. Cofnięcie z Historii zapisu do
   `settings.json` Gemini CLI jest zablokowane (`MCP_ROLLBACK_REFUSAL`). Nazwa pliku tu nie wystarcza, a rodzaj roota
   też nie: hooki Gemini CLI piszą **ten sam fizyczny** `settings.json` z innego roota, a cofnięcie zapisu hooków
   przywróciłoby cały plik, razem z `mcpServers` z chwili kopii, bez potwierdzenia MCP. Dlatego `HistoryService`
   dostaje port `mcpTarget`, który decyduje po rozwiązanej ścieżce: root kopii pisze plik będący celem MCP, gdy jego
   ścieżka jest ścieżką któregoś roota rodzaju `mcp` z warstwy lokalizacji (`~/.claude.json`, `settings.json` Gemini
   CLI), albo gdy to root `mcp` projektu (`FsProjectCatalog.kindOf`: `.mcp.json`, `.gemini/settings.json`). W efekcie
   cofnięcie zapisu hooków Gemini CLI z Historii też jest zablokowane. Blokada działa także wtedy, gdy elementu nie ma
   już w bibliotece.
8. **Synchronizacja, ZIP i profile.** Nadal zablokowane dla serwerów MCP wszystkich trzech narzędzi (ADR 0061, punkt 8).
9. **Porównanie z celem.** Serwer w pliku celu jest "ten sam", gdy zgadzają się transport, adres, zmienne i nagłówki
   (nazwa bez wielkości liter, schemat i zmienna); polecenie i argumenty liczą się tylko dla stdio. Różnica nagłówków
   jest opisana w powodzie konfliktu nazwami i odniesieniami.

## Konsekwencje

Serwer HTTP z nagłówkiem autoryzacji przechodzi między trzema narzędziami, jeżeli źródło trzyma odniesienie do zmiennej.
Serwer z tokenem wpisanym wprost nadal nie przejdzie: to świadoma cena za to, że biblioteka nie trzyma sekretów. Gemini
CLI ma te same reguły co Claude Code, a `trust` nie przechodzi w żadną stronę.

Koszty, na które się godzimy:

- Serwer z nagłówkiem bez odniesienia trzeba poprawić w narzędziu źródłowym i zaimportować ponownie; biblioteka nie ma
  formularza edycji serwera.
- `Basic` do Codeksa jest odmową. Kto potrzebuje, może wpisać do zmiennej całą wartość `Basic ...` i użyć nagłówka bez
  schematu.
- Zmienne z danymi logowania narzędzi, chmury i popularnych usług (np. `GITHUB_TOKEN`) nie przechodzą do nagłówków,
  także gdy użytkownik celowo ich używa (serwer MCP GitHuba z `GITHUB_TOKEN` też); obejście to własna nazwa zmiennej
  z tą samą wartością.
- Hooki i serwery MCP Gemini CLI wymagają osobnych planów.
- Zapisu hooków Gemini CLI nie da się już cofnąć z Historii (ten sam `settings.json` co serwery MCP); kopia zapasowa
  pliku jest w katalogu danych aplikacji, a hooki zmienia się w narzędziu albo kolejnym eksportem.
- Odniesienie, które wygląda na token, jest odrzucane także wtedy, gdy to naprawdę nazwa zmiennej o takim kształcie
  (np. długi ciąg szesnastkowy); obejście to zwykła nazwa zmiennej.
- Zapis do `.gemini/settings.json` projektu, którego katalog `.gemini` nie istnieje, podlega tym samym regułom bramki
  zapisu co inne rooty projektu.

## Otwarte (poza tym zakresem)

- Formularz edycji serwera MCP z mapowaniem nazwy nagłówka na zmienną podanym przez użytkownika.
- `headersHelper` Claude Code, `oauth` i `authProviderType` Gemini CLI, `auth` Codeksa.
- Pole `type` w Gemini CLI, gdy trafi do dokumentacji.
- Systemowy `settings.json` Gemini CLI (`/etc/gemini-cli/settings.json` i odpowiedniki), który nadpisuje ustawienia
  użytkownika.
