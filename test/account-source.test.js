const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  serverConfigFile, cachedAccountFile,
  readServerConfig, readCachedAccount, writeCachedAccount,
  requestLease, renewLease, renewTrackedLeases, releaseLease, resolveRemoteAccount,
  readBundledConfig, readClientToken, writeClientToken, registerClient, resolveConfig,
} = require('../src/account-source')

// 这些键必须用 path.join 拼:被测代码就是这么生成路径的,而 Windows 上分隔符是 \\。
// 写死 '/u/xxx.json' 会让 fake fs 的键在 Windows 上永远匹配不上 —— 18 个测试就是
// 这样在 CI 的 Windows runner 上集体变红的,而 macOS 上一直是绿的。
const SERVER_CFG = path.join('/u', 'server-config.json')
const CACHED = path.join('/u', 'cached-account.json')
const TOKEN_FILE = path.join('/u', 'client-token.json')
const BUNDLED = path.join('/pkg', 'client-config.json')
const fakeOs = { hostname: () => 'test-mac' }
// resolveConfig 的默认参数会去读真实的打包配置路径,测试必须把它指到假路径,
// 否则开发机上恰好存在 client-config.json 就会把测试结果染成"看情况"。
function cfgOpts(fs, fetch, extra = {}) {
  return { fs, fetch, os: fakeOs, bundledFile: BUNDLED, ...extra }
}

function fakeFs(files, writes = [], chmods = []) {
  return {
    readFileSync(p) { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    writeFileSync(p, d, opts) { files[p] = d; writes.push({ p, d, opts }) },
    chmodSync(p, mode) { chmods.push({ p, mode }) },
    existsSync(p) { return p in files },
  }
}
function fakeFsWriteThrows(files) {
  return {
    readFileSync(p) { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    writeFileSync() { throw new Error('disk full') },
    existsSync(p) { return p in files },
  }
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body } }
}
function badJsonResponse(status) {
  return { ok: status >= 200 && status < 300, status, async json() { throw new Error('bad json') } }
}

test('readServerConfig returns null when file missing', () => {
  assert.equal(readServerConfig('/u', { fs: fakeFs({}) }), null)
})

test('readServerConfig returns null when fields empty', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: '', token: '' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig returns null when only apiBase is empty', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: '', token: 't' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig returns null when only token is empty', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: '' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig returns null on malformed JSON', () => {
  const fs = fakeFs({ [SERVER_CFG]: '{not json' })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig parses apiBase+token', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }) })
  assert.deepEqual(readServerConfig('/u', { fs }), { apiBase: 'https://x', token: 't' })
})

test('serverConfigFile and cachedAccountFile join userDataDir with the expected filenames', () => {
  assert.equal(serverConfigFile('/u'), path.join('/u', 'server-config.json'))
  assert.equal(cachedAccountFile('/u'), path.join('/u', 'cached-account.json'))
})

test('readCachedAccount parses email+password directly', () => {
  const fs = fakeFs({ [CACHED]: JSON.stringify({ email: 'c@x', password: 'cp' }) })
  assert.deepEqual(readCachedAccount('/u', { fs }), { email: 'c@x', password: 'cp' })
})

test('readCachedAccount returns null on malformed JSON', () => {
  const fs = fakeFs({ [CACHED]: '{not json' })
  assert.equal(readCachedAccount('/u', { fs }), null)
})

test('requestLease posts bearer and returns body on 200', async () => {
  let seen
  const fetch = async (url, init) => { seen = { url, init }; return jsonResponse(200, { email: 'a@x', password: 'p', lease_id: 5, expires_at: 9 }) }
  const out = await requestLease({ apiBase: 'https://x', token: 'tok' }, { fetch })
  assert.equal(out.email, 'a@x')
  assert.equal(seen.url, 'https://x/api/lease')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok')
})

test('requestLease returns null on non-200', async () => {
  const fetch = async () => jsonResponse(409, { error: 'no_account_available' })
  assert.equal(await requestLease({ apiBase: 'https://x', token: 't' }, { fetch }), null)
})

