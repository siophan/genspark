const { DISPLAY_NAME, renameBrand } = require('./brand')

// The native title bar is a main-process surface: Electron copies the page's
// title onto the window itself, which happens before any renderer-side rename
// can run, so the original brand flashes there no matter how early the user
// scripts inject. Renaming it here, synchronously in main, closes that gap.
//
// preventDefault stops Electron from applying the raw page title; the window
// then only ever shows the renamed one. Setting the name up front covers the
// stretch before the page has a title at all.
function guardWindowTitle(win) {
  win.setTitle(DISPLAY_NAME)
  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    win.setTitle(renameBrand(title))
  })
}

module.exports = { guardWindowTitle }
