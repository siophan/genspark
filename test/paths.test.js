const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { scriptsDir, windowStateFile, ensureScriptDir } = require('../src/paths')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-test-'))
}

test('scriptsDir resolves under the user data dir', () => {
  assert.strictEqual(scriptsDir('/data'), path.join('/data', 'scripts'))
})

test('windowStateFile resolves under the user data dir', () => {
  assert.strictEqual(windowStateFile('/data'), path.join('/data', 'window-state.json'))
})

test('ensureScriptDir creates the dir with example scripts when missing', () => {
  const dir = path.join(tmpdir(), 'scripts')

  ensureScriptDir(dir)

  assert.ok(fs.existsSync(path.join(dir, 'example.css')))
  assert.ok(fs.existsSync(path.join(dir, 'example.js')))
})

test('ensureScriptDir does not overwrite existing files', () => {
  const dir = path.join(tmpdir(), 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'example.css'), '/* mine */')

  ensureScriptDir(dir)

  assert.strictEqual(fs.readFileSync(path.join(dir, 'example.css'), 'utf8'), '/* mine */')
})

test('ensureScriptDir does not re-create examples the user deleted', () => {
  const dir = path.join(tmpdir(), 'scripts')
  ensureScriptDir(dir)
  fs.rmSync(path.join(dir, 'example.js'))

  ensureScriptDir(dir)

  assert.strictEqual(fs.existsSync(path.join(dir, 'example.js')), false)
})

test('ensureScriptDir reports failure instead of throwing', () => {
  const file = path.join(tmpdir(), 'not-a-dir')
  fs.writeFileSync(file, 'x')

  assert.strictEqual(ensureScriptDir(path.join(file, 'scripts')), false)
})