test('requestLease returns null when fetch throws (offline)', async () => {
  const fetch = async () => { throw new Error('network') }
  assert.equal(await requestLease({ apiBase: 'https://x', token: 't' }, { fetch }), null)
})

test('requestLease returns null when the response body is not valid JSON', async () => {
  const fetch = async () => badJsonResponse(200)
  assert.equal(await requestLease({ apiBase: 'https://x', token: 't' }, { fetch }), null)
})

// renewLease 的三态:只有 410(文档化的 lease_expired)才是"租约真没了",
// 网络异常和 5xx 都只是"这一次没成",必须可重试。
test('renewLease posts the lease_id and reports renewed with the new expiry', async () => {
  let seen
  const fetch = async (url, init) => { seen = { url, init }; return jsonResponse(200, { expires_at: 123 }) }
  const out = await renewLease({ apiBase: 'https://x', token: 'tok', leaseId: 7 }, { fetch })
  assert.deepEqual(out, { status: 'renewed', expiresAt: 123 })
  assert.equal(seen.url, 'https://x/api/renew')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(seen.init.body), { lease_id: 7 })
})

test('renewLease reports gone on 410 lease_expired', async () => {
  const fetch = async () => jsonResponse(410, { error: 'lease_expired' })
  assert.deepEqual(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), { status: 'gone' })
})

test('renewLease reports retry when fetch throws (offline)', async () => {
  const fetch = async () => { throw new Error('network') }
  assert.deepEqual(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), { status: 'retry' })
})

test('renewLease reports retry on a 500', async () => {
  const fetch = async () => jsonResponse(500, { error: 'boom' })
  assert.deepEqual(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), { status: 'retry' })
})

test('renewLease reports retry when the response body is not valid JSON', async () => {
  const fetch = async () => badJsonResponse(200)
  assert.deepEqual(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), { status: 'retry' })
})

// 下面这组断言的是"跟踪后果",而不只是返回值 —— 被 main.js 的续租定时器直接调用。
function heldLease(expiresAt) {
  return { apiBase: 'https://x', token: 't', leaseId: 7, expiresAt }
}

test('renewTrackedLeases drops a lease the server says is gone (410)', async () => {
  const lease = heldLease(Date.now() + 60000)
  const leases = new Set([lease])
  await renewTrackedLeases(leases, { fetch: async () => jsonResponse(410, { error: 'lease_expired' }) })
  assert.equal(leases.has(lease), false)
  assert.equal(leases.size, 0)
})

test('renewTrackedLeases keeps tracking when fetch throws, so the next tick retries', async () => {
  const lease = heldLease(Date.now() + 60000)
  const leases = new Set([lease])
  await renewTrackedLeases(leases, { fetch: async () => { throw new Error('wifi dropped') } })
  assert.equal(leases.has(lease), true)
})

test('renewTrackedLeases keeps tracking on a 500', async () => {
  const lease = heldLease(Date.now() + 60000)
  const leases = new Set([lease])
  await renewTrackedLeases(leases, { fetch: async () => jsonResponse(500, { error: 'boom' }) })
  assert.equal(leases.has(lease), true)
})

test('renewTrackedLeases keeps a renewed lease and updates its expiry', async () => {
  const lease = heldLease(Date.now() + 60000)
  const leases = new Set([lease])
  await renewTrackedLeases(leases, { fetch: async () => jsonResponse(200, { expires_at: 777 }) })
  assert.equal(leases.has(lease), true)
  assert.equal(lease.expiresAt, 777)
})

test('renewTrackedLeases survives a transient failure and renews on the next round', async () => {
  const lease = heldLease(Date.now() + 60000)
  const leases = new Set([lease])
  let round = 0
  const fetch = async () => {
    round++
    if (round === 1) throw new Error('wifi dropped')
    return jsonResponse(200, { expires_at: 888 })
  }
  await renewTrackedLeases(leases, { fetch })
  assert.equal(leases.has(lease), true)              // 抖动一次没有让它被放弃
  await renewTrackedLeases(leases, { fetch })
  assert.equal(lease.expiresAt, 888)                 // 下一轮续上了
})

