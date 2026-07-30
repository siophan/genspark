const HOME_URL = 'https://www.genspark.ai/'
const ALLOWED_HOST = 'genspark.ai'

function parse(url) {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isBrowsable(url) {
  const parsed = parse(url)
  return parsed?.protocol === 'https:' || parsed?.protocol === 'http:'
}

// Only the site itself stays in the app window. The suffix is matched with a
// leading dot so a lookalike host such as notgenspark.ai does not slip through.
function isInternal(url) {
  if (!isBrowsable(url)) return false
  const { hostname } = parse(url)
  return hostname === ALLOWED_HOST || hostname.endsWith(`.${ALLOWED_HOST}`)
}

// A popup opened by the page does not inherit the parent's webPreferences, so
// they have to be restated here — otherwise the user scripts never run in it
// and the window keeps the site's own appearance.
const RENDERER_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}

function decideWindowOpen(url, preloadPath) {
  if (!isInternal(url)) return { action: 'deny' }
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: { ...RENDERER_PREFERENCES, preload: preloadPath },
    },
  }
}

module.exports = {
  HOME_URL,
  ALLOWED_HOST,
  RENDERER_PREFERENCES,
  isInternal,
  isBrowsable,
  decideWindowOpen,
}
