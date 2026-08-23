const path = require('node:path')
const nodeNet = require('node:net')
const { app, shell, screen, BrowserWindow } = require('electron')

// Node 的 happy-eyeballs 默认只给每个候选地址 250ms 完成 TCP 握手,超时就换下一个,
// 全部超时后聚合成一个信息量为零的 `fetch failed`。国内到 Cloudflare 的握手实测
// 451ms —— 也就是说账号服务器一次都连不上,而客户端会把它当成"服务器不可用",
// 静默回落到桌面账号池:功能看起来装好了,却从来没生效过。这一行必须在任何请求
// 发出之前执行。
nodeNet.setDefaultAutoSelectFamilyAttemptTimeout(5000)

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
const { resolveRemoteAccount, renewTrackedLeases, releaseLease } = require('./account-source')

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
  // A truthy answer is not necessarily a usable one — a malformed 200 from the
  // server would otherwise short-circuit the whole fallback chain.
  const usable = remote && remote.email && remote.password ? remote : null
  const chosen = usable || pickLocalAccount(userData)
  if (!chosen) return null

  return {
    email: chosen.email,
    partition: partitionName(chosen.email),
    loginScript: buildLoginScript(chosen.email, chosen.password),
    // Only a live lease needs renewing; a cached or desktop account has none.
    lease: usable ? usable.lease : null,
  }
}

// The window has to open no matter what: an auto-login we could not arrange is
// a far smaller failure than an app that shows nothing at all. Anything thrown
// while resolving the account is logged and downgraded to "no account".
async function resolveAccountSafely() {
  try {
    return await chooseAccount()
  } catch (err) {
    // Logged whole rather than as err.message: the thrown value need not be an
    // Error, and reading .message off null would throw from inside the catch —
    // turning the safety net back into the failure it is here to prevent.
    console.error('[account] resolve failed, opening without auto-login:', err)
    return null
  }
}

// Leases held by the windows of this run. They expire server-side after 30
// minutes, so they are renewed on a timer and handed back when the app quits.
const RENEW_INTERVAL_MS = 10 * 60 * 1000
const RELEASE_TIMEOUT_MS = 3000
const activeLeases = new Set()
let renewTimer = null
let renewing = false

function trackLease(lease) {
  if (!lease) return
  activeLeases.add(lease)
  if (renewTimer) return

  renewTimer = setInterval(async () => {
    // fetch carries no timeout, so a slow round can outlast the interval;
    // standing down keeps rounds from piling up on top of one another.
    if (renewing) return
    renewing = true
    // One round over every held lease. It decides, per lease, between "the
    // server says this lease is gone" (stop tracking it — the window keeps
    // browsing on the session it already has, and the next launch takes a
    // fresh lease) and "this attempt failed" (keep it and try again on the
    // next tick). Collapsing the two would let a single Wi-Fi blip end
    // renewal for good and hand the account to a second machine 30 minutes
    // later. It never rejects, so the finally is only bookkeeping.
    try {
      await renewTrackedLeases(activeLeases)
    } finally {
      renewing = false
    }
  }, RENEW_INTERVAL_MS)
  if (renewTimer.unref) renewTimer.unref()
}

// Set while an activate is resolving an account, so a second one stands down
// instead of opening a duplicate window. Reset in a finally: left stuck, the
// Dock icon would never open a window again.
let openingWindow = false

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
    const lease = account.lease
    registerLoginScript(wcId, account.loginScript)
    win.webContents.on('destroyed', () => {
      clearLoginScript(wcId)
      // Hand the account back as soon as its window is gone, or reopening a
      // few times would hold one lease per window and drain the pool. The
      // delete guards the release so it cannot double up with the one on quit.
      if (lease && activeLeases.delete(lease)) releaseLease(lease).catch(() => {})
    })
    trackLease(lease)
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

// The single way a window gets opened, so the first one and every later
// activate share one re-entrancy guard: resolving the account is awaited, and
// without the guard a second activate arriving during that gap would see no
// windows and open its own — burning a second lease nobody asked for. Never
// rejects, so it is safe to hand straight to an event listener.
async function openWindow(dir) {
  if (openingWindow || BrowserWindow.getAllWindows().length !== 0) return
  openingWindow = true
  try {
    // Resolving the account can take a network round trip, so the window waits
    // for it — one created without an account would never auto-log-in.
    createWindow(dir, await resolveAccountSafely())
  } catch (err) {
    console.error('[window] could not open a window:', err)
  } finally {
    openingWindow = false
  }
}

app.whenReady().then(async () => {
  const dir = scriptsDir(app.getPath('userData'))

  // Both listeners go up first, before anything that can fail. Registering a
  // listener cannot throw, and having them in place means a later step blowing
  // up costs at most a feature — not the whole app. In particular the Dock
  // icon stays a way to get a window even if the first one never opens.
  //
  // Every window, including popups, keeps the original brand out of its title
  // bar. Registered before the first window is created so it catches it too.
  app.on('browser-window-created', (_event, win) => guardWindowTitle(win))
  app.on('activate', () => openWindow(dir))

  ensureScriptDir(dir)
  serveScripts(dir)
  serveAccount()
  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir) })
  await openWindow(dir)
}).catch((err) => {
  // Nothing above is allowed to end as an unhandled rejection: it would be
  // silent, and the user would be left staring at an app that never opened.
  console.error('[startup] setup failed — the Dock icon can still open a window:', err)
})

// Handing the lease back on quit puts the account straight back in the pool.
// It is best-effort: a failure or a slow network must not keep the app alive,
// so the wait is capped and an unreleased lease is left to expire on its own.
app.on('before-quit', (event) => {
  if (!activeLeases.size) return
  event.preventDefault()
  const cap = new Promise((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS))
  Promise.race([releaseAllLeases(), cap]).finally(() => app.exit(0)).catch(() => {})
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