// 安全网:哪怕续租一直"这一次没成",到期时间已经过去的租约就是死的。
test('renewTrackedLeases stops tracking a lease whose expiry has already passed', async () => {
  const lease = heldLease(Date.now() - 1)
  const leases = new Set([lease])
  let called = false
  await renewTrackedLeases(leases, { fetch: async () => { called = true; return jsonResponse(200, { expires_at: 999 }) } })
  assert.equal(leases.has(lease), false)
  assert.equal(called, false)                        // 连请求都不必发
})

test('renewTrackedLeases handles a mixed set: gone dropped, retryable kept', async () => {
  const goneLease = { apiBase: 'https://x', token: 't', leaseId: 1, expiresAt: Date.now() + 60000 }
  const flakyLease = { apiBase: 'https://x', token: 't', leaseId: 2, expiresAt: Date.now() + 60000 }
  const leases = new Set([goneLease, flakyLease])
  const fetch = async (_url, init) => {
    const { lease_id: id } = JSON.parse(init.body)
    if (id === 1) return jsonResponse(410, { error: 'lease_expired' })
    throw new Error('network')
  }
  await renewTrackedLeases(leases, { fetch })
  assert.equal(leases.has(goneLease), false)
  assert.equal(leases.has(flakyLease), true)
})

test('releaseLease swallows a fetch failure instead of throwing', async () => {
  const fetch = async () => { throw new Error('network') }
  await assert.doesNotReject(releaseLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }))
})

test('releaseLease posts the lease_id on success and settles quietly', async () => {
  let seen
  const fetch = async (url, init) => { seen = { url, init }; return jsonResponse(200, { ok: true }) }
  await assert.doesNotReject(releaseLease({ apiBase: 'https://x', token: 'tok', leaseId: 7 }, { fetch }))
  assert.equal(seen.url, 'https://x/api/release')
  assert.deepEqual(JSON.parse(seen.init.body), { lease_id: 7 })
})

test('resolveRemoteAccount: lease success caches and returns lease', async () => {
  const files = { [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }) }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, { email: 'a@x', password: 'p', lease_id: 5, expires_at: 9 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(out.email, 'a@x')
  assert.equal(out.password, 'p')
  assert.deepEqual(out.lease, { apiBase: 'https://x', token: 't', leaseId: 5, expiresAt: 9 })
  assert.ok(files[CACHED])                 // 已缓存
})

test('resolveRemoteAccount: cache write failure still returns the leased account', async () => {
  const files = { [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }) }
  const fs = fakeFsWriteThrows(files)
  const fetch = async () => jsonResponse(200, { email: 'a@x', password: 'p', lease_id: 5, expires_at: 9 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(out.email, 'a@x')
  assert.equal(out.password, 'p')
  assert.deepEqual(out.lease, { apiBase: 'https://x', token: 't', leaseId: 5, expiresAt: 9 })
})

test('resolveRemoteAccount: server down falls back to cache with null lease', async () => {
  const files = {
    [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }),
    [CACHED]: JSON.stringify({ email: 'c@x', password: 'cp' }),
  }
  const fs = fakeFs(files)
  const fetch = async () => { throw new Error('down') }
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(out.email, 'c@x')
  assert.equal(out.lease, null)
})

test('resolveRemoteAccount: no config returns null', async () => {
  const out = await resolveRemoteAccount('/u', { fetch: async () => { throw new Error() }, fs: fakeFs({}) })
  assert.equal(out, null)
})

// 200 但 body 缺字段:必须当作没租到,且绝不能把好的缓存覆盖成 "{}"。
test('resolveRemoteAccount: a 200 lease with no email falls back to cache and leaves it intact', async () => {
  const good = JSON.stringify({ email: 'c@x', password: 'cp' })
  const files = {
    [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }),
    [CACHED]: good,
  }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, { lease_id: 1, expires_at: 9 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  // 缓存断言放在最前:返回值断言先失败的话,这条就跑不到,负向对照里等于没验。
  assert.equal(files[CACHED], good)   // 缓存未被污染
  assert.equal(out.email, 'c@x')
  assert.equal(out.lease, null)
})

