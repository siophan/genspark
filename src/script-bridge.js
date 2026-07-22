const { ipcMain } = require('electron')

const { collectScripts } = require('./script-store')

// Kept in sync by hand with the copies in preload.js: a sandboxed preload
// cannot require its own modules, so the names cannot be shared.
const REQUEST = 'genspark-shell:scripts:request'
const CSS_UPDATE = 'genspark-shell:scripts:css'

// The preload asks for the scripts synchronously at document-start, before the
// page has parsed anything, so serving them must not wait on the event loop.
function serveScripts(dir) {
  ipcMain.removeAllListeners(REQUEST)
  ipcMain.on(REQUEST, (event) => {
    event.returnValue = collectScripts(dir)
  })
}

// Hands the current stylesheets to an already-loaded page, so a css edit shows
// up without a reload.
function pushCSS(webContents, dir) {
  if (webContents.isDestroyed()) return
  webContents.send(CSS_UPDATE, collectScripts(dir).css)
}

module.exports = { serveScripts, pushCSS, REQUEST, CSS_UPDATE }
