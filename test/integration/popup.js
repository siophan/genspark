// Integration check that a window opened by the page also gets the user
// scripts. A popup does not inherit webPreferences, so this is easy to lose.
// Run with: npm run test:popup
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, protocol, BrowserWindow } = require('electron')

const { serveScripts } = require('../../src/script-bridge')
const { decideWindowOpen, RENDERER_PREFERENCES } = require('../../src/navigation')

const PRELOAD = path.join(__dirname, '../../src/preload.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-popup-'))
fs.writeFileSync(path.join(dir, 'a.css'), 'body { background-color: rgb(4, 5, 6); }')
fs.writeFileSync(path.join(dir, 'a.js'), 'window.__early = "ran"; document.title = "renamed"')

const PAGE_HTML = '<html><head><title>original</title></head><body>hi</body></html>'

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const read = (wc, expr) => wc.executeJavaScript(expr)

check('the popup runs the user scripts', async (popup) => {
  assert.strictEqual(await read(popup.webContents, 'String(window.__early)'), 'ran')
})

check('the popup applies the user css', async (popup) => {
  assert.strictEqual(
    await read(popup.webContents, 'getComputedStyle(document.body).backgroundColor'),
    'rgb(4, 5, 6)',
  )
})

check('the popup title is rewritten', async (popup) => {
  assert.strictEqual(await read(popup.webContents, 'document.title'), 'renamed')
})

check('the popup keeps the renderer sandboxed', async (popup) => {
  const prefs = popup.webContents.getLastWebPreferences()
  assert.strictEqual(prefs.contextIsolation, true)
  assert.strictEqual(prefs.nodeIntegration, false)
  assert.strictEqual(prefs.sandbox, true)
})

app.whenReady().then(async () => {
  serveScripts(dir)

  // Serve the site's own origin locally, so the popup goes through the real
  // in-site decision without the test depending on the network.
  protocol.handle('https', () =>
    new Response(PAGE_HTML, { headers: { 'content-type': 'text/html' } }))

  const win = new BrowserWindow({
    show: false,
    webPreferences: { ...RENDERER_PREFERENCES, preload: PRELOAD },
  })
  win.webContents.setWindowOpenHandler(({ url }) => decideWindowOpen(url, PRELOAD))

  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve)
    win.loadURL('https://www.genspark.ai/')
  })

  const created = new Promise((resolve) => app.once('browser-window-created', (_e, w) => resolve(w)))
  await read(win.webContents, 'window.open("https://www.genspark.ai/zh-cn", "_blank"); 1')

  const popup = await created
  popup.hide()
  await new Promise((resolve) => popup.webContents.once('did-finish-load', resolve))
  await new Promise((resolve) => setTimeout(resolve, 300))

  let failed = 0
  for (const { name, fn } of checks) {
    try {
      await fn(popup)
      console.log(`ok   ${name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${name}\n     ${err.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  app.exit(failed === 0 ? 0 : 1)
})