test('resolveRemoteAccount: a 200 lease with no password leaves the cache intact', async () => {
  const good = JSON.stringify({ email: 'c@x', password: 'cp' })
  const files = {
    [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }),
    [CACHED]: good,
  }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, { email: 'a@x', lease_id: 1 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(files[CACHED], good)
  assert.equal(out.email, 'c@x')
})

test('resolveRemoteAccount: a malformed 200 with no cache returns null and writes nothing', async () => {
  const files = { [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x', token: 't' }) }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, {})
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(CACHED in files, false)
  assert.equal(out, null)
})

// apiBase 手写成 `https://x/` 是极可能的:拼出 `//api/lease` 会被 Hono 判 404,
// 客户端读成"服务器不可用",于是永远走缓存/桌面文件 —— 功能形同没配。
test('readServerConfig strips a trailing slash from apiBase', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x.workers.dev/', token: 't' }) })
  assert.deepEqual(readServerConfig('/u', { fs }), { apiBase: 'https://x.workers.dev', token: 't' })
})

test('readServerConfig strips several trailing slashes', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x.workers.dev///', token: 't' }) })
  assert.equal(readServerConfig('/u', { fs }).apiBase, 'https://x.workers.dev')
})

test('readServerConfig returns null when apiBase is nothing but slashes', () => {
  const fs = fakeFs({ [SERVER_CFG]: JSON.stringify({ apiBase: '/', token: 't' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('a trailing-slash apiBase still produces exactly one slash in the request URL', async () => {
  const files = { [SERVER_CFG]: JSON.stringify({ apiBase: 'https://x.workers.dev/', token: 't' }) }
  const fs = fakeFs(files)
  let seenUrl
  const fetch = async (url) => { seenUrl = url; return jsonResponse(200, { email: 'a@x', password: 'p', lease_id: 1, expires_at: 9 }) }
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(seenUrl, 'https://x.workers.dev/api/lease')
  assert.equal(seenUrl.includes('//api/'), false)
  assert.equal(out.email, 'a@x')
})

// 缓存文件里是明文密码,不能是默认的 0644。
test('writeCachedAccount writes the credential cache as 0600', () => {
  const files = {}
  const writes = []
  writeCachedAccount('/u', { email: 'a@x', password: 'p' }, { fs: fakeFs(files, writes) })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].opts && writes[0].opts.mode, 0o600)
  assert.deepEqual(JSON.parse(files[CACHED]), { email: 'a@x', password: 'p' })
})

// writeFileSync 的 mode 只在它新建文件时生效,所以老版本留下的 0644 缓存
// 每次覆写后仍是 0644。必须显式收紧。
test('writeCachedAccount tightens an already-existing cache file', () => {
  const files = { [CACHED]: JSON.stringify({ email: 'old@x', password: 'old' }) }
  const chmods = []
  writeCachedAccount('/u', { email: 'a@x', password: 'p' }, { fs: fakeFs(files, [], chmods) })
  assert.deepEqual(chmods, [{ p: CACHED, mode: 0o600 }])
})

// chmod 失败不该让已经写成功的缓存变成"写失败"。
test('writeCachedAccount keeps the cache when chmod fails', () => {
  const files = {}
  const fs = fakeFs(files)
  fs.chmodSync = () => { throw new Error('EPERM') }
  assert.doesNotThrow(() => writeCachedAccount('/u', { email: 'a@x', password: 'p' }, { fs }))
  assert.deepEqual(JSON.parse(files[CACHED]), { email: 'a@x', password: 'p' })
})

test('writeCachedAccount still swallows a write failure', () => {
  assert.doesNotThrow(() => writeCachedAccount('/u', { email: 'a@x', password: 'p' }, { fs: fakeFsWriteThrows({}) }))
})

// 离线路径必须原样不动:没有 server-config.json 就一个网络请求都不该发。
test('resolveRemoteAccount makes zero network calls when there is no server-config.json', async () => {
  let calls = 0
  const fetch = async () => { calls++; return jsonResponse(200, { email: 'a@x', password: 'p' }) }
  const out = await resolveRemoteAccount('/u', { fetch, fs: fakeFs({}) })
  assert.equal(calls, 0)
  assert.equal(out, null)
})

test('resolveRemoteAccount makes zero network calls when server-config.json is malformed', async () => {
  let calls = 0
  const fetch = async () => { calls++; return jsonResponse(200, {}) }
  await resolveRemoteAccount('/u', { fetch, fs: fakeFs({ [SERVER_CFG]: '{not json' }) })
  assert.equal(calls, 0)
})

// ---- 自助注册 ----

test('readBundledConfig 缺文件/缺字段都返回 null', () => {
  assert.equal(readBundledConfig({ fs: fakeFs({}), file: BUNDLED }), null)
  const fs = fakeFs({ [BUNDLED]: JSON.stringify({ apiBase: 'https://x', registerCode: '' }) })
  assert.equal(readBundledConfig({ fs, file: BUNDLED }), null)
})

test('readBundledConfig 规范掉尾部斜杠', () => {
  const fs = fakeFs({ [BUNDLED]: JSON.stringify({ apiBase: 'https://x.dev///', registerCode: 'c' }) })
  assert.deepEqual(readBundledConfig({ fs, file: BUNDLED }), { apiBase: 'https://x.dev', registerCode: 'c' })
})

test('writeClientToken 用 0600 并补 chmod', () => {
  const files = {}, writes = [], chmods = []
  const fs = fakeFs(files, writes, chmods)
  assert.equal(writeClientToken('/u', 'tok', { fs }), true)
  assert.equal(writes[0].opts.mode, 0o600)
  assert.deepEqual(chmods, [{ p: TOKEN_FILE, mode: 0o600 }])
  assert.equal(readClientToken('/u', { fs }), 'tok')
})

test('writeClientToken 写失败返回 false 而不抛', () => {
  const fs = fakeFsWriteThrows({})
  assert.equal(writeClientToken('/u', 'tok', { fs }), false)
})

test('readClientToken 忽略空的或非字符串的 token', () => {
  for (const v of [{ token: '' }, { token: 123 }, {}]) {
    const fs = fakeFs({ [TOKEN_FILE]: JSON.stringify(v) })
    assert.equal(readClientToken('/u', { fs }), null)
  }
})

test('首次启动:没有 token 就注册一个并落盘', async () => {
  const files = { [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'code1' }) }
  const writes = []
  const fs = fakeFs(files, writes)
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return jsonResponse(200, { token: 'fresh-token', client_id: 9 })
  }
  const cfg = await resolveConfig('/u', cfgOpts(fs, fetch))
  assert.deepEqual(cfg, { apiBase: 'https://s.dev', token: 'fresh-token' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://s.dev/api/register')
  assert.deepEqual(calls[0].body, { code: 'code1', device: 'test-mac' })
  assert.equal(readClientToken('/u', { fs }), 'fresh-token')
  assert.equal(writes.find((w) => w.p === TOKEN_FILE).opts.mode, 0o600)
})

test('第二次启动:已有 token 就不再注册', async () => {
  const files = {
    [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'code1' }),
    [TOKEN_FILE]: JSON.stringify({ token: 'stored' }),
  }
  let called = 0
  const fetch = async () => { called++; return jsonResponse(200, { token: 'should-not-happen' }) }
  const cfg = await resolveConfig('/u', cfgOpts(fakeFs(files), fetch))
  assert.deepEqual(cfg, { apiBase: 'https://s.dev', token: 'stored' })
  assert.equal(called, 0, '已有 token 时不该发任何请求')
})

test('手写的 server-config.json 优先于内置配置,且不触发注册', async () => {
  const files = {
    [SERVER_CFG]: JSON.stringify({ apiBase: 'https://manual.dev/', token: 'manual-tok' }),
    [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'code1' }),
  }
  let called = 0
  const fetch = async () => { called++; return jsonResponse(200, { token: 'x' }) }
  const cfg = await resolveConfig('/u', cfgOpts(fakeFs(files), fetch))
  assert.deepEqual(cfg, { apiBase: 'https://manual.dev', token: 'manual-tok' })
  assert.equal(called, 0)
})

test('注册失败(邀请码被拒)不抛,返回 null,不写 token', async () => {
  const files = { [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'bad' }) }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(403, { error: 'forbidden' })
  assert.equal(await resolveConfig('/u', cfgOpts(fs, fetch)), null)
  assert.equal(readClientToken('/u', { fs }), null)
})

test('注册时离线不抛,返回 null', async () => {
  const files = { [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'c' }) }
  const fetch = async () => { throw new Error('offline') }
  assert.equal(await resolveConfig('/u', cfgOpts(fakeFs(files), fetch)), null)
})

