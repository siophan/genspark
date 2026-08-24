const fsDefault = require('node:fs')
const path = require('node:path')

// userData 的目录名。历史上这里是 "Genspark" —— 当年应用就叫这个名字,后来改名叫
// 老猫,为了不让老目录里的用户脚本变成孤儿,就把路径钉死在了原名上。
//
// 那个决定在开发机上没问题,在用户机器上是错的:Genspark 是个通用名字,装了官方
// Genspark 桌面客户端的机器上,这个目录本来就是人家的 userData,而我们直接住了进去 ——
// 两个 Electron 应用共用一个 Chromium profile 目录。改用 laomao,和 executableName 一致。
const DIR_NAME = 'laomao'
const LEGACY_DIR_NAME = 'Genspark'

function userDataDir(appDataDir) { return path.join(appDataDir, DIR_NAME) }
function legacyUserDataDir(appDataDir) { return path.join(appDataDir, LEGACY_DIR_NAME) }

// 只搬我们自己的东西。Chromium 的 profile(Cookies、Local Storage、Partitions…)
// 一律不碰:老目录如果是别人的,把它的 profile 搬进来只会把两个应用的数据搅在一起。
const OWN_FILES = [
  'client-token.json',
  'cached-account.json',
  'last-account.json',
  'server-config.json',
  'window-state.json',
]
const OWN_DIRS = ['scripts']

// 归属判据。window-state.json 这种名字太通用,不能用来认领一个目录;上面那四个
// JSON 是这个应用独有的,存在任意一个才算"这目录是我们的"。
const MARKERS = OWN_FILES.slice(0, 4)

function looksLikeOurs(dir, fs) {
  return MARKERS.some((name) => fs.existsSync(path.join(dir, name)))
}

function copyDir(src, dest, fs) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name)
    const to = path.join(dest, name)
    if (fs.statSync(from).isDirectory()) copyDir(from, to, fs)
    else fs.copyFileSync(from, to)
  }
}

// 一次性迁移。返回 'migrated' | 'already' | 'skipped' | 'failed',仅用于日志。
// 永不抛:迁移是锦上添花,搬不动最多相当于一次全新安装,不该把启动带崩。
function migrateLegacyUserData(appDataDir, { fs = fsDefault } = {}) {
  const dest = userDataDir(appDataDir)
  const src = legacyUserDataDir(appDataDir)
  try {
    // 新目录一旦存在就再不迁移 —— 否则会拿老数据盖掉用户后来的改动。
    if (fs.existsSync(dest)) return 'already'
    if (!fs.existsSync(src) || !looksLikeOurs(src, fs)) return 'skipped'

    fs.mkdirSync(dest, { recursive: true })
    for (const name of OWN_FILES) {
      const from = path.join(src, name)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name))
    }
    for (const name of OWN_DIRS) {
      const from = path.join(src, name)
      if (fs.existsSync(from)) copyDir(from, path.join(dest, name), fs)
    }
    return 'migrated'
  } catch (err) {
    console.error('[user-data] 迁移旧 userData 失败,按全新安装继续:', err.message)
    return 'failed'
  }
}

module.exports = { userDataDir, legacyUserDataDir, migrateLegacyUserData, DIR_NAME, LEGACY_DIR_NAME }
