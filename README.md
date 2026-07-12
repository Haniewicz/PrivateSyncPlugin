# Private Sync Plugin

Private Sync Plugin synchronizes an Obsidian vault with a self-hosted Private Sync Server backend.

Server backend: https://github.com/Haniewicz/PrivateSyncServer

The plugin does not use an author-hosted default cloud and does not send data to any external service by default. The user provides the URL of their own server in the plugin settings.

## Requirements

- Obsidian `1.11.4` or newer.
- A working Private Sync Server reachable over HTTP or HTTPS.
- A server password configured with `syncctl setup`.
- HTTPS is recommended, especially when connecting from outside the local network.

## Installation From Release

1. Download these files from GitHub Releases:
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. Create the plugin folder in your Obsidian vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/private-sync
```

3. Copy the three release files into that folder.
4. Enable the plugin in Obsidian under `Settings -> Community plugins`.
5. In the plugin settings, enter:
   - `Server URL`, for example `https://your-server.example`,
   - device name,
   - device type,
   - server pairing password.
6. Click `Pair`.
7. If this is the first device after `syncctl setup`, it will be paired automatically. Additional devices require approval on an already paired device or a one-time recovery pairing code from the server.

## Developer Build

```bash
npm install
npm run build
```

After the build, copy `manifest.json`, `main.js`, and `styles.css` into the plugin folder in your Obsidian vault.

## How Synchronization Works

- The plugin keeps a local synchronization index in Obsidian plugin data.
- Changes are detected by SHA-256 hashes, size, and modification time.
- Uploads happen in batches: operation metadata first, then file contents, then the batch commit.
- Downloads are based on the local vault's `last_applied_revision`.
- Each device has its own `device_token`.
- One local Obsidian vault is permanently linked to one server vault.
- On the first link, the plugin calculates a local manifest and asks the server to assess connection safety.
- An empty server vault requires confirmation for `Local -> Remote` upload.
- A non-empty server vault requires an explicit decision: `Remote -> Local`, `Local -> Remote`, or cancel.

## Private Sync View

The sidebar view contains these tabs:

- `Status` - local file state, queues, conflicts, and ignored files.
- `Devices` - paired devices, status changes, and device removal.
- `Vaults` - creating, selecting, renaming, and deleting server vaults.
- `Plugins` - community plugin catalog detected on other devices.
- `Requests` - new device approvals and other decisions requiring confirmation.
- `Conflicts` - file conflicts and tools for manually choosing a version.
- `History` - file revision history.
- `Events` - local events and error logs.
- `Storage` - server-side storage usage preview and cleanup of safe temporary data.

## Community Plugins

Community plugin synchronization is a separate toggle in the Obsidian settings.

Private Sync:

- scans local community plugins,
- stores their ID, name, version, and author on the server,
- synchronizes JSON settings files from each plugin folder,
- skips `manifest.json`,
- does not synchronize plugin code (`main.js`, `styles.css`),
- does not synchronize the `private-sync` plugin itself.

In the `Plugins` tab, a missing plugin can be opened in Obsidian's official installer with `Open`. When a plugin is already installed locally, the available actions are `Enable`, `Disable`, `Uninstall`, and `Apply Server Settings`.

## Obsidian Settings

Synchronization of selected Obsidian settings is enabled by default and can be disabled in the plugin settings.

The plugin synchronizes settings for note creators:

- daily notes,
- templates,
- unique note creator,
- Zettelkasten prefixer.

It does not synchronize the workspace or the entire configuration directory blindly.

## Large Files And Attachments

The plugin includes safeguards against clogging synchronization with large files:

- it does not hash a file again if the index has status `synced` and `mtime` and size have not changed,
- it has an attachment synchronization toggle,
- it has an automatic file synchronization limit, default `100 MB`,
- files above the limit are marked as `ignored`,
- files above the large-file threshold, default `10 MB`, are uploaded and downloaded with chunked transfer,
- the default chunk size is `5 MB`.

The Obsidian API still requires the plugin to read changed file contents as an `ArrayBuffer` before it can calculate the hash and start the upload. For very large attachments, the automatic synchronization limit remains the best protection.

## Encryption

The plugin includes client-side encryption support for selected notes and encryption key metadata. The encryption password is not the server password. Resetting the server password does not recover or change data encryption keys.

## Mobile

The plugin is prepared for basic operation in Obsidian Mobile:

- it does not use Node.js, Electron, or `FileSystemAdapter` in plugin code,
- it uses `requestUrl` for HTTP communication,
- it uses `Vault.configDir` instead of the hardcoded `.obsidian` path,
- it deletes files through `FileManager.trashFile`,
- after startup and layout readiness, it runs synchronization,
- when the app returns to the active view, it reconnects WebSocket and synchronizes,
- on `focus`, `pageshow`, `online`, and `visibilitychange` to `visible`, it checks changes through the API,
- when the app goes into the background, it closes WebSocket and does not assume background execution.

On mobile, WebSocket is an auxiliary channel for events, not the source of truth. On every app activation, the plugin fetches state through the HTTP API based on `last_applied_revision`.

## Privacy

- The plugin connects only to the server configured by the user.
- The plugin requires device pairing and stores a local `device_token`.
- The plugin reads files from the vault, calculates their hashes, and uploads changed files to the configured server.
- The plugin downloads changes from the server and writes them to the vault.
- The plugin does not include telemetry, ads, or external analytics services.
- The plugin does not send data to any default server hosted by the author.

<details>
<summary>Polski</summary>

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

</details>
