// Integration check for the anti-flicker guard. The rename runs from a
// MutationObserver, whose callbacks are asynchronous, so streamed/rendered
// brand text is painted before it is rewritten unless the page is held hidden
// until the rewrite has had its say. Run with: npm run test:flicker
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, protocol, BrowserWindow } = require('electron')

const { serveScripts } = require('../../src/script-bridge')
const { RENDERER_PREFERENCES } = require('../../src/navigation')

const PRELOAD = path.join(__dirname, '../../src/preload.js')

// A user script that renames the brand the same way the real one does: with an
// observer, so the rewrite is asynchronous relative to the parser. It also
// records the root's visibility at the instant it runs — document-start, the
// start of the window during which streamed content is painted un-renamed. The
// guard must already be hiding the root by then.
const RENAME_JS = `
  window.__docStartVisibility = getComputedStyle(document.documentElement).visibility
  const rename = (t) => t.replace(/genspark/gi, '老猫')
  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = rename(n.nodeValue)
  }
  walk(document.documentElement)
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType === Node.ELEMENT_NODE) walk(n)
      else if (n.nodeType === Node.TEXT_NODE) n.nodeValue = rename(n.nodeValue)
    }
  }).observe(document.documentElement, { subtree: true, childList: true })
`

const PAGE_HTML = `<html><head><title>Genspark</title></head><body>
  <div id="brand">Genspark home</div>
  <div id="tail">more genspark content</div>
</body></html>`

const withJs = (js) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-flicker-'))
  if (js != null) fs.writeFileSync(path.join(dir, 'rename.js'), js)
  return dir
}

async function loadWith(dir) {
  serveScripts(dir)
  const win = new BrowserWindow({
    show: false,
    webPreferences: { ...RENDERER_PREFERENCES, preload: PRELOAD },
  })
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve)
    win.loadURL('https://www.genspark.ai/')
  })
  // Let DOMContentLoaded + the scheduled reveal run.
  await new Promise((resolve) => setTimeout(resolve, 600))
  return win
}

const read = (win, expr) => win.webContents.executeJavaScript(expr)

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the root is hidden from document-start, before streamed content can paint', async () => {
  const win = await loadWith(withJs(RENAME_JS))
  // The rename observer is async, so any content painted between document-start
  // and the rewrite would show the original name. The guard must hold the root
  // hidden across that whole window, which starts here.
  assert.strictEqual(
    await read(win, 'window.__docStartVisibility'),
    'hidden',
    'the root was visible at document-start — streamed content can paint un-renamed here (the flash)',
  )
})

check('the page is revealed and renamed once loading settles', async () => {
  const win = await loadWith(withJs(RENAME_JS))
  assert.strictEqual(await read(win, 'getComputedStyle(document.documentElement).visibility'), 'visible')
  assert.strictEqual(await read(win, 'document.getElementById("brand").textContent'), '老猫 home')
  assert.strictEqual(await read(win, 'document.getElementById("tail").textContent'), 'more 老猫 content')
})

check('a page with no user scripts is never hidden', async () => {
  const win = await loadWith(withJs(null))
  assert.strictEqual(
    await read(win, 'getComputedStyle(document.documentElement).visibility'),
    'visible',
    'nothing rewrites content, so there is no reason to hide it',
  )
})

check('the page still reveals even if a user script throws', async () => {
  const win = await loadWith(withJs('throw new Error("boom")'))
  assert.strictEqual(await read(win, 'getComputedStyle(document.documentElement).visibility'), 'visible')
})

app.whenReady().then(async () => {
  protocol.handle('https', () =>
    new Response(PAGE_HTML, { headers: { 'content-type': 'text/html' } }))

  let failed = 0
  for (const { name, fn } of checks) {
    try {
      await fn()
      console.log(`ok   ${name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${name}\n     ${err.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  app.exit(failed === 0 ? 0 : 1)
})
