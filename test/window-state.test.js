const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DEFAULT_STATE, normalizeState, loadState } = require('../src/window-state')

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1080 }]

function tmpfile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-test-')), 'state.json')
  if (contents !== undefined) fs.writeFileSync(file, contents)
  return file
}

test('a saved state inside the screen is kept', () => {
  const saved = { width: 1000, height: 700, x: 100, y: 50 }

  assert.deepStrictEqual(normalizeState(saved, SCREEN), saved)
})

test('a window left off-screen falls back to the default position', () => {
  const saved = { width: 1000, height: 700, x: 5000, y: 4000 }

  const state = normalizeState(saved, SCREEN)

  assert.strictEqual(state.x, undefined)
  assert.strictEqual(state.y, undefined)
  assert.strictEqual(state.width, 1000)
})

test('a size below the minimum falls back to the default size', () => {
  const state = normalizeState({ width: 10, height: 10, x: 0, y: 0 }, SCREEN)

  assert.strictEqual(state.width, DEFAULT_STATE.width)
  assert.strictEqual(state.height, DEFAULT_STATE.height)
})

test('a state with missing fields falls back to the defaults', () => {
  assert.deepStrictEqual(normalizeState({ x: 10 }, SCREEN), DEFAULT_STATE)
})

test('loadState returns the defaults when the file is missing', () => {
  assert.deepStrictEqual(loadState(tmpfile(), SCREEN), DEFAULT_STATE)
})

test('loadState returns the defaults when the file is corrupt', () => {
  assert.deepStrictEqual(loadState(tmpfile('{not json'), SCREEN), DEFAULT_STATE)
})

test('loadState reads a valid saved state', () => {
  const saved = { width: 1200, height: 800, x: 20, y: 30 }

  assert.deepStrictEqual(loadState(tmpfile(JSON.stringify(saved)), SCREEN), saved)
})

// A stand-in for Electron's BrowserWindow.
function fakeWindow(bounds) {
  const handlers = new Map()
  return {
    getNormalBounds: () => bounds,
    isDestroyed: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    on: (event, fn) => handlers.set(event, fn),
    emit: (event) => handlers.get(event)?.(),
  }
}

test('closing saves the latest geometry instead of dropping it', () => {
  const { trackWindow } = require('../src/window-state')
  const file = tmpfile()
  const bounds = { width: 1111, height: 777, x: 3, y: 4 }
  const win = fakeWindow(bounds)
  trackWindow(win, file)

  win.emit('resize')
  win.emit('close')

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), bounds)
})
