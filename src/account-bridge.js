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
