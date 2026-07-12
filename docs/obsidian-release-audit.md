# Obsidian Release Audit Notes

Source docs:

- https://docs.obsidian.md/Home
- https://docs.obsidian.md/Reference/Manifest
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
- https://docs.obsidian.md/oo/plugin

Useful release reminders:

- Dev prereleases in this repository use the format `<base-version>-dev0.<n>`, for example `0.1.0-dev0.1`.
- Community plugin releases should attach `main.js`, `manifest.json`, and `styles.css` if styles are used.
- `main.js` should not be committed to the source repository.
- The official community release tag is expected to match the version in `manifest.json`.
- `manifest.json` requires `author`, `description`, `id`, `isDesktopOnly`, `minAppVersion`, `name`, and `version`.
- Plugin IDs should use lowercase letters and hyphens, should not contain `obsidian`, and should not end with `plugin`.
- Mobile-compatible plugins should avoid top-level Node/Electron APIs, global `fetch`, and hardcoded `.obsidian` paths.
- Prefer Obsidian APIs such as `requestUrl`, `Vault.configDir`, `FileManager.trashFile`, `Plugin.loadData`, and `Plugin.saveData`.
- README should disclose network use, server/account requirements, external file access, telemetry status, and closed-source components if any.
