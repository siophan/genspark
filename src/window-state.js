const fs = require('node:fs')

const DEFAULT_STATE = { width: 1400, height: 900 }
const MIN_WIDTH = 600
const MIN_HEIGHT = 400
const SAVE_DELAY = 500

function isSize(value, min) {
  return Number.isFinite(value) && value >= min
}

function isVisible(rect, displays) {
  return displays.some(
    (d) =>
      rect.x < d.x + d.width &&
      rect.x + rect.width > d.x &&
      rect.y < d.y + d.height &&
      rect.y + rect.height > d.y,
  )
}

// Keeps a saved geometry only as far as it still makes sense: a too-small
// window gets the default size, one stranded off-screen loses its position and
// is left for the system to place.
function normalizeState(saved, displays) {
  const state = { ...DEFAULT_STATE }
  if (isSize(saved?.width, MIN_WIDTH) && isSize(saved?.height, MIN_HEIGHT)) {
    state.width = saved.width
    state.height = saved.height
  }

  const positioned = { ...state, x: saved?.x, y: saved?.y }
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y) && isVisible(positioned, displays)) {
    return positioned
  }
  return state
}

function loadState(file, displays) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')), displays)
  } catch {
    return { ...DEFAULT_STATE }
  }
}

// Persists the window geometry as it changes, debounced so a drag does not
// write on every frame.
function trackWindow(win, file) {
  let timer = null

  const write = () => {
    timer = null
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    try {
      fs.writeFileSync(file, JSON.stringify(win.getNormalBounds()))
    } catch (err) {
      console.error('[window-state] cannot save:', err.message)
    }
  }

  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(write, SAVE_DELAY)
  }

  win.on('resize', save)
  win.on('move', save)
  // Closing must not drop a geometry change still waiting out the debounce.
  win.on('close', () => {
    if (timer === null) return
    clearTimeout(timer)
    write()
  })
}

module.exports = { DEFAULT_STATE, normalizeState, loadState, trackWindow }
