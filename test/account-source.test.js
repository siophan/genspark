const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  serverConfigFile, cachedAccountFile,
  readServerConfig, readCachedAccount,
  requestLease, renewLease, releaseLease, resolveRemoteAccount,
} = require('../src/account-source')

function fakeFs(files) {
  return {
    readFileSync(p) { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    writeFileSync(p, d) { files[p] = d },
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

test('renewLease posts the lease_id and returns expires_at on success', async () => {
  let seen
  const fetch = async (url, init) => { seen = { url, init }; return jsonResponse(200, { expires_at: 123 }) }
  const out = await renewLease({ apiBase: 'https://x', token: 'tok', leaseId: 7 }, { fetch })
  assert.equal(out, 123)
  assert.equal(seen.url, 'https://x/api/renew')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(seen.init.body), { lease_id: 7 })
})

test('renewLease returns null on 410 lease_expired', async () => {
  const fetch = async () => jsonResponse(410, { error: 'lease_expired' })
  assert.equal(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), null)
})

test('renewLease returns null when fetch throws (offline)', async () => {
  const fetch = async () => { throw new Error('network') }
  assert.equal(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), null)
})

test('renewLease returns null when the response body is not valid JSON', async () => {
  const fetch = async () => badJsonResponse(200)
  assert.equal(await renewLease({ apiBase: 'https://x', token: 't', leaseId: 7 }, { fetch }), null)
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
