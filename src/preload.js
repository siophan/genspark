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
const GUARD_ID = 'genspark-shell-anti-flicker'

// If a user script never lets go, the page must still appear. This caps how
// long it can stay hidden waiting for a reveal that may never be scheduled.
const REVEAL_TIMEOUT_MS = 3000

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

// The user scripts rewrite the page from a MutationObserver, whose callbacks
// are asynchronous, so streamed and rendered content is painted before it is
// rewritten — the original brand flashes past. Holding the root hidden until
// the page has settled means those intermediate paints show nothing rather
// than the original name. visibility (not display) keeps layout, so revealing
// costs no reflow, and the DOM and observers still run while it is hidden.
function hideUntilSettled() {
  const style = document.createElement('style')
  style.id = GUARD_ID
  style.textContent = ':root { visibility: hidden !important; }'
  document.documentElement.appendChild(style)

  let revealed = false
  const reveal = () => {
    if (revealed) return
    revealed = true
    document.getElementById(GUARD_ID)?.remove()
  }

  // By DOMContentLoaded the parser is done and the observer has rewritten every
  // streamed node; one frame later the rewrite is certainly painted. Reveal
  // then, or immediately if the document is already past that point.
  const revealWhenParsed = () => requestAnimationFrame(reveal)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', revealWhenParsed, { once: true })
  } else {
    revealWhenParsed()
  }

  // Never let a hung or throwing user script strand the page invisible.
  setTimeout(reveal, REVEAL_TIMEOUT_MS)
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
  // Only scripts rewrite content, so only they need the page held back; pure
  // CSS applies at document-start and never shows the wrong thing.
  if (scripts.js.length) hideUntilSettled()
  runJS(scripts.js)
})

ipcRenderer.on(CSS_UPDATE, (_event, files) => whenRootExists(() => applyCSS(files)))
