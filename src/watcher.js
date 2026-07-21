const fs = require('node:fs')
const path = require('node:path')

const WATCHED = new Set(['css', 'js'])

// Collects the extensions touched during a burst of edits and reports them
// once the burst settles. Editors often emit several events per save.
function createBatcher(onFlush, delay, clock = globalThis) {
  let timer = null
  let exts = new Set()

  return {
    add(filename) {
      const ext = path.extname(filename || '').slice(1)
      if (!WATCHED.has(ext)) return

      exts.add(ext)
      clock.clearTimeout(timer)
      timer = clock.setTimeout(() => {
        const batch = exts
        exts = new Set()
        timer = null
        onFlush(batch)
      }, delay)
    },
    cancel() {
      clock.clearTimeout(timer)
      timer = null
    },
  }
}

// Watches the script folder (one level deep) and reports which kinds of file
// changed. A folder that cannot be watched yields an inert watcher.
function watchScripts(dir, onChange, delay = 150) {
  const batcher = createBatcher(onChange, delay)
  let watcher = null

  try {
    watcher = fs.watch(dir, (_event, filename) => batcher.add(filename))
  } catch (err) {
    console.error(`[watcher] not watching ${dir}:`, err.message)
  }

  return {
    close() {
      batcher.cancel()
      watcher?.close()
    },
  }
}

module.exports = { createBatcher, watchScripts }
