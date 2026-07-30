const { Menu, app } = require('electron')

// The standard edit/window items must stay: without them the page loses the
// system copy/paste and window shortcuts.
function buildMenu({ onOpenScriptsDir }) {
  const isMac = process.platform === 'darwin'
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Open Scripts Folder',
          accelerator: 'CmdOrCtrl+,',
          click: onOpenScriptsDir,
        },
        { type: 'separator' },
        // hide/services/unhide are macOS-only roles; on Windows and Linux they
        // do not apply, so the app menu there is just About / Scripts / Quit.
        ...(isMac
          ? [
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
            ]
          : []),
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: (_item, win) => win?.webContents.navigationHistory.goBack(),
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: (_item, win) => win?.webContents.navigationHistory.goForward(),
        },
      ],
    },
    { role: 'windowMenu' },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

module.exports = { buildMenu }
