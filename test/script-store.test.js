const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { collectScripts } = require('../src/script-store')

function scriptDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-test-'))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

test('collectScripts groups css and js sorted by filename', () => {
  const dir = scriptDir({
    'b.js': 'b', 'a.js': 'a', '10.css': 'ten', '2.css': 'two', 'notes.txt': 'skip',
  })

  const found = collectScripts(dir)

  assert.deepStrictEqual(found.css.map((f) => f.name), ['10.css', '2.css'])
  assert.deepStrictEqual(found.js.map((f) => f.name), ['a.js', 'b.js'])
  assert.strictEqual(found.css[0].source, 'ten')
})

test('collectScripts returns empty groups for a missing dir', () => {
  assert.deepStrictEqual(collectScripts('/nope/does/not/exist'), { css: [], js: [] })
})

test('collectScripts returns empty groups for an empty dir', () => {
  assert.deepStrictEqual(collectScripts(scriptDir({})), { css: [], js: [] })
})
