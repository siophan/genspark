const fs = require('node:fs')
const path = require('node:path')

// Reads the script folder and returns its css/js files, each sorted by name so
// injection order is stable and predictable.
function collectScripts(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { css: [], js: [] }
  }

  const groups = { css: [], js: [] }
  for (const name of names.sort()) {
    const ext = path.extname(name).slice(1)
    if (ext !== 'css' && ext !== 'js') continue
    try {
      groups[ext].push({ name, source: fs.readFileSync(path.join(dir, name), 'utf8') })
    } catch (err) {
      console.error(`[injector] cannot read ${name}:`, err.message)
    }
  }
  return groups
}

function createInjector(webContents, dir) {
  // Keys returned by insertCSS, kept so a css change can unload the old sheet.
  let cssKeys = []

  async function clearCSS() {
    const keys = cssKeys
    cssKeys = []
    for (const key of keys) {
      try {
        await webContents.removeInsertedCSS(key)
      } catch {
        // The sheet is gone already (e.g. the page navigated); nothing to undo.
      }
    }
  }

  async function injectCSS() {
    for (const file of collectScripts(dir).css) {
      try {
        cssKeys.push(await webContents.insertCSS(file.source))
      } catch (err) {
        console.error(`[injector] ${file.name}:`, err.message)
      }
    }
  }

  async function injectJS() {
    for (const file of collectScripts(dir).js) {
      try {
        await webContents.executeJavaScript(file.source, true)
      } catch (err) {
        console.error(`[injector] ${file.name}:`, err.message)
      }
    }
  }

  // A fresh page keeps none of the previously inserted sheets, so drop the
  // stale keys rather than trying to remove them.
  async function onLoad() {
    cssKeys = []
    await injectCSS()
    await injectJS()
  }

  return {
    attach() {
      webContents.on('did-finish-load', onLoad)
    },
    dispose() {
      webContents.off('did-finish-load', onLoad)
    },
    async reinjectCSS() {
      await clearCSS()
      await injectCSS()
    },
    reloadForJS() {
      webContents.reload()
    },
  }
}

module.exports = { collectScripts, createInjector }
