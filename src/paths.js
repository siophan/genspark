const fs = require('node:fs')
const path = require('node:path')

const EXAMPLE_CSS = `/* Genspark shell — custom styles.
 * Every .css file in this folder is injected into the page.
 * Saving a change takes effect immediately, without reloading. */

/* body { filter: hue-rotate(15deg); } */
`

const EXAMPLE_JS = `// Genspark shell — custom script.
// Every .js file in this folder runs in the page's main world after load,
// so window and the site's globals are directly available.
// Saving a change reloads the page.

// console.log('hello from example.js', document.title)
`

const EXAMPLES = { 'example.css': EXAMPLE_CSS, 'example.js': EXAMPLE_JS }

function scriptsDir(userDataDir) {
  return path.join(userDataDir, 'scripts')
}

function windowStateFile(userDataDir) {
  return path.join(userDataDir, 'window-state.json')
}

// Creates the scripts folder and seeds it with examples the first time only.
// Returns false if the folder could not be created.
function ensureScriptDir(dir) {
  if (fs.existsSync(dir)) return true

  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error(`[paths] cannot create ${dir}:`, err.message)
    return false
  }

  for (const [name, body] of Object.entries(EXAMPLES)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  return true
}

module.exports = { scriptsDir, windowStateFile, ensureScriptDir }
