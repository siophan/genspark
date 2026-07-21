const { app, shell, screen, BrowserWindow } = require('electron')

const { scriptsDir, windowStateFile, ensureScriptDir } = require('./paths')
const { createInjector } = require('./injector')
const { watchScripts } = require('./watcher')
const { loadState, trackWindow } = require('./window-state')
const { buildMenu } = require('./menu')

const { HOME_URL, isInternal, isBrowsable } = require('./navigation')

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

  const injector = createInjector(win.webContents, dir)
  injector.attach()

  const watcher = watchScripts(dir, (exts) => {
    if (exts.has('js')) injector.reloadForJS()
    else injector.reinjectCSS()
  })
  win.on('closed', () => {
    watcher.close()
    injector.dispose()
  })

  win.loadURL(HOME_URL)
  return win
}

app.whenReady().then(() => {
  const dir = scriptsDir(app.getPath('userData'))
  ensureScriptDir(dir)

  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir) })
  createWindow(dir)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dir)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
