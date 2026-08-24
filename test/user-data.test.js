const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { userDataDir, legacyUserDataDir, migrateLegacyUserData } = require('../src/user-data')

// 键一律用 path.join 拼:被测代码就是这么生成路径的,写死斜杠在 Windows 上必然对不上。
const APPDATA = path.join('/appdata')
const NEW = path.join('/appdata', 'laomao')
const OLD = path.join('/appdata', 'Genspark')

// 目录用一个 Set 表示,文件用 map。只实现被测代码真正用到的那几个原语。
function fakeFs({ dirs = [], files = {} } = {}) {
  const D = new Set(dirs)
  const F = { ...files }
  const copied = []
  return {
    copied, files: F, dirs: D,
    existsSync: (p) => D.has(p) || p in F,
    mkdirSync(p) { D.add(p) },
    readdirSync(p) {
      const pre = p + path.sep
      const out = new Set()
      for (const k of [...Object.keys(F), ...D]) {
        if (k.startsWith(pre)) out.add(k.slice(pre.length).split(path.sep)[0])
      }
      return [...out]
    },
    statSync(p) { return { isDirectory: () => D.has(p) } },
    copyFileSync(a, b) { F[b] = F[a]; copied.push([a, b]) },
  }
}

test('老目录里有我们自己的文件时,搬过来', () => {
  const fs = fakeFs({
    dirs: [OLD, path.join(OLD, 'scripts')],
    files: {
      [path.join(OLD, 'client-token.json')]: '{"token":"t"}',
      [path.join(OLD, 'cached-account.json')]: '{}',
      [path.join(OLD, 'scripts', 'mine.js')]: '// 用户改过的脚本',
    },
  })
  const r = migrateLegacyUserData(APPDATA, { fs })
  assert.equal(r, 'migrated')
  assert.equal(fs.files[path.join(NEW, 'client-token.json')], '{"token":"t"}')
  assert.equal(fs.files[path.join(NEW, 'scripts', 'mine.js')], '// 用户改过的脚本')
})

// 这条是这个模块存在的理由。那台 Windows 上 %APPDATA%\Genspark 是官方 Genspark
// 客户端的 userData —— 把它的 Chromium profile 搬进我们家,只会把两个应用的数据
// 搅在一起,比不搬糟得多。
test('老目录不是我们的(没有任何自家文件)时,一个字节都不搬', () => {
  const fs = fakeFs({
    dirs: [OLD, path.join(OLD, 'Local Storage'), path.join(OLD, 'Network')],
    files: {
      [path.join(OLD, 'Preferences')]: '{"官方应用的":1}',
      [path.join(OLD, 'Local State')]: '{}',
    },
  })
  const r = migrateLegacyUserData(APPDATA, { fs })
  assert.equal(r, 'skipped')
  assert.equal(fs.copied.length, 0)
  assert.equal(fs.existsSync(NEW), false, '连目录都不该建 —— 建了下次就再也不会尝试迁移')
})

test('Chromium 的 profile 数据不搬,只搬我们自己的东西', () => {
  const fs = fakeFs({
    dirs: [OLD, path.join(OLD, 'Partitions'), path.join(OLD, 'Local Storage')],
    files: {
      [path.join(OLD, 'client-token.json')]: '{}',
      [path.join(OLD, 'Cookies')]: 'sqlite',
      [path.join(OLD, 'Preferences')]: '{}',
      [path.join(OLD, 'Partitions', 'acct-abc', 'Cookies')]: 'sqlite',
    },
  })
  migrateLegacyUserData(APPDATA, { fs })
  const landed = Object.keys(fs.files).filter((k) => k.startsWith(NEW + path.sep))
  assert.deepEqual(landed, [path.join(NEW, 'client-token.json')])
})

test('新目录已经存在时不再迁移,免得覆盖用户后来的改动', () => {
  const fs = fakeFs({
    dirs: [NEW, OLD],
    files: {
      [path.join(NEW, 'client-token.json')]: '新的',
      [path.join(OLD, 'client-token.json')]: '旧的',
    },
  })
  assert.equal(migrateLegacyUserData(APPDATA, { fs }), 'already')
  assert.equal(fs.files[path.join(NEW, 'client-token.json')], '新的')
})

test('老目录压根不存在(全新机器)时安静跳过', () => {
  const fs = fakeFs({})
  assert.equal(migrateLegacyUserData(APPDATA, { fs }), 'skipped')
})

// 迁移是锦上添花,失败了也绝不能把启动带崩 —— 大不了当成全新安装重来一遍。
test('复制过程中抛异常时不外泄,返回 failed', () => {
  const fs = fakeFs({
    dirs: [OLD],
    files: { [path.join(OLD, 'client-token.json')]: '{}' },
  })
  fs.copyFileSync = () => { throw new Error('权限不足') }
  assert.equal(migrateLegacyUserData(APPDATA, { fs }), 'failed')
})

test('路径拼装', () => {
  assert.equal(userDataDir(APPDATA), NEW)
  assert.equal(legacyUserDataDir(APPDATA), OLD)
})
