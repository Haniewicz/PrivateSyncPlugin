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
- widok boczny: Status, Urządzenia, Konflikty, Historia.

Na tym etapie lokalny indeks używa trwałego storage Obsidiana. SQLite warto dodać jako kolejny krok dla dużych vaultów.

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

## Prywatność i wymagania

- Plugin łączy się z prywatnym serwerem skonfigurowanym przez użytkownika.
- Plugin wymaga sparowania urządzenia i przechowuje lokalny `device_token` w ustawieniach pluginu.
- Plugin czyta pliki z vaulta, liczy ich hashe i wysyła zmienione pliki do skonfigurowanego serwera.
- Plugin pobiera zmiany z serwera i zapisuje je do vaulta.
- Plugin nie zawiera telemetrii, reklam ani zewnętrznych usług analitycznych.
- Plugin nie wysyła danych do żadnego domyślnego serwera autora; adres serwera ustawia użytkownik.
