// Integration check that user scripts run at document-start, before the page's
// own scripts and before anything is painted.
// Run with: npm run test:early
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { serveScripts, pushCSS } = require('../../src/script-bridge')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-early-'))
fs.writeFileSync(path.join(dir, 'a.css'), 'body { background-color: rgb(1, 2, 3); }')
fs.writeFileSync(
  path.join(dir, 'a.js'),
  'window.__early = "ran-at-" + document.readyState; window.__earlyHadBody = String(!!document.body)',
)

const page = path.join(dir, 'page.html')
fs.writeFileSync(
  page,
  `<html>
    <head>
      <title>original</title>
      <script>
        // Runs as the parser reaches it — the earliest the page itself can act.
        window.__pageSawEarly = String(window.__early)
        window.__pageSawStyle = String(getComputedStyle(document.documentElement).getPropertyValue('--never'))
      </script>
    </head>
    <body><h1 id="heading">hello</h1></body>
  </html>`,
)

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const read = (win, expr) => win.webContents.executeJavaScript(expr)

check('the user script runs before the page own script', async (win) => {
  assert.strictEqual(await read(win, 'window.__pageSawEarly'), 'ran-at-loading')
})

check('the user script runs in the page main world', async (win) => {
  // The page's own inline script could only see it if they share a world.
  assert.notStrictEqual(await read(win, 'window.__pageSawEarly'), 'undefined')
  assert.strictEqual(await read(win, 'String(window.__early)'), 'ran-at-loading')
})

check('the user script runs before the body exists', async (win) => {
  assert.strictEqual(await read(win, 'window.__earlyHadBody'), 'false')
})

check('css is applied', async (win) => {
  assert.strictEqual(
    await read(win, 'getComputedStyle(document.body).backgroundColor'),
    'rgb(1, 2, 3)',
  )
})

check('editing css updates the page without a reload', async (win) => {
  fs.writeFileSync(path.join(dir, 'a.css'), 'body { background-color: rgb(9, 8, 7); }')
  await pushCSS(win.webContents, dir)
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.strictEqual(
    await read(win, 'getComputedStyle(document.body).backgroundColor'),
    'rgb(9, 8, 7)',
  )
  // Still the same document: a reload would have wiped this.
  assert.strictEqual(await read(win, 'String(window.__early)'), 'ran-at-loading')
})

check('removing css stops it being applied', async (win) => {
  fs.rmSync(path.join(dir, 'a.css'))
  await pushCSS(win.webContents, dir)
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.strictEqual(
    await read(win, 'getComputedStyle(document.body).backgroundColor'),
    'rgba(0, 0, 0, 0)',
  )
})

app.whenReady().then(async () => {
  serveScripts(dir)

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../../src/preload.js'),
    },
  })

  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.loadFile(page)
  await loaded

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
