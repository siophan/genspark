// Runs at document-start, before the page has parsed a single tag. Its job is
// to get the user's stylesheets and scripts in place early enough that the
// original page content is never painted.
//
// A sandboxed preload cannot require project files, so the channel names are
// duplicated from script-bridge.js and must be kept in sync with it.
const { ipcRenderer } = require('electron')

const REQUEST = 'genspark-shell:scripts:request'
const CSS_UPDATE = 'genspark-shell:scripts:css'
const STYLE_ID = 'genspark-shell-user-css'

// Synchronous on purpose: the scripts have to be in hand before the parser
// produces anything worth rewriting.
const scripts = ipcRenderer.sendSync(REQUEST)

// document.documentElement does not exist yet when a preload runs, but the
// document node does, so watch it for the root element appearing.
function whenRootExists(run) {
  if (document.documentElement) {
    run()
    return
  }
  new MutationObserver((_records, observer) => {
    if (!document.documentElement) return
    observer.disconnect()
    run()
  }).observe(document, { childList: true })
}

function styleElement() {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.documentElement.appendChild(style)
  }
  // Keep it last so page styles never win by ordering alone.
  else if (style.parentNode?.lastChild !== style) style.parentNode.appendChild(style)
  return style
}

function applyCSS(files) {
  if (!document.documentElement) return
  styleElement().textContent = files.map((file) => file.source).join('\n')
}

// A <script> element runs in the page's main world, unlike this preload, so the
// user's scripts keep access to the site's own globals.
function runJS(files) {
  for (const file of files) {
    try {
      const element = document.createElement('script')
      element.dataset.gensparkShell = file.name
      element.textContent = file.source
      document.documentElement.appendChild(element)
      element.remove()
    } catch (err) {
      console.error(`[preload] ${file.name}:`, err.message)
    }
  }
}

whenRootExists(() => {
  applyCSS(scripts.css)
  runJS(scripts.js)
})

ipcRenderer.on(CSS_UPDATE, (_event, files) => whenRootExists(() => applyCSS(files)))