test('注册返回 200 但 body 里没有 token,视为失败', async () => {
  const files = { [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'c' }) }
  const fs = fakeFs(files)
  for (const body of [{}, { token: '' }, { token: 42 }]) {
    const fetch = async () => jsonResponse(200, body)
    assert.equal(await resolveConfig('/u', cfgOpts(fs, fetch)), null)
    assert.equal(readClientToken('/u', { fs }), null)
  }
})

test('没有内置配置时不注册也不报错(等于退回纯本地模式)', async () => {
  let called = 0
  const fetch = async () => { called++; return jsonResponse(200, { token: 't' }) }
  assert.equal(await resolveConfig('/u', cfgOpts(fakeFs({}), fetch)), null)
  assert.equal(called, 0)
})

test('租号被 401 拒绝时绝不重新注册', async () => {
  // 这条是吊销能力的命门:后台停用一台机器后,它下次启动必须仍然被拒,
  // 而不是自己去领一个新 token 把停用绕过去。
  const files = {
    [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'c' }),
    [TOKEN_FILE]: JSON.stringify({ token: 'revoked' }),
  }
  const fs = fakeFs(files)
  const hits = []
  const fetch = async (url) => {
    hits.push(url)
    return jsonResponse(401, { error: 'unauthorized' })
  }
  const got = await resolveRemoteAccount('/u', cfgOpts(fs, fetch))
  assert.equal(got, null)
  assert.deepEqual(hits, ['https://s.dev/api/lease'], '只该试一次租号,绝不能再打 /api/register')
  assert.equal(readClientToken('/u', { fs }), 'revoked', 'token 不该被换掉')
})

