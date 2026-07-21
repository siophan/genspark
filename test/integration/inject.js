// Integration check for the injector against a real Electron page.
// Run with: npm run test:integration
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { createInjector } = require('../../src/injector')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-integration-'))
const page = path.join(dir, 'page.html')
fs.writeFileSync(page, '<html><head><title>original</title></head><body>hi</body></html>')
fs.writeFileSync(path.join(dir, 'a.css'), 'body { background-color: rgb(1, 2, 3); }')
// Reads a site-provided global to prove the script runs in the page's main
// world rather than an isolated one.
fs.writeFileSync(path.join(dir, 'a.js'), 'window.__probe = 42; document.title = "injected-" + window.__probe')

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('css is applied to the page', async (win) => {
  const bg = await win.webContents.executeJavaScript(
    'getComputedStyle(document.body).backgroundColor',
  )
  assert.strictEqual(bg, 'rgb(1, 2, 3)')
})

check('js runs in the page main world', async (win) => {
  const title = await win.webContents.executeJavaScript('document.title')
  assert.strictEqual(title, 'injected-42')
})

check('editing css takes effect without a reload', async (win) => {
  const before = await win.webContents.executeJavaScript('document.title')
  fs.writeFileSync(path.join(dir, 'a.css'), 'body { background-color: rgb(9, 8, 7); }')
  await win.injector.reinjectCSS()

  const bg = await win.webContents.executeJavaScript(
    'getComputedStyle(document.body).backgroundColor',
  )
  assert.strictEqual(bg, 'rgb(9, 8, 7)')
  // The page was never reloaded, so the injected title survived.
  assert.strictEqual(await win.webContents.executeJavaScript('document.title'), before)
})

check('removed css stops being applied', async (win) => {
  fs.rmSync(path.join(dir, 'a.css'))
  await win.injector.reinjectCSS()

  const bg = await win.webContents.executeJavaScript(
    'getComputedStyle(document.body).backgroundColor',
  )
  assert.strictEqual(bg, 'rgba(0, 0, 0, 0)')
})

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  win.injector = createInjector(win.webContents, dir)
  win.injector.attach()

  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.loadFile(page)
  await loaded
  // did-finish-load listeners run in order; let the injector's finish first.
  await new Promise((resolve) => setTimeout(resolve, 300))

  let failed = 0
  for (const { name, fn } of checks) {
    try {
      await fn(win)
      console.log(`ok   ${name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${name}\n     ${err.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  app.exit(failed === 0 ? 0 : 1)
})
