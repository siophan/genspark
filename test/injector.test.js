const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { collectScripts, createInjector } = require('../src/injector')

function scriptDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-test-'))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

// A stand-in for Electron's webContents, recording what the injector asks of it.
function fakeWebContents() {
  let key = 0
  const wc = {
    css: new Map(),
    executed: [],
    reloads: 0,
    handlers: new Map(),
    async insertCSS(source) {
      const k = `key-${++key}`
      wc.css.set(k, source)
      return k
    },
    async removeInsertedCSS(k) {
      wc.css.delete(k)
    },
    async executeJavaScript(source) {
      wc.executed.push(source)
    },
    reload() {
      wc.reloads++
    },
    on(event, fn) {
      wc.handlers.set(event, fn)
    },
    off(event) {
      wc.handlers.delete(event)
    },
    emit(event) {
      return wc.handlers.get(event)?.()
    },
  }
  return wc
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
  const found = collectScripts('/nope/does/not/exist')

  assert.deepStrictEqual(found, { css: [], js: [] })
})

test('injecting on page load applies css and runs js', async () => {
  const dir = scriptDir({ 'a.css': 'body{}', 'a.js': 'globalThis.x = 1' })
  const wc = fakeWebContents()
  createInjector(wc, dir).attach()

  await wc.emit('did-finish-load')

  assert.deepStrictEqual([...wc.css.values()], ['body{}'])
  assert.strictEqual(wc.executed.length, 1)
  assert.match(wc.executed[0], /globalThis\.x = 1/)
})

test('a throwing script does not stop the ones after it', async () => {
  const dir = scriptDir({ 'a.js': 'throw new Error("boom")', 'b.js': 'ok' })
  const wc = fakeWebContents()
  wc.executeJavaScript = async (source) => {
    if (source.includes('boom')) throw new Error('boom')
    wc.executed.push(source)
  }
  createInjector(wc, dir).attach()

  await wc.emit('did-finish-load')

  assert.strictEqual(wc.executed.length, 1)
  assert.match(wc.executed[0], /ok/)
})

test('reinjectCSS replaces the previous css without reloading', async () => {
  const dir = scriptDir({ 'a.css': 'old' })
  const wc = fakeWebContents()
  const injector = createInjector(wc, dir)
  injector.attach()
  await wc.emit('did-finish-load')

  fs.writeFileSync(path.join(dir, 'a.css'), 'new')
  await injector.reinjectCSS()

  assert.deepStrictEqual([...wc.css.values()], ['new'])
  assert.strictEqual(wc.reloads, 0)
})

test('reloadForJS reloads the page', () => {
  const wc = fakeWebContents()

  createInjector(wc, scriptDir({})).reloadForJS()

  assert.strictEqual(wc.reloads, 1)
})

test('dispose stops injecting on later loads', async () => {
  const dir = scriptDir({ 'a.css': 'body{}' })
  const wc = fakeWebContents()
  const injector = createInjector(wc, dir)
  injector.attach()
  injector.dispose()

  await wc.emit('did-finish-load')

  assert.strictEqual(wc.css.size, 0)
})
