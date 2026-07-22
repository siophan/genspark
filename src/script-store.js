const fs = require('node:fs')
const path = require('node:path')

// Reads the script folder and returns its css/js files, each sorted by name so
// injection order is stable and predictable.
function collectScripts(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { css: [], js: [] }
  }

  const groups = { css: [], js: [] }
  for (const name of names.sort()) {
    const ext = path.extname(name).slice(1)
    if (ext !== 'css' && ext !== 'js') continue
    try {
      groups[ext].push({ name, source: fs.readFileSync(path.join(dir, name), 'utf8') })
    } catch (err) {
      console.error(`[scripts] cannot read ${name}:`, err.message)
    }
  }
  return groups
}

module.exports = { collectScripts }
