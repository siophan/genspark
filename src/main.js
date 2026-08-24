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
const {
  resolveRemoteAccount, renewTrackedLeases, releaseLease, logTarget, sendLogs, bundledConfigFile,
} = require('./account-source')
const { createLogBuffer } = require('./log-ship')
const { userDataDir, migrateLegacyUserData } = require('./user-data')
const { collectFacts, renderDiagnosticsHtml } = require('./diagnostics')

// 装在最靠前的地方:取号发生在启动的头几百毫秒里,晚装一步就少一步日志。
// 打包后的应用没有可看的控制台,这个缓冲是那段过程唯一的观测口。
const logBuffer = createLogBuffer()
logBuffer.install()

// 把攒下的日志送到服务器,后台按机器分开显示。永不抛 —— 一个排障设施把宿主程序
// 搞崩是不可接受的。送不出去时行会留在缓冲里,下一次再试。
async function shipLogs() {
  try {
    const target = logTarget(app.getPath('userData'))
    if (!target) return
    await logBuffer.flush((lines) => sendLogs(target, lines))
  } catch {}
}

const PRELOAD = path.join(__dirname, 'preload.js')

// The menu bar, Dock, ⌘Tab switcher, and About panel all show the app's name,
// so it carries the brand too — rename it to 老猫 like everything else.
app.setName(DISPLAY_NAME)
// userData 曾经钉在应用的原名 "Genspark" 上,为的是改名之后别把老目录里的脚本
// 变成孤儿。那在开发机上没问题,在用户机器上是错的:装了官方 Genspark 桌面客户端
// 的机器上,%APPDATA%\Genspark 本来就是人家的 userData,我们等于住进了别人家,
// 两个 Electron 应用共用一个 Chromium profile 目录。改用 laomao,并把老目录里
// 属于我们的那部分搬过来一次 —— 判据是它有没有我们自己的文件,所以别人的目录
// 一个字节都不会被碰。
const appDataDir = app.getPath('appData')
console.log('[user-data] 旧目录迁移结果:', migrateLegacyUserData(appDataDir))
app.setPath('userData', userDataDir(appDataDir))
console.log('[user-data] userData =', app.getPath('userData'))

// 自动登录没成时,把原因直接摆到屏幕上。上报到服务器那条路在"连不上服务器"时恰好
// 是断的 —— 而那正是最需要看见原因的时候,所以本机必须也有一份,并且能复制走。
let diagWindow = null
function showDiagnostics() {
  try {
    if (diagWindow && !diagWindow.isDestroyed()) { diagWindow.focus(); return }
    const facts = collectFacts({
      platform: process.platform,
      version: app.getVersion(),
      electron: process.versions.electron,
      userDataDir: app.getPath('userData'),
      bundledFile: bundledConfigFile(),
    })
    const html = renderDiagnosticsHtml(facts, logBuffer.snapshot())
    diagWindow = new BrowserWindow({ width: 760, height: 600, title: '启动诊断' })
    diagWindow.on('closed', () => { diagWindow = null })
    diagWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  } catch (err) {
    // 诊断设施自己把应用带崩是最难看的失败方式。
    console.error('[diag] 诊断窗口打不开:', err)
  }
}

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
      await shipLogs()
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
    const account = await resolveAccountSafely()
    createWindow(dir, account)
    // 没有服务端租约 = 这次没按预期取到号(彻底没账号,或回落到了本机缓存/桌面池)。
    // 对用户来说唯一可见的症状就是"没自动登录",所以在这里把原因摆出来。
    // 必须排在 createWindow 之后:openWindow 用"当前有没有窗口"当闸门,
    // 诊断窗口先开出来会把主窗口挡在门外。
    if (!account || !account.lease) showDiagnostics()
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
  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir), onShowDiagnostics: showDiagnostics })
  await openWindow(dir)
  await shipLogs()
}).catch((err) => {
  // Nothing above is allowed to end as an unhandled rejection: it would be
  // silent, and the user would be left staring at an app that never opened.
  console.error('[startup] setup failed — the Dock icon can still open a window:', err)
})

// Handing the lease back on quit puts the account straight back in the pool.
// It is best-effort: a failure or a slow network must not keep the app alive,
// so the wait is capped and an unreleased lease is left to expire on its own.
app.on('before-quit', (event) => {
  // 也要等日志送完。原先这里只在"有租约"时才拦一下退出,可取号失败的那次运行
  // 恰恰没有租约 —— 日志会跟着进程一起蒸发,最需要它的时候它不在。
  if (!activeLeases.size && !logBuffer.size()) return
  event.preventDefault()
  const cap = new Promise((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS))
  Promise.race([Promise.all([releaseAllLeases(), shipLogs()]), cap])
    .finally(() => app.exit(0)).catch(() => {})
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
