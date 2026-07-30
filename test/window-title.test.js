const test = require('node:test')
const assert = require('node:assert')

const { renameBrand, DISPLAY_NAME } = require('../src/brand')
const { guardWindowTitle } = require('../src/window-title')

test('renameBrand rewrites the brand wherever it appears, case-insensitively', () => {
  assert.strictEqual(renameBrand('Genspark'), '老猫')
  assert.strictEqual(renameBrand('Genspark - 您的一站式 AI 工作空间'), '老猫 - 您的一站式 AI 工作空间')
  assert.strictEqual(renameBrand('GENSPARK Agent'), '老猫 Agent')
})

test('renameBrand leaves unrelated text and non-strings alone', () => {
  assert.strictEqual(renameBrand('Sparkling water'), 'Sparkling water')
  assert.strictEqual(renameBrand(undefined), undefined)
  assert.strictEqual(renameBrand(null), null)
})

// A fake window records the title and captures the page-title-updated handler,
// so the wiring is tested without spinning up Electron.
function fakeWindow() {
  const win = {
    title: null,
    listeners: {},
    setTitle(t) { this.title = t },
    webContents: { on: (event, cb) => { win.listeners[event] = cb } },
  }
  return win
}

test('the window shows the display name before the page provides a title', () => {
  const win = fakeWindow()
  guardWindowTitle(win)
  assert.strictEqual(win.title, DISPLAY_NAME)
})

test('a page title is renamed before it can reach the window', () => {
  const win = fakeWindow()
  guardWindowTitle(win)

  let prevented = false
  win.listeners['page-title-updated'](
    { preventDefault: () => { prevented = true } },
    'Genspark - 您的一站式 AI 工作空间',
  )

  // The raw title must never be applied to the window; only the renamed one is.
  assert.strictEqual(prevented, true)
  assert.strictEqual(win.title, '老猫 - 您的一站式 AI 工作空间')
})
