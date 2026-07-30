const path = require('node:path')
const { app, shell, screen, BrowserWindow } = require('electron')

const { scriptsDir, windowStateFile, ensureScriptDir } = require('./paths')
const { serveScripts, pushCSS } = require('./script-bridge')
const { watchScripts } = require('./watcher')
const { loadState, trackWindow } = require('./window-state')
const { buildMenu } = require('./menu')
const { DISPLAY_NAME } = require('./brand')
const { guardWindowTitle } = require('./window-title')
const {
  HOME_URL,
  RENDERER_PREFERENCES,
  isInternal,
  isBrowsable,
  decideWindowOpen,
} = require('./navigation')

const PRELOAD = path.join(__dirname, 'preload.js')

// The menu bar, Dock, ⌘Tab switcher, and About panel all show the app's name,
// so it carries the brand too — rename it to 老猫 like everything else.
app.setName(DISPLAY_NAME)
// But keep the user data folder at the original path, so the rename does not
// orphan scripts created under the old name and the folder is the same whether
// run from source or packaged.
app.setPath('userData', path.join(app.getPath('appData'), 'Genspark'))

function openExternally(url) {
  if (isBrowsable(url)) shell.openExternal(url)
}

function createWindow(dir) {
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const state = loadState(windowStateFile(app.getPath('userData')), displays)

  const win = new BrowserWindow({
    ...state,
    title: DISPLAY_NAME,
    // The preload puts the user scripts in place at document-start, so the page
    // is never painted before they have had their say.
    webPreferences: { ...RENDERER_PREFERENCES, preload: PRELOAD },
  })

  trackWindow(win, windowStateFile(app.getPath('userData')))

  // Anything outside the site belongs in the user's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, PRELOAD)
    if (decision.action === 'deny') openExternally(url)
    return decision
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return
    event.preventDefault()
    openExternally(url)
  })

  // A stylesheet can be swapped in place; a script cannot be un-run, so the
  // page is reloaded and the preload injects the new version at document-start.
  const watcher = watchScripts(dir, (exts) => {
    // A change can land while the window is on its way out.
    if (win.isDestroyed()) return
    if (exts.has('js')) win.webContents.reload()
    else pushCSS(win.webContents, dir)
  })
  win.on('close', () => watcher.close())

  win.loadURL(HOME_URL)
  return win
}

app.whenReady().then(() => {
  const dir = scriptsDir(app.getPath('userData'))
  ensureScriptDir(dir)
  serveScripts(dir)

  // Every window, including popups, keeps the original brand out of its title
  // bar. Registered before the first window is created so it catches it too.
  app.on('browser-window-created', (_event, win) => guardWindowTitle(win))

  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir) })
  createWindow(dir)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dir)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
