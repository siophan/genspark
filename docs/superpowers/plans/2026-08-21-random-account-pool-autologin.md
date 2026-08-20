# 随机账号池 + 自动登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App 启动时从桌面账号池随机挑一个账号,用其专属会话分区打开窗口;未登录则自动填 Azure B2C 表单登录,已登录则直进。

**Architecture:** 纯逻辑(读账号池、随机选号、分区名、构造登录脚本)集中在无 electron 依赖的模块中,用 `node --test` 覆盖;electron 相关(IPC 桥、partition、窗口装配)在 main/preload/bridge 里装配,复用现有 sendSync 脚本注入通道的同构写法。登录页(login.genspark.ai)是内部域名,preload 会在其上运行,注入的登录内容脚本据此填表提交。

**Tech Stack:** Node.js (CommonJS), Electron 43, `node:test`, `node:crypto`。

## Global Constraints

- CommonJS(`require`/`module.exports`),与现有 `src/*.js` 一致。
- 纯逻辑模块**不得** `require('electron')`,以便 `node --test` 直接加载。
- 账号池文件路径:`<Desktop>/genspark-accounts.json`;桌面目录在 main 里用 `app.getPath('desktop')` 取得,逻辑模块接收目录参数(便于测试)。
- 上次账号记录写在用户数据目录 `<userData>/last-account.json`,**不**写回桌面。
- 明文密码可接受(单机自用);真实账号绝不写进仓库/plan。
- 预加载是 sandboxed,不能 require 项目模块:新增 IPC 通道常量需在 preload.js 与 bridge 里**各写一份并注释保持同步**,与现有 `REQUEST`/`CSS_UPDATE` 做法一致。
- 分区名格式:`persist:acct-<email 的 sha1 前 12 位十六进制>`。

---

### Task 1: accounts.js — 账号池文件层(定位/生成模板/读取解析/过滤示例)

**Files:**
- Create: `src/accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Produces:
  - `EXAMPLE_EMAILS: Set<string>`、`EXAMPLE_PASSWORD: string`
  - `DEFAULT_TEMPLATE: string`(带示例的 JSON 文本)
  - `accountsFile(desktopDir: string): string` → `path.join(desktopDir, 'genspark-accounts.json')`
  - `ensureAccountsFile(file: string): boolean`(不存在则写入 `DEFAULT_TEMPLATE`,返回是否新建)
  - `loadAccounts(file: string): { avoidRepeatLast: boolean, accounts: Array<{email:string,password:string}> }`(任何错误→`{avoidRepeatLast:true, accounts:[]}`)
  - `isExampleAccount(a: {email,password}): boolean`
  - `realAccounts(accounts): Array`(过滤空值与示例账号)

- [ ] **Step 1: Write the failing test**

```js
// test/accounts.test.js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  DEFAULT_TEMPLATE, accountsFile, ensureAccountsFile,
  loadAccounts, isExampleAccount, realAccounts,
} = require('../src/accounts')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-acct-'))
}

test('accountsFile lives on the given desktop dir', () => {
  assert.strictEqual(accountsFile('/D'), path.join('/D', 'genspark-accounts.json'))
})

test('DEFAULT_TEMPLATE parses and has example accounts', () => {
  const parsed = JSON.parse(DEFAULT_TEMPLATE)
  assert.strictEqual(Array.isArray(parsed.accounts), true)
  assert.ok(parsed.accounts.length >= 1)
})

test('ensureAccountsFile writes template only when missing', () => {
  const file = path.join(tmpdir(), 'genspark-accounts.json')
  assert.strictEqual(ensureAccountsFile(file), true)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), DEFAULT_TEMPLATE)
  fs.writeFileSync(file, '{"accounts":[]}')
  assert.strictEqual(ensureAccountsFile(file), false)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"accounts":[]}')
})

test('loadAccounts tolerates bad json', () => {
  const file = path.join(tmpdir(), 'x.json')
  fs.writeFileSync(file, 'not json')
  assert.deepStrictEqual(loadAccounts(file), { avoidRepeatLast: true, accounts: [] })
})

