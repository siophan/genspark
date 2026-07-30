const fs = require('node:fs')
const path = require('node:path')

// The default scripts shipped with the app. Copied into the user's scripts
// folder on first run, so a fresh install rebrands itself out of the box while
// staying fully editable afterwards. Bundled via the "seed/**" files entry.
const SEED_DIR = path.join(__dirname, '..', 'seed')

function scriptsDir(userDataDir) {
  return path.join(userDataDir, 'scripts')
}

function windowStateFile(userDataDir) {
  return path.join(userDataDir, 'window-state.json')
}

// Creates the scripts folder and seeds it with the bundled default scripts the
// first time only. Returns false if the folder could not be created.
function ensureScriptDir(dir) {
  if (fs.existsSync(dir)) return true

  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error(`[paths] cannot create ${dir}:`, err.message)
    return false
  }

  // Byte-for-byte copy so scripts survive intact (readFileSync also reads from
  // inside the packaged asar, writeFileSync lands in the real user data dir).
  for (const name of fs.readdirSync(SEED_DIR)) {
    fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(SEED_DIR, name)))
  }
  return true
}

module.exports = { scriptsDir, windowStateFile, ensureScriptDir }
