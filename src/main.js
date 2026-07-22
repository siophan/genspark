const path = require('node:path')
const { app, shell, screen, BrowserWindow } = require('electron')

const { scriptsDir, windowStateFile, ensureScriptDir } = require('./paths')
const { serveScripts, pushCSS } = require('./script-bridge')
const { watchScripts } = require('./watcher')
const { loadState, trackWindow } = require('./window-state')
const { buildMenu } = require('./menu')
const { HOME_URL, isInternal, isBrowsable } = require('./navigation')

// Fixes the user data folder to ~/Library/Application Support/Genspark, so the
// scripts live in the same place when run from source and when packaged.
app.setName('Genspark')

function openExternally(url) {
  if (isBrowsable(url)) shell.openExternal(url)
}

function createWindow(dir) {
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const state = loadState(windowStateFile(app.getPath('userData')), displays)

  const win = new BrowserWindow({
    ...state,
    title: 'Genspark',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Puts the user scripts in place at document-start, so the page is never
      // painted before they have had their say.
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  trackWindow(win, windowStateFile(app.getPath('userData')))

  // Anything outside the site belongs in the user's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: 'allow' }
    openExternally(url)
    return { action: 'deny' }
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

  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir) })
  createWindow(dir)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dir)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
