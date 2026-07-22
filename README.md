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
- Every `*.js` file runs at **document-start** — before the page has parsed a single tag, and before the site's own scripts. That is what lets a script rewrite the page without the original content flashing up first. It runs in the page's **main world**, so `window` and the site's own globals are directly available. **Saving reloads the page.**
- Because scripts run before `<body>` exists, do your work from a `MutationObserver` rather than assuming the DOM is there. See the example below.
- Files are injected in filename order, so a `10-` / `20-` prefix controls sequence.
- A script that throws is logged and skipped; it does not affect the page or the other scripts.

Scripts are read from disk on every injection, so a packaged app picks up edits without rebuilding.

### Ready-made scripts

[`examples/rename-to-laomao.js`](examples/rename-to-laomao.js) renames the Genspark brand to 老猫 throughout the page — visible text, the window title, and label attributes such as `placeholder` and `aria-label`. Code blocks, script bodies, and what you have typed into a field are left untouched. Copy it into the scripts folder to use it:

```sh
cp examples/rename-to-laomao.js ~/Library/Application\ Support/Genspark/scripts/
```

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
npm test             # unit tests, plain Node
npm run test:early   # document-start injection in a real Electron page
npm run test:rename  # the rename script against a real Electron page
```

The unit tests cover path setup, script collection, the file-watch debounce, window-state fallbacks, and internal/external URL classification.

The integration runs load real pages in Electron. `test:early` proves the timing that matters: the user script runs before the page's own inline script, before `<body>` exists, and in the same world the page's scripts see — plus CSS hot-swapping without a reload. `test:rename` checks the rename script, including that the original name is never present in the parsed document.