test('loadAccounts reads a valid pool', () => {
  const file = path.join(tmpdir(), 'x.json')
  fs.writeFileSync(file, JSON.stringify({
    avoidRepeatLast: false,
    accounts: [{ email: 'a@x.com', password: 'p' }],
  }))
  assert.deepStrictEqual(loadAccounts(file), {
    avoidRepeatLast: false,
    accounts: [{ email: 'a@x.com', password: 'p' }],
  })
})

test('example accounts are recognised and filtered out', () => {
  const tmpl = JSON.parse(DEFAULT_TEMPLATE)
  assert.strictEqual(isExampleAccount(tmpl.accounts[0]), true)
  assert.strictEqual(isExampleAccount({ email: 'real@x.com', password: 'p' }), false)
  const mixed = [tmpl.accounts[0], { email: 'real@x.com', password: 'p' }, { email: '', password: '' }]
  assert.deepStrictEqual(realAccounts(mixed), [{ email: 'real@x.com', password: 'p' }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL(`Cannot find module '../src/accounts'`)

- [ ] **Step 3: Write minimal implementation**

```js
// src/accounts.js
const fs = require('node:fs')
const path = require('node:path')

const EXAMPLE_EMAILS = new Set(['example1@mail.com', 'example2@mail.com'])
const EXAMPLE_PASSWORD = '改成你的密码'

const DEFAULT_TEMPLATE = JSON.stringify(
  {
    avoidRepeatLast: true,
    accounts: [
      { email: 'example1@mail.com', password: '改成你的密码' },
      { email: 'example2@mail.com', password: '改成你的密码' },
    ],
  },
  null,
  2,
)

function accountsFile(desktopDir) {
  return path.join(desktopDir, 'genspark-accounts.json')
}

function ensureAccountsFile(file) {
  if (fs.existsSync(file)) return false
  try {
    fs.writeFileSync(file, DEFAULT_TEMPLATE)
    return true
  } catch (err) {
    console.error(`[accounts] cannot write ${file}:`, err.message)
    return false
  }
}

function loadAccounts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
    return { avoidRepeatLast: parsed.avoidRepeatLast !== false, accounts }
  } catch {
    return { avoidRepeatLast: true, accounts: [] }
  }
}

function isExampleAccount(a) {
  return EXAMPLE_EMAILS.has(a.email) || a.password === EXAMPLE_PASSWORD
}

function realAccounts(accounts) {
  return accounts.filter((a) => a && a.email && a.password && !isExampleAccount(a))
}

module.exports = {
  EXAMPLE_EMAILS, EXAMPLE_PASSWORD, DEFAULT_TEMPLATE,
  accountsFile, ensureAccountsFile, loadAccounts, isExampleAccount, realAccounts,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/accounts.js test/accounts.test.js
git commit -m "feat: read and template the desktop account pool file"
```

---

### Task 2: accounts.js — 选号层(分区名 / 随机选号 / 上次账号读写)

**Files:**
- Modify: `src/accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: `realAccounts` from Task 1.
- Produces:
  - `partitionName(email: string): string` → `'persist:acct-' + sha1(email).slice(0,12)`
  - `pickAccount(accounts, opts): {email,password} | null`,`opts = { lastEmail?: string, avoidRepeatLast?: boolean, random?: () => number }`(默认 `random = Math.random`)
  - `lastAccountFile(userDataDir): string`
  - `readLastEmail(file): string | null`
  - `writeLastEmail(file, email): void`

- [ ] **Step 1: Write the failing test**

```js
// append to test/accounts.test.js
const {
  partitionName, pickAccount, lastAccountFile, readLastEmail, writeLastEmail,
} = require('../src/accounts')

test('partitionName is stable and namespaced per email', () => {
  assert.match(partitionName('a@x.com'), /^persist:acct-[0-9a-f]{12}$/)
  assert.strictEqual(partitionName('a@x.com'), partitionName('a@x.com'))
  assert.notStrictEqual(partitionName('a@x.com'), partitionName('b@x.com'))
})

test('pickAccount returns null for an empty pool', () => {
  assert.strictEqual(pickAccount([], {}), null)
})

test('pickAccount uses the injected random to index', () => {
  const pool = [{ email: 'a@x.com', password: '1' }, { email: 'b@x.com', password: '2' }]
  assert.strictEqual(pickAccount(pool, { random: () => 0 }).email, 'a@x.com')
  assert.strictEqual(pickAccount(pool, { random: () => 0.99 }).email, 'b@x.com')
})

test('avoidRepeatLast skips the previous account when possible', () => {
  const pool = [{ email: 'a@x.com', password: '1' }, { email: 'b@x.com', password: '2' }]
  // random()=0 would pick index 0 of the *filtered* pool (only b), so b is chosen
  const chosen = pickAccount(pool, { lastEmail: 'a@x.com', avoidRepeatLast: true, random: () => 0 })
  assert.strictEqual(chosen.email, 'b@x.com')
})

test('avoidRepeatLast falls back when only the last account remains', () => {
  const pool = [{ email: 'a@x.com', password: '1' }]
  const chosen = pickAccount(pool, { lastEmail: 'a@x.com', avoidRepeatLast: true, random: () => 0 })
  assert.strictEqual(chosen.email, 'a@x.com')
})

test('last email round-trips through its file', () => {
  const file = path.join(tmpdir(), 'last-account.json')
  assert.strictEqual(readLastEmail(file), null)
  writeLastEmail(file, 'a@x.com')
  assert.strictEqual(readLastEmail(file), 'a@x.com')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL(`partitionName is not a function`)

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/accounts.js
const crypto = require('node:crypto')

function partitionName(email) {
  const hash = crypto.createHash('sha1').update(email).digest('hex').slice(0, 12)
  return `persist:acct-${hash}`
}

function pickAccount(accounts, opts = {}) {
  if (!accounts.length) return null
  const random = opts.random || Math.random
  let pool = accounts
  if (opts.avoidRepeatLast && accounts.length >= 2 && opts.lastEmail) {
    const filtered = accounts.filter((a) => a.email !== opts.lastEmail)
    if (filtered.length) pool = filtered
  }
  return pool[Math.floor(random() * pool.length)]
}

function lastAccountFile(userDataDir) {
  return path.join(userDataDir, 'last-account.json')
}

function readLastEmail(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).email || null
  } catch {
    return null
  }
}

function writeLastEmail(file, email) {
  try {
    fs.writeFileSync(file, JSON.stringify({ email }))
  } catch (err) {
    console.error(`[accounts] cannot write ${file}:`, err.message)
  }
}
```

Add these to `module.exports`: `partitionName, pickAccount, lastAccountFile, readLastEmail, writeLastEmail`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/accounts.js test/accounts.test.js
git commit -m "feat: pick a random account per launch with a stable partition"
```

---

### Task 3: auto-login.js — 构造注入的登录内容脚本

**Files:**
- Create: `src/auto-login.js`
- Test: `test/auto-login.test.js`

**Interfaces:**
- Produces:
  - `loginContentMain(email, password)`:在页面主世界运行的函数(填 B2C 表单 / 在落地页点登录入口)。
  - `buildLoginScript(email, password): string`:把上面函数序列化成可注入的 IIFE 源码,凭据经 `JSON.stringify` 内联进闭包实参。

- [ ] **Step 1: Write the failing test**

```js
// test/auto-login.test.js
const test = require('node:test')
const assert = require('node:assert')

const { buildLoginScript } = require('../src/auto-login')

test('buildLoginScript embeds escaped credentials in a callable IIFE', () => {
  const src = buildLoginScript('a@x.com', 'p"1\n2')
  assert.match(src, /^\(function/)
  assert.ok(src.includes(JSON.stringify('a@x.com')))
  assert.ok(src.includes(JSON.stringify('p"1\n2')))
  // no raw newline from the password leaked into source
  assert.ok(!src.includes('p"1\n2'))
})

test('buildLoginScript references the B2C form fields it will fill', () => {
  const src = buildLoginScript('a@x.com', 'p')
  assert.ok(src.includes("input[type=password]"))
  assert.ok(src.includes('login.genspark.ai'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auto-login.test.js`
Expected: FAIL(`Cannot find module '../src/auto-login'`)

- [ ] **Step 3: Write minimal implementation**

```js
// src/auto-login.js
//
// Browser-side auto-login. Runs in the page main world (injected by the
// preload) on every genspark.ai navigation. If the partition is already
// logged in, none of the target elements exist and it is a no-op. Otherwise
// it either clicks the sign-in entry (landing page) or fills the Azure AD B2C
// form on login.genspark.ai and submits.
//
// NOTE: selectors are a best-effort first pass. Task 6 verifies them against
// the live DOM and tightens them if needed.
function loginContentMain(email, password) {
  var DONE = '__gsAutoLoginFilled'
  var ENTERED = '__gsAutoLoginEntered'

  function q(sel) { return document.querySelector(sel) }

  function setValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function fillB2C() {
    var emailEl = q('input[type=email]') || q('#email') || q('#signInName') || q('input[name=Email]')
    var passEl = q('input[type=password]') || q('#password') || q('input[name=Password]')
    if (!emailEl || !passEl) return false
    setValue(emailEl, email)
    setValue(passEl, password)
    var submit = q('button[type=submit]') || q('#next') || q('#continue') || q('#submit')
    if (submit) submit.click()
    return true
  }

  function enterLogin() {
    if (window[ENTERED]) return
    var els = Array.prototype.slice.call(document.querySelectorAll('a,button'))
    var hit = els.find(function (el) {
      return /^(sign ?in|log ?in|登\s*录)$/i.test((el.textContent || '').trim())
    })
    if (hit) { window[ENTERED] = true; hit.click() }
  }

  function tick() {
    if (window[DONE]) return
    if (location.hostname === 'login.genspark.ai') {
      if (fillB2C()) window[DONE] = true
    } else if (location.hostname.endsWith('genspark.ai')) {
      enterLogin()
    }
  }

  var obs = new MutationObserver(tick)
  obs.observe(document.documentElement, { childList: true, subtree: true })
  tick()
  setTimeout(function () { obs.disconnect() }, 15000)
}

function buildLoginScript(email, password) {
  return '(' + loginContentMain.toString() + ')(' +
    JSON.stringify(email) + ',' + JSON.stringify(password) + ');'
}

module.exports = { loginContentMain, buildLoginScript }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/auto-login.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auto-login.js test/auto-login.test.js
git commit -m "feat: build an injectable Azure B2C auto-login content script"
```

---

### Task 4: account-bridge.js — 把登录脚本按窗口经 IPC 交给 preload

**Files:**
- Create: `src/account-bridge.js`
- Test: `test/account-bridge.test.js`

**Interfaces:**
- Produces:
  - `ACCOUNT_REQUEST: string`(IPC 通道名,需与 preload 里的副本一致)
  - `registerLoginScript(webContentsId: number, loginScript: string): void`
  - `serveAccount(): void`(注册 `ipcMain.on(ACCOUNT_REQUEST)`,同步返回 `{ loginScript } | null`,按 `event.sender.id` 取)
  - `clearLoginScript(webContentsId: number): void`(窗口关闭时清理)
- 说明:测试用一个轻量假 `ipcMain`(带 `on`/`removeAllListeners`)注入,避免真的加载 electron。为此 `serveAccount(ipcMainImpl = require('electron').ipcMain)` 接收可选注入参数。

- [ ] **Step 1: Write the failing test**

```js
// test/account-bridge.test.js
const test = require('node:test')
const assert = require('node:assert')

const {
  ACCOUNT_REQUEST, registerLoginScript, clearLoginScript, serveAccount,
} = require('../src/account-bridge')

function fakeIpcMain() {
  const handlers = {}
  return {
    on(channel, fn) { handlers[channel] = fn },
    removeAllListeners(channel) { delete handlers[channel] },
    emitSync(channel, senderId) {
      const event = { sender: { id: senderId }, returnValue: undefined }
      handlers[channel](event)
      return event.returnValue
    },
  }
}

test('serveAccount returns the registered script for that sender, null otherwise', () => {
  const ipc = fakeIpcMain()
  serveAccount(ipc)
  assert.strictEqual(ipc.emitSync(ACCOUNT_REQUEST, 7), null)
  registerLoginScript(7, 'SCRIPT')
  assert.deepStrictEqual(ipc.emitSync(ACCOUNT_REQUEST, 7), { loginScript: 'SCRIPT' })
  assert.strictEqual(ipc.emitSync(ACCOUNT_REQUEST, 8), null)
  clearLoginScript(7)
  assert.strictEqual(ipc.emitSync(ACCOUNT_REQUEST, 7), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/account-bridge.test.js`
Expected: FAIL(`Cannot find module '../src/account-bridge'`)

- [ ] **Step 3: Write minimal implementation**

```js
// src/account-bridge.js
// Kept in sync by hand with the copy in preload.js: a sandboxed preload cannot
// require its own modules, so the channel name cannot be shared.
const ACCOUNT_REQUEST = 'genspark-shell:account:request'

const scripts = new Map()

function registerLoginScript(webContentsId, loginScript) {
  scripts.set(webContentsId, loginScript)
}

function clearLoginScript(webContentsId) {
  scripts.delete(webContentsId)
}

// Synchronous like the scripts channel: the preload asks at document-start.
function serveAccount(ipcMain = require('electron').ipcMain) {
  ipcMain.removeAllListeners(ACCOUNT_REQUEST)
  ipcMain.on(ACCOUNT_REQUEST, (event) => {
    const loginScript = scripts.get(event.sender.id)
    event.returnValue = loginScript ? { loginScript } : null
  })
}

module.exports = { ACCOUNT_REQUEST, registerLoginScript, clearLoginScript, serveAccount }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/account-bridge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/account-bridge.js test/account-bridge.test.js
git commit -m "feat: serve the per-window login script over IPC"
```

---

### Task 5: preload.js — 请求并注入登录脚本

**Files:**
- Modify: `src/preload.js`

**Interfaces:**
- Consumes: `ACCOUNT_REQUEST`(在 preload 里再声明一份同名常量),`serveAccount` 的同步返回 `{ loginScript } | null`。复用已有的 `runJS`。
- 说明:此改动的验证放在 Task 6 的手动运行里(preload 需真实 electron 环境),本任务不加自动化测试,故不单独跑测试步骤。

- [ ] **Step 1: 在通道常量区加入 ACCOUNT_REQUEST 副本**

在 `const REQUEST = ...` 等常量附近加:

```js
// Duplicated from account-bridge.js (sandboxed preload cannot require it).
const ACCOUNT_REQUEST = 'genspark-shell:account:request'
```

- [ ] **Step 2: 在拿到 scripts 后请求账号登录脚本**

在 `const scripts = ipcRenderer.sendSync(REQUEST)` 之后加:

```js
// The main process assigns this window's account; if present, its login
// script is injected alongside the user scripts. null when auto-login is off
// (no pool / already logged in yields no fillable form and the script no-ops).
const account = ipcRenderer.sendSync(ACCOUNT_REQUEST)
```

- [ ] **Step 3: 在 whenRootExists 注入回调里追加登录脚本注入**

把现有的:

```js
whenRootExists(() => {
  applyCSS(scripts.css)
  if (scripts.js.length) hideUntilSettled()
  runJS(scripts.js)
})
```

改成:

```js
whenRootExists(() => {
  applyCSS(scripts.css)
  if (scripts.js.length) hideUntilSettled()
  runJS(scripts.js)
  if (account?.loginScript) {
    runJS([{ name: 'auto-login', source: account.loginScript }])
  }
})
```

- [ ] **Step 4: 语法自检**

Run: `node -e "require('node:fs').readFileSync('src/preload.js','utf8'); new Function(require('node:fs').readFileSync('src/preload.js','utf8').replace(/require\\(.electron.\\)/,'({ipcRenderer:{sendSync(){},on(){}}})'))"`
Expected: 无输出、退出码 0(不抛 SyntaxError)。

- [ ] **Step 5: Commit**

```bash
git add src/preload.js
git commit -m "feat: inject the assigned account login script at document-start"
```

---

### Task 6: main.js — 装配(选号 / 分区 / 注册脚本 / 记录上次)+ 手动验证

**Files:**
- Modify: `src/main.js`
- Modify: `src/paths.js`(可选:若把 last-account 路径放这里,本计划改为直接用 accounts.lastAccountFile,无需改 paths.js)

**Interfaces:**
- Consumes: 全部来自 `src/accounts.js`(`accountsFile, ensureAccountsFile, loadAccounts, realAccounts, pickAccount, partitionName, lastAccountFile, readLastEmail, writeLastEmail`)、`src/auto-login.js`(`buildLoginScript`)、`src/account-bridge.js`(`serveAccount, registerLoginScript, clearLoginScript`)。

- [ ] **Step 1: 顶部引入新模块**

在 main.js 现有 require 区加:

```js
const {
  accountsFile, ensureAccountsFile, loadAccounts, realAccounts,
  pickAccount, partitionName, lastAccountFile, readLastEmail, writeLastEmail,
} = require('./accounts')
const { buildLoginScript } = require('./auto-login')
const { serveAccount, registerLoginScript, clearLoginScript } = require('./account-bridge')
```

- [ ] **Step 2: 加一个"选出本次窗口账号"的辅助函数**

在 `createWindow` 上方加:

```js
// Reads the desktop pool (seeding a template on first run), picks a random
// account for this launch, and returns what the window needs: a stable
// per-account session partition plus the login script to inject. Returns null
// when there is no usable account, in which case the window opens normally
// with no auto-login.
function chooseAccount() {
  const userData = app.getPath('userData')
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
  return {
    email: account.email,
    partition: partitionName(account.email),
    loginScript: buildLoginScript(account.email, account.password),
  }
}
```

- [ ] **Step 3: 让 createWindow 接受账号并设置 partition + 注册登录脚本**

修改 `createWindow(dir)` 签名为 `createWindow(dir, account)`,并在 `new BrowserWindow` 的 `webPreferences` 里加入 partition,同时在创建后注册登录脚本、关窗时清理:

```js
function createWindow(dir, account) {
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const state = loadState(windowStateFile(app.getPath('userData')), displays)

  const win = new BrowserWindow({
    ...state,
    title: DISPLAY_NAME,
    webPreferences: {
      ...RENDERER_PREFERENCES,
      preload: PRELOAD,
      ...(account ? { partition: account.partition } : {}),
    },
  })

  if (account) {
    registerLoginScript(win.webContents.id, account.loginScript)
    win.webContents.on('destroyed', () => clearLoginScript(win.webContents.id))
  }

  trackWindow(win, windowStateFile(app.getPath('userData')))
  // ...rest of createWindow unchanged...
```

保留 `createWindow` 其余部分不变(setWindowOpenHandler / will-navigate / watcher / loadURL(HOME_URL) / return win)。

- [ ] **Step 4: 在 whenReady 里装配 bridge 并把账号传给窗口**

在 `app.whenReady().then(() => { ... })` 内,`serveScripts(dir)` 之后加 `serveAccount()`;把两处 `createWindow(dir)` 改为带账号:

```js
  serveScripts(dir)
  serveAccount()

  // ...existing guardWindowTitle + buildMenu...

  createWindow(dir, chooseAccount())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dir, chooseAccount())
  })
```

- [ ] **Step 5: 跑全部单测确保没回归**

Run: `npm test`
Expected: 全部 PASS(现有 + 新增 accounts/auto-login/account-bridge 测试)。

- [ ] **Step 6: 手动端到端验证(需用户在场)**

前提:桌面 `genspark-accounts.json` 已填入至少一个真实账号(用户自行填写,不写进仓库)。

1. `npm start` 启动。
2. 若该账号分区首次使用且未登录:观察窗口是否走到 login.genspark.ai 并自动填入邮箱/密码、提交。
3. 若选择器没对上(没自动填):用 `npm run test:early` 或在窗口开 DevTools 观察 login.genspark.ai 的真实输入框/按钮 DOM,回到 `src/auto-login.js` 收紧 `fillB2C()`/`enterLogin()` 的选择器,重跑验证。
4. 关掉再开几次,确认能随机切到不同账号(`avoidRepeatLast` 生效),且已登录过的分区免密直进。

**这一步的真实密码提交由用户本人操作;协助方仅在需要时协助读取 DOM、调整选择器,不代为向线上页面提交真实密码。**

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: wire random account selection, session partitions and auto-login"
```

---

## Self-Review 记录

- **Spec coverage**:桌面文件+模板(T1)、随机+avoidRepeatLast+分区+上次账号(T2)、B2C 自动登录脚本(T3)、按窗口下发(T4)、preload 注入(T5)、装配+手动验证含选择器不确定点(T6)。全覆盖。
- **Placeholder scan**:各步均含真实代码;唯一"待定"是 B2C 选择器,已给出可运行的首版实现 + 明确的 DOM 验证/收紧步骤(T6-Step6),非占位。
- **Type consistency**:`buildLoginScript`、`partitionName`、`pickAccount(opts{lastEmail,avoidRepeatLast,random})`、`registerLoginScript/clearLoginScript/serveAccount`、`ACCOUNT_REQUEST` 在定义与消费处签名一致。
