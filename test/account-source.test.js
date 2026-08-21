const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  serverConfigFile, cachedAccountFile,
  readServerConfig, readCachedAccount, writeCachedAccount,
  requestLease, renewLease, renewTrackedLeases, releaseLease, resolveRemoteAccount,
} = require('../src/account-source')

function fakeFs(files, writes = []) {
  return {
    readFileSync(p) { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    writeFileSync(p, d, opts) { files[p] = d; writes.push({ p, d, opts }) },
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
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: '', token: '' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig returns null when only apiBase is empty', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: '', token: 't' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig returns null when only token is empty', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: '' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig returns null on malformed JSON', () => {
  const fs = fakeFs({ '/u/server-config.json': '{not json' })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig parses apiBase+token', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }) })
  assert.deepEqual(readServerConfig('/u', { fs }), { apiBase: 'https://x', token: 't' })
})

test('serverConfigFile and cachedAccountFile join userDataDir with the expected filenames', () => {
  assert.equal(serverConfigFile('/u'), path.join('/u', 'server-config.json'))
  assert.equal(cachedAccountFile('/u'), path.join('/u', 'cached-account.json'))
})

test('readCachedAccount parses email+password directly', () => {
  const fs = fakeFs({ '/u/cached-account.json': JSON.stringify({ email: 'c@x', password: 'cp' }) })
  assert.deepEqual(readCachedAccount('/u', { fs }), { email: 'c@x', password: 'cp' })
})

test('readCachedAccount returns null on malformed JSON', () => {
  const fs = fakeFs({ '/u/cached-account.json': '{not json' })
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
  const files = { '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }) }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, { email: 'a@x', password: 'p', lease_id: 5, expires_at: 9 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(out.email, 'a@x')
  assert.equal(out.password, 'p')
  assert.deepEqual(out.lease, { apiBase: 'https://x', token: 't', leaseId: 5, expiresAt: 9 })
  assert.ok(files['/u/cached-account.json'])                 // 已缓存
})

test('resolveRemoteAccount: cache write failure still returns the leased account', async () => {
  const files = { '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }) }
  const fs = fakeFsWriteThrows(files)
  const fetch = async () => jsonResponse(200, { email: 'a@x', password: 'p', lease_id: 5, expires_at: 9 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(out.email, 'a@x')
  assert.equal(out.password, 'p')
  assert.deepEqual(out.lease, { apiBase: 'https://x', token: 't', leaseId: 5, expiresAt: 9 })
})

test('resolveRemoteAccount: server down falls back to cache with null lease', async () => {
  const files = {
    '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }),
    '/u/cached-account.json': JSON.stringify({ email: 'c@x', password: 'cp' }),
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
    '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }),
    '/u/cached-account.json': good,
  }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, { lease_id: 1, expires_at: 9 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  // 缓存断言放在最前:返回值断言先失败的话,这条就跑不到,负向对照里等于没验。
  assert.equal(files['/u/cached-account.json'], good)   // 缓存未被污染
  assert.equal(out.email, 'c@x')
  assert.equal(out.lease, null)
})

test('resolveRemoteAccount: a 200 lease with no password leaves the cache intact', async () => {
  const good = JSON.stringify({ email: 'c@x', password: 'cp' })
  const files = {
    '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }),
    '/u/cached-account.json': good,
  }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, { email: 'a@x', lease_id: 1 })
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal(files['/u/cached-account.json'], good)
  assert.equal(out.email, 'c@x')
})

test('resolveRemoteAccount: a malformed 200 with no cache returns null and writes nothing', async () => {
  const files = { '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }) }
  const fs = fakeFs(files)
  const fetch = async () => jsonResponse(200, {})
  const out = await resolveRemoteAccount('/u', { fetch, fs })
  assert.equal('/u/cached-account.json' in files, false)
  assert.equal(out, null)
})

// apiBase 手写成 `https://x/` 是极可能的:拼出 `//api/lease` 会被 Hono 判 404,
// 客户端读成"服务器不可用",于是永远走缓存/桌面文件 —— 功能形同没配。
test('readServerConfig strips a trailing slash from apiBase', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: 'https://x.workers.dev/', token: 't' }) })
  assert.deepEqual(readServerConfig('/u', { fs }), { apiBase: 'https://x.workers.dev', token: 't' })
})

test('readServerConfig strips several trailing slashes', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: 'https://x.workers.dev///', token: 't' }) })
  assert.equal(readServerConfig('/u', { fs }).apiBase, 'https://x.workers.dev')
})

test('readServerConfig returns null when apiBase is nothing but slashes', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: '/', token: 't' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('a trailing-slash apiBase still produces exactly one slash in the request URL', async () => {
  const files = { '/u/server-config.json': JSON.stringify({ apiBase: 'https://x.workers.dev/', token: 't' }) }
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
  assert.deepEqual(JSON.parse(files['/u/cached-account.json']), { email: 'a@x', password: 'p' })
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
  await resolveRemoteAccount('/u', { fetch, fs: fakeFs({ '/u/server-config.json': '{not json' }) })
  assert.equal(calls, 0)
})