test('token 落盘失败时,本次仍然可用', async () => {
  const files = { [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'c' }) }
  const fs = fakeFsWriteThrows(files)
  const fetch = async () => jsonResponse(200, { token: 'fresh' })
  const cfg = await resolveConfig('/u', cfgOpts(fs, fetch))
  assert.deepEqual(cfg, { apiBase: 'https://s.dev', token: 'fresh' })
})

test('端到端:零配置启动应当注册 → 租号 → 缓存账号', async () => {
  const files = { [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'c' }) }
  const fs = fakeFs(files)
  const seen = []
  const fetch = async (url) => {
    seen.push(url)
    if (url.endsWith('/api/register')) return jsonResponse(200, { token: 'tok-1' })
    if (url.endsWith('/api/lease')) return jsonResponse(200, { email: 'a@x.com', password: 'pw', lease_id: 7, expires_at: 123 })
    throw new Error('unexpected ' + url)
  }
  const got = await resolveRemoteAccount('/u', cfgOpts(fs, fetch))
  assert.deepEqual(seen, ['https://s.dev/api/register', 'https://s.dev/api/lease'])
  assert.equal(got.email, 'a@x.com')
  assert.deepEqual(got.lease, { apiBase: 'https://s.dev', token: 'tok-1', leaseId: 7, expiresAt: 123 })
  assert.deepEqual(readCachedAccount('/u', { fs }), { email: 'a@x.com', password: 'pw' })
})
