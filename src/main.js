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
const {
  accountsFile, ensureAccountsFile, loadAccounts, realAccounts,
  pickAccount, partitionName, lastAccountFile, readLastEmail, writeLastEmail,
} = require('./accounts')
const { buildLoginScript } = require('./auto-login')
const { serveAccount, registerLoginScript, clearLoginScript } = require('./account-bridge')
const { resolveRemoteAccount, renewLease, releaseLease } = require('./account-source')

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

// The offline fallback: reads the desktop pool (seeding a template on first
// run) and picks an account for this launch. Returns the plain credentials, or
// null when the pool holds nothing usable.
function pickLocalAccount(userData) {
  const file = accountsFile(app.getPath('desktop'))
  ensureAccountsFile(file)

  const { avoidRepeatLast, accounts } = loadAccounts(file)
  const real = realAccounts(accounts)
  if (!real.length) return null

  const lastFile = lastAccountFile(userData)
  const account = pickAccount(real, {
    lastEmail: readLastEmail(lastFile),
    avoidRepeatLast,
  })
  if (!account) return null

  writeLastEmail(lastFile, account.email)
  return { email: account.email, password: account.password }
}

// Picks the account for a window: a lease from the account server first, then
// its offline cache, then the desktop pool. Returns what the window needs — a
// stable per-account session partition plus the login script to inject — or
// null when there is no usable account anywhere, in which case the window
// opens normally with no auto-login.
async function chooseAccount() {
  const userData = app.getPath('userData')
  const remote = await resolveRemoteAccount(userData)
  const chosen = remote || pickLocalAccount(userData)
  if (!chosen) return null

  return {
    email: chosen.email,
    partition: partitionName(chosen.email),
    loginScript: buildLoginScript(chosen.email, chosen.password),
    // Only a live lease needs renewing; a cached or desktop account has none.
    lease: remote ? remote.lease : null,
  }
}

// Leases held by the windows of this run. They expire server-side after 30
// minutes, so they are renewed on a timer and handed back when the app quits.
const RENEW_INTERVAL_MS = 10 * 60 * 1000
const RELEASE_TIMEOUT_MS = 3000
const activeLeases = new Set()
let renewTimer = null

function trackLease(lease) {
  if (!lease) return
  activeLeases.add(lease)
  if (renewTimer) return

  renewTimer = setInterval(async () => {
    for (const held of activeLeases) {
      const expiresAt = await renewLease(held)
      // A lease the server no longer knows about (expired, or reclaimed) is
      // simply forgotten: the window keeps browsing on the session it already
      // has, and the next launch takes a fresh lease.
      if (expiresAt == null) activeLeases.delete(held)
      else held.expiresAt = expiresAt
    }
  }, RENEW_INTERVAL_MS)
  if (renewTimer.unref) renewTimer.unref()
}

async function releaseAllLeases() {
  const leases = [...activeLeases]
  activeLeases.clear()
  await Promise.all(leases.map((lease) => releaseLease(lease)))
}

function createWindow(dir, account) {
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const state = loadState(windowStateFile(app.getPath('userData')), displays)

  const win = new BrowserWindow({
    ...state,
    title: DISPLAY_NAME,
    // The preload puts the user scripts in place at document-start, so the page
    // is never painted before they have had their say.
    webPreferences: {
      ...RENDERER_PREFERENCES,
      preload: PRELOAD,
      ...(account ? { partition: account.partition } : {}),
    },
  })

  if (account) {
    const wcId = win.webContents.id
    registerLoginScript(wcId, account.loginScript)
    win.webContents.on('destroyed', () => clearLoginScript(wcId))
    trackLease(account.lease)
  }

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

app.whenReady().then(async () => {
  const dir = scriptsDir(app.getPath('userData'))
  ensureScriptDir(dir)
  serveScripts(dir)
  serveAccount()

  // Every window, including popups, keeps the original brand out of its title
  // bar. Registered before the first window is created so it catches it too.
  app.on('browser-window-created', (_event, win) => guardWindowTitle(win))

  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir) })
  // Resolving the account can take a network round trip, so the first window
  // waits for it — a window created without one would never auto-log-in.
  createWindow(dir, await chooseAccount())

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dir, await chooseAccount())
  })
})

// Handing the lease back on quit puts the account straight back in the pool.
// It is best-effort: a failure or a slow network must not keep the app alive,
// so the wait is capped and an unreleased lease is left to expire on its own.
app.on('before-quit', (event) => {
  if (!activeLeases.size) return
  event.preventDefault()
  const cap = new Promise((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS))
  Promise.race([releaseAllLeases(), cap]).finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
