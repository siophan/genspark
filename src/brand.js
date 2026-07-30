// The brand rename applied to surfaces the user scripts cannot reach without a
// flash — chiefly the native window title, which the main process owns. The
// rule mirrors the user's rename script (examples/rename-to-laomao.js); keep
// them in step if the display name ever changes.
const BRAND = /genspark/gi
const DISPLAY_NAME = '老猫'

function renameBrand(text) {
  return typeof text === 'string' ? text.replace(BRAND, DISPLAY_NAME) : text
}

module.exports = { BRAND, DISPLAY_NAME, renameBrand }
