// Integration check for the rename user script against a real Electron page.
// Run with: npm run test:rename
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { serveScripts } = require('../../src/script-bridge')

const NEW_NAME = '老猫'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-rename-'))
// Sorted before the rename script, so it is already listening when it runs.
fs.writeFileSync(
  path.join(dir, '00-errors.js'),
  'window.__errors = []; window.__bodyAtStart = String(!!document.body); window.addEventListener("error", (e) => window.__errors.push(e.message))',
)
fs.copyFileSync(
  path.join(__dirname, '../../examples/rename-to-laomao.js'),
  path.join(dir, 'rename.js'),
)

const page = path.join(dir, 'page.html')
fs.writeFileSync(
  page,
  `<html>
    <head>
      <title>Genspark — AI agent</title>
      <!-- Makes the parser pause here, which is when the preload injects and
           document.body does not exist yet — the case that used to crash. -->
      <script>window.__headScript = 1</script>
    </head>
    <body>
      <h1 id="heading">Welcome to Genspark</h1>
      <p id="mixed">genspark, GenSpark and GENSPARK are all the same product.</p>
      <p id="untouched">Nothing to see here.</p>
      <input id="field" value="Genspark" placeholder="Ask Genspark anything" aria-label="Genspark search">
      <code id="code">const genspark = require('genspark')</code>
      <script id="inline">window.__brand = 'Genspark'</script>
      <div id="later"></div>
      <script id="witness">
        // The parser has already produced the heading above. If the rename only
        // happened after load, the original name would be visible right here.
        window.__headingWhileParsing = document.getElementById('heading').textContent
      </script>
    </body>
  </html>`,
)

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const read = (win, expr) => win.webContents.executeJavaScript(expr)

check('the script survives running before the DOM exists', async (win) => {
  // It runs at document-start, where document.body is still null. Assuming the
  // DOM is there throws before anything gets renamed.
  assert.strictEqual(await read(win, 'window.__bodyAtStart'), 'false', 'test is meaningless if body already exists')
  assert.deepStrictEqual(await read(win, 'window.__errors'), [])
})

check('the original name is never present in the parsed document', async (win) => {
  assert.strictEqual(await read(win, 'window.__headingWhileParsing'), `Welcome to ${NEW_NAME}`)
})

check('visible text is renamed', async (win) => {
  assert.strictEqual(await read(win, 'document.getElementById("heading").textContent'), `Welcome to ${NEW_NAME}`)
})

check('every capitalisation is renamed', async (win) => {
  assert.strictEqual(
    await read(win, 'document.getElementById("mixed").textContent'),
    `${NEW_NAME}, ${NEW_NAME} and ${NEW_NAME} are all the same product.`,
  )
})

check('the page title is renamed', async (win) => {
  assert.strictEqual(await read(win, 'document.title'), `${NEW_NAME} — AI agent`)
})

check('unrelated text is left alone', async (win) => {
  assert.strictEqual(await read(win, 'document.getElementById("untouched").textContent'), 'Nothing to see here.')
})

check('code blocks are left alone', async (win) => {
  assert.match(await read(win, 'document.getElementById("code").textContent'), /require\('genspark'\)/)
})

check('form values are left alone', async (win) => {
  assert.strictEqual(await read(win, 'document.getElementById("field").value'), 'Genspark')
})

check('inline script source is left alone', async (win) => {
  assert.match(await read(win, 'document.getElementById("inline").textContent'), /'Genspark'/)
})

check('visible attributes are renamed', async (win) => {
  assert.strictEqual(
    await read(win, 'document.getElementById("field").placeholder'),
    `Ask ${NEW_NAME} anything`,
  )
  assert.strictEqual(
    await read(win, 'document.getElementById("field").getAttribute("aria-label")'),
    `${NEW_NAME} search`,
  )
})

check('text added later is renamed too', async (win) => {
  await read(win, 'document.getElementById("later").innerHTML = "<span>Ask Genspark anything</span>"')
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.strictEqual(
    await read(win, 'document.getElementById("later").textContent'),
    `Ask ${NEW_NAME} anything`,
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
