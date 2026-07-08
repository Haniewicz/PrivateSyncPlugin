# Private Sync Plugin

Pierwotna wersja pluginu Obsidiana do prywatnego serwera synchronizacji.

## Uruchomienie developerskie

```bash
npm install
npm run build
```

Skopiuj `manifest.json`, `main.js` i `styles.css` do folderu pluginu w vaultcie Obsidiana.

## MVP

- ustawienia adresu serwera, hasła do parowania, nazwy i typu urządzenia,
- pierwsze parowanie urządzenia i zapis `device_token` w ustawieniach pluginu,
- lokalny indeks plików w `data.json`,
- wykrywanie zmian po hashach SHA-256,
- offline queue z `client_change_id`,
- batch upload do serwera,
- pobieranie zmian od `last_applied_revision`,
- wybór albo tworzenie server-vaulta przed trwałym powiązaniem lokalnego vaulta,
- widok boczny: Status, Urządzenia, Konflikty, Historia.

Na tym etapie lokalny indeks używa trwałego storage Obsidiana. SQLite warto dodać jako kolejny krok dla dużych vaultów.

Każdy lokalny vault Obsidiana wskazuje jeden stały server-vault. Po powiązaniu lokalnego vaulta wybór server-vaulta jest blokowany, żeby uniknąć przypadkowego mieszania lub nadpisywania plików między różnymi vaultami.

Przy pierwszym powiązaniu plugin liczy lokalny manifest plików i pyta serwer o ocenę bezpieczeństwa. Pusty server-vault wymaga potwierdzenia uploadu `Local -> Remote`. Niepusty server-vault pokazuje ocenę ryzyka i wymaga jawnej decyzji: `Remote -> Local`, `Local -> Remote` albo anulowanie. Po powiązaniu normalny sync działa już tylko z tym jednym server-vaultem.

## Duże pliki i załączniki

Plugin ma podstawowe zabezpieczenia przed zapychaniem synchronizacji dużymi plikami:

- nie hashuje ponownie pliku, jeśli w indeksie ma status `synced`, a `mtime` i rozmiar nie uległy zmianie,
- ma przełącznik synchronizacji załączników,
- ma limit automatycznej synchronizacji pliku, domyślnie `100 MB`,
- pliki powyżej limitu są oznaczane jako `ignored` i nie trafiają automatycznie do kolejki uploadu,
- pliki powyżej progu dużego pliku, domyślnie `10 MB`, są wysyłane i pobierane przez chunked transfer,
- domyślny chunk ma `5 MB`.

Aktualne limity są dostępne w ustawieniach pluginu:

- `Sync attachments`,
- `Max automatic file size`,
- `Large file threshold`,
- `Chunk size`.

Ważne ograniczenie: API Obsidiana nadal wymaga od pluginu odczytania zawartości zmienionego pliku jako `ArrayBuffer`, zanim można policzyć hash i rozpocząć upload. Chunked transfer zmniejsza ryzyko po stronie sieci i serwera, ale nie jest jeszcze pełnym streamingiem z dysku lokalnego. Dla bardzo dużych załączników najlepszą ochroną pozostaje limit automatycznej synchronizacji.

## Mobile

Plugin jest przygotowany do podstawowego działania w Obsidian Mobile:

- nie używa Node.js, Electron ani `FileSystemAdapter` w kodzie pluginu,
- używa `requestUrl` do komunikacji HTTP,
- używa `Vault.configDir` zamiast stałej ścieżki `.obsidian`,
- usuwa pliki przez `FileManager.trashFile`,
- po starcie i gotowości layoutu wykonuje synchronizację,
- po powrocie aplikacji do widoku aktywnego wykonuje reconnect WebSocket i synchronizację,
- po `focus`, `pageshow`, `online` i `visibilitychange` do `visible` sprawdza zmiany przez API,
- przy przejściu aplikacji w tło zamyka WebSocket i nie zakłada działania w tle.

WebSocket na mobile jest traktowany jako kanał pomocniczy dla eventów, nie jako źródło prawdy. Po każdej aktywacji aplikacji plugin pobiera stan przez HTTP API na podstawie `last_applied_revision`.

## Prywatność i wymagania

- Plugin łączy się z prywatnym serwerem skonfigurowanym przez użytkownika.
- Plugin wymaga sparowania urządzenia i przechowuje lokalny `device_token` w ustawieniach pluginu.
- Plugin czyta pliki z vaulta, liczy ich hashe i wysyła zmienione pliki do skonfigurowanego serwera.
- Plugin pobiera zmiany z serwera i zapisuje je do vaulta.
- Plugin nie zawiera telemetrii, reklam ani zewnętrznych usług analitycznych.
- Plugin nie wysyła danych do żadnego domyślnego serwera autora; adres serwera ustawia użytkownik.
