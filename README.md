# Private Sync Plugin

Private Sync Plugin synchronizuje vault Obsidiana z prywatnym backendem Private Sync Server.

Backend serwera: https://github.com/Haniewicz/PrivateSyncServer

Plugin nie korzysta z domyslnej chmury autora i nie wysyla danych do zadnej uslugi zewnetrznej. Uzytkownik podaje w ustawieniach adres wlasnego serwera.

## Wymagania

- Obsidian `1.11.4` lub nowszy.
- Dzialajacy Private Sync Server dostepny przez HTTP albo HTTPS.
- Haslo serwera ustawione przez `syncctl setup`.
- Zalecane HTTPS, szczegolnie gdy laczysz sie spoza sieci lokalnej.

## Instalacja z release

1. Pobierz z GitHub Releases pliki:
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. W vaultcie Obsidiana utworz folder pluginu:

```bash
mkdir -p /sciezka/do/vaulta/.obsidian/plugins/private-sync
```

3. Skopiuj trzy pliki release do tego folderu.
4. W Obsidianie wlacz plugin w `Settings -> Community plugins`.
5. W ustawieniach pluginu wpisz:
   - `Server URL`, np. `https://twoj-serwer.example`,
   - nazwe urzadzenia,
   - typ urzadzenia,
   - haslo parowania serwera.
6. Kliknij `Pair`.
7. Jesli to pierwsze urzadzenie po `syncctl setup`, zostanie sparowane automatycznie. Kolejne urzadzenia wymagaja akceptacji na juz sparowanym urzadzeniu albo jednorazowego recovery pairing code z serwera.

## Uruchomienie developerskie

```bash
npm install
npm run build
```

Po buildzie skopiuj `manifest.json`, `main.js` i `styles.css` do folderu pluginu w vaultcie Obsidiana.

## Jak dziala synchronizacja

- Plugin utrzymuje lokalny indeks synchronizacji w danych pluginu Obsidiana.
- Zmiany wykrywane sa po hashach SHA-256, rozmiarze i czasie modyfikacji.
- Upload idzie batchami: najpierw metadane operacji, potem tresc plikow, a na koncu commit batcha.
- Pobieranie zmian opiera sie o `last_applied_revision` lokalnego vaulta.
- Kazde urzadzenie ma osobny `device_token`.
- Jeden lokalny vault Obsidiana jest trwale powiazany z jednym server-vaultem.
- Przy pierwszym powiazaniu plugin liczy lokalny manifest i pyta serwer o ocene bezpieczenstwa polaczenia.
- Pusty server-vault wymaga potwierdzenia uploadu `Local -> Remote`.
- Niepusty server-vault wymaga jawnej decyzji: `Remote -> Local`, `Local -> Remote` albo anulowanie.

## Widok Private Sync

Widok boczny zawiera zakladki:

- `Status` - stan lokalnych plikow, kolejki, konfliktow i ignorowanych plikow.
- `Devices` - sparowane urzadzenia, zmiana statusu i usuwanie urzadzen.
- `Vaults` - tworzenie, wybor, zmiana nazwy i usuwanie server-vaultow.
- `Plugins` - katalog community pluginow wykrytych na innych urzadzeniach.
- `Requests` - akceptacje nowych urzadzen i inne decyzje wymagajace potwierdzenia.
- `Conflicts` - konflikty plikow i narzedzia recznego wyboru wersji.
- `History` - historia rewizji pliku.
- `Events` - lokalne zdarzenia i logi bledow.
- `Storage` - podglad uzycia storage po stronie serwera i czyszczenie bezpiecznych danych tymczasowych.

## Community plugins

Synchronizacja community pluginow jest osobnym przelacznikiem pod ustawieniami Obsidiana.

Private Sync:

- skanuje lokalne community pluginy,
- zapisuje na serwerze ich ID, nazwe, wersje i autora,
- synchronizuje JSON-owe pliki ustawien z folderu danego pluginu,
- pomija `manifest.json`,
- nie synchronizuje kodu pluginow (`main.js`, `styles.css`),
- nie synchronizuje samego pluginu `private-sync`.

W zakladce `Plugins` brakujacy plugin mozna otworzyc w oficjalnym installerze Obsidiana przez `Open`. Gdy plugin jest juz lokalnie zainstalowany, widoczne sa akcje `Enable`, `Disable`, `Uninstall` oraz `Apply Server Settings`.

## Ustawienia Obsidiana

Synchronizacja wybranych ustawien Obsidiana jest wlaczona domyslnie i moze zostac wylaczona w ustawieniach pluginu.

Plugin synchronizuje ustawienia kreatorow notatek:

- daily notes,
- templates,
- unique note creator,
- Zettelkasten prefixer.

Nie synchronizuje workspace ani calego katalogu konfiguracji w ciemno.

## Duze pliki i zalaczniki

Plugin ma zabezpieczenia przed zapychaniem synchronizacji duzymi plikami:

- nie hashuje ponownie pliku, jesli indeks ma status `synced`, a `mtime` i rozmiar nie ulegly zmianie,
- ma przelacznik synchronizacji zalacznikow,
- ma limit automatycznej synchronizacji pliku, domyslnie `100 MB`,
- pliki powyzej limitu sa oznaczane jako `ignored`,
- pliki powyzej progu duzego pliku, domyslnie `10 MB`, sa wysylane i pobierane przez chunked transfer,
- domyslny chunk ma `5 MB`.

API Obsidiana nadal wymaga od pluginu odczytania zawartosci zmienionego pliku jako `ArrayBuffer`, zanim mozna policzyc hash i rozpoczac upload. Dla bardzo duzych zalacznikow najlepsza ochrona pozostaje limit automatycznej synchronizacji.

## Szyfrowanie

Plugin zawiera obsluge klientowego szyfrowania wybranych notatek i metadanych kluczy szyfrowania. Haslo szyfrowania nie jest haslem serwera. Reset hasla serwera nie odzyskuje ani nie zmienia kluczy szyfrowania danych.

## Mobile

Plugin jest przygotowany do podstawowego dzialania w Obsidian Mobile:

- nie uzywa Node.js, Electron ani `FileSystemAdapter` w kodzie pluginu,
- uzywa `requestUrl` do komunikacji HTTP,
- uzywa `Vault.configDir` zamiast stalej sciezki `.obsidian`,
- usuwa pliki przez `FileManager.trashFile`,
- po starcie i gotowosci layoutu wykonuje synchronizacje,
- po powrocie aplikacji do widoku aktywnego wykonuje reconnect WebSocket i synchronizacje,
- po `focus`, `pageshow`, `online` i `visibilitychange` do `visible` sprawdza zmiany przez API,
- przy przejsciu aplikacji w tlo zamyka WebSocket i nie zaklada dzialania w tle.

WebSocket na mobile jest kanalem pomocniczym dla eventow, nie zrodlem prawdy. Po kazdej aktywacji aplikacji plugin pobiera stan przez HTTP API na podstawie `last_applied_revision`.

## Prywatnosc

- Plugin laczy sie tylko z serwerem skonfigurowanym przez uzytkownika.
- Plugin wymaga sparowania urzadzenia i przechowuje lokalny `device_token`.
- Plugin czyta pliki z vaulta, liczy ich hashe i wysyla zmienione pliki do skonfigurowanego serwera.
- Plugin pobiera zmiany z serwera i zapisuje je do vaulta.
- Plugin nie zawiera telemetrii, reklam ani zewnetrznych uslug analitycznych.
- Plugin nie wysyla danych do zadnego domyslnego serwera autora.
