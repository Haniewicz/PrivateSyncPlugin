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
