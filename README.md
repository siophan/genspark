# Genspark Shell

A macOS desktop shell around [genspark.ai](https://www.genspark.ai/), with support for your own CSS and JavaScript injected into the page.

## Running

```sh
npm install
npm start
```

## Building a macOS app

```sh
npm run dist
```

Produces `.dmg` and `.zip` for arm64 and x64 in `dist/`. The build is unsigned, so the first launch needs a right-click → Open (or an approval in System Settings → Privacy & Security).

## User scripts

Scripts live in the app's user data folder:

```
~/Library/Application Support/Genspark/scripts/
```

Open it from the menu with **⌘,** (Genspark → Open Scripts Folder). The folder is created on first launch with a commented `example.css` and `example.js`.

- Every `*.css` file is injected into the page. **Saving takes effect immediately, without a reload.**
- Every `*.js` file runs after the page loads, in the page's **main world** — `window` and the site's own globals are directly available. **Saving reloads the page.**
- Files are injected in filename order, so a `10-` / `20-` prefix controls sequence.
- A script that throws is logged and skipped; it does not affect the page or the other scripts.

Scripts are read from disk on every injection, so a packaged app picks up edits without rebuilding.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘R / ⌘⇧R | Reload / force reload |
| ⌘[ / ⌘] | Back / forward |
| ⌘+ / ⌘- / ⌘0 | Zoom in / out / reset |
| ⌥⌘I | Toggle DevTools |
| ⌘, | Open the scripts folder |

## Notes

Links outside `genspark.ai` open in your default browser. The renderer keeps Electron's sandbox on (`contextIsolation`, no `nodeIntegration`), so page code has no Node access.

## Tests

```sh
npm test
```

Covers the pure logic — path setup, script collection and injection, the file-watch debounce, window-state fallbacks, and internal/external URL classification. The Electron wiring itself is verified by running the app.
