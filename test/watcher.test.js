const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createBatcher, watchScripts } = require('../src/watcher')

// A hand-cranked clock, so debounce behaviour is tested without real waiting.
function fakeClock() {
  let pending = null
  return {
    setTimeout: (fn) => {
      pending = fn
      return 'timer'
    },
    clearTimeout: () => {
      pending = null
    },
    tick: () => {
      const fn = pending
      pending = null
      fn?.()
    },
  }
}

test('batcher coalesces rapid changes into one flush', () => {
  const clock = fakeClock()
  const flushes = []
  const batcher = createBatcher((exts) => flushes.push(exts), 150, clock)

  batcher.add('a.css')
  batcher.add('b.css')
  batcher.add('c.js')
  clock.tick()

  assert.strictEqual(flushes.length, 1)
  assert.deepStrictEqual([...flushes[0]].sort(), ['css', 'js'])
})

test('batcher ignores files that are neither css nor js', () => {
  const clock = fakeClock()
  const flushes = []
  const batcher = createBatcher((exts) => flushes.push(exts), 150, clock)

  batcher.add('notes.txt')
  batcher.add('.DS_Store')
  clock.tick()

  assert.strictEqual(flushes.length, 0)
})

test('batcher starts a new batch after flushing', () => {
  const clock = fakeClock()
  const flushes = []
  const batcher = createBatcher((exts) => flushes.push(exts), 150, clock)

  batcher.add('a.css')
  clock.tick()
  batcher.add('b.js')
  clock.tick()

  assert.deepStrictEqual(flushes.map((s) => [...s]), [['css'], ['js']])
})

test('watchScripts reports a real file change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-test-'))
  const seen = []
  const watcher = watchScripts(dir, (exts) => seen.push(exts), 10)

  // FSEvents takes a moment to register the watch, so keep touching the file
  // until the change is reported rather than assuming a fixed delay.
  const deadline = Date.now() + 5000
  while (seen.length === 0 && Date.now() < deadline) {
    fs.writeFileSync(path.join(dir, 'a.css'), `body{} /* ${Date.now()} */`)
    await new Promise((r) => setTimeout(r, 50))
  }
  watcher.close()

  assert.deepStrictEqual([...seen[0]], ['css'])
})

test('watchScripts on a missing dir is inert rather than fatal', () => {
  const watcher = watchScripts('/nope/does/not/exist', () => {})

  assert.doesNotThrow(() => watcher.close())
})
