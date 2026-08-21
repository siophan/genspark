const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// electron-builder skips signing entirely when no Developer ID cert is
// available; an unsigned bundle triggers Gatekeeper's "damaged" dialog on
// download. Ad-hoc sign so users get the bypassable "unidentified
// developer" prompt instead.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = fs.readdirSync(context.appOutDir).find((f) => f.endsWith('.app'))
  const appPath = path.join(context.appOutDir, appName)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
}
