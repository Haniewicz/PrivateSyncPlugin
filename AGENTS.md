# Codex Instructions

## Branch policy

- Default development branch: `dev`.
- If work starts on any branch other than `dev`, switch to `dev` before making changes.
- Do not make ordinary plugin changes directly on the main branch (`master` in this repository).
- A full release on the main branch is performed only when the user explicitly asks for a full release.
- For a full release:
  - switch to `master`,
  - merge `dev`,
  - build and audit the plugin,
  - then create the release commit/tag/release from `master`.
- Dev releases are created from `dev` and should be marked as prerelease on GitHub.
- After every plugin fix/change committed on `dev`, create a new dev prerelease.
- Dev release versions must use the format `<base-version>-dev0.<n>`, for example `0.1.0-dev0.1`, `0.1.0-dev0.2`.
- Do not use dev release formats such as `<base-version>-dev.<n>`.

## Obsidian audit policy

Before every plugin release, audit the plugin against the current official Obsidian Developer Documentation:

- https://docs.obsidian.md/Home
- https://docs.obsidian.md/Reference/Manifest
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin

Check at minimum:

- `manifest.json` fields are valid.
- `main.js` is not committed to the repo and is only attached to releases.
- release assets include `main.js`, `manifest.json`, and `styles.css` when present.
- no default hotkeys are defined.
- no hardcoded `.obsidian` path is used; use `Vault.configDir`.
- no `fetch` or `axios.get` in mobile-compatible code; use `requestUrl`.
- no direct `vault.delete`; use `FileManager.trashFile`.
- no top-level Node/Electron APIs when `isDesktopOnly` is `false`.
- README discloses network use, account/server requirements, and external file access.
- dependencies are minimal and lockfile is committed.
- `npm run build` passes.
