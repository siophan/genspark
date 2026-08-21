const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  readServerConfig, requestLease, resolveRemoteAccount,
} = require('../src/account-source')

function fakeFs(files) {
  return {
    readFileSync(p) { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    writeFileSync(p, d) { files[p] = d },
    existsSync(p) { return p in files },
  }
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body } }
}

test('readServerConfig returns null when file missing', () => {
  assert.equal(readServerConfig('/u', { fs: fakeFs({}) }), null)
})

test('readServerConfig returns null when fields empty', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: '', token: '' }) })
  assert.equal(readServerConfig('/u', { fs }), null)
})

test('readServerConfig parses apiBase+token', () => {
  const fs = fakeFs({ '/u/server-config.json': JSON.stringify({ apiBase: 'https://x', token: 't' }) })
  assert.deepEqual(readServerConfig('/u', { fs }), { apiBase: 'https://x', token: 't' })
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
