import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerAdminRoutes } from '../src/admin.js'
import { hashToken } from '../src/tokens.js'

const PW = 'admin-pass'
let ADMIN_HASH
test.before(async () => { ADMIN_HASH = await hashToken(PW) })

// fakeDbFactory 返回一个可观测的 fake db:除了保存 accounts/clients 之外,
// 还记录每个写方法被调用的参数,便于断言 toggle/delete/create 路径确实触达了 db,
// 以及未认证请求确实“零调用”。
function fakeDbFactory() {
  const accounts = []
  const clients = []
  let nid = 1
  const calls = { createAccount: [], updateAccount: [], deleteAccount: [], createClient: [], setClientEnabled: [] }
  const db = {
    async listAccounts() { return accounts },
    async createAccount({ email, password_enc, note }) {
      calls.createAccount.push({ email, password_enc, note })
      const id = nid++
      accounts.push({ id, email, password_enc, note: note ?? null, enabled: 1 })
      return id
    },
    async updateAccount(id, fields) {
      calls.updateAccount.push({ id, fields })
      const a = accounts.find((x) => x.id === id)
      if (a) Object.assign(a, fields)
    },
    async deleteAccount(id) {
      calls.deleteAccount.push(id)
      const i = accounts.findIndex((a) => a.id === id)
      if (i >= 0) accounts.splice(i, 1)
    },
    async listClients() { return clients },
    async createClient({ name, token_hash }) {
      calls.createClient.push({ name, token_hash })
      const id = nid++
      clients.push({ id, name, token_hash, enabled: 1 })
      return id
    },
    async setClientEnabled(id, enabled) {
      calls.setClientEnabled.push({ id, enabled })
      const cl = clients.find((x) => x.id === id)
      if (cl) cl.enabled = enabled ? 1 : 0
    },
  }
  return { db, calls, accounts, clients }
}

function buildApp(state = fakeDbFactory()) {
  const app = new Hono()
  registerAdminRoutes(app, { makeDb: () => state.db })
  return { app, state }
}

const env = { DB: {}, ACCOUNT_ENC_KEY: Buffer.alloc(32).toString('base64'), ADMIN_PASSWORD_HASH: () => ADMIN_HASH }

async function login(app, e) {
  const res = await app.request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${PW}`,
  }, e)
  return (res.headers.get('set-cookie') || '').split(';')[0]
}

test('GET /admin without cookie redirects to login', async () => {
  const { app } = buildApp()
  const res = await app.request('/admin', {}, { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/admin/login')
})

test('login with wrong password fails, correct sets cookie', async () => {
  const { app } = buildApp()
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const bad = await app.request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
  }, e)
  assert.equal(bad.status, 401)

  const ok = await app.request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${PW}`,
  }, e)
  assert.equal(ok.status, 302)
  assert.match(ok.headers.get('set-cookie') || '', /admin=/)
})

test('creating a client returns the plaintext token once', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const { app } = buildApp()
  // 先登录拿 cookie
  const cookie = await login(app, e)
  const res = await app.request('/admin/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: 'name=laptop',
  }, e)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /[A-Za-z0-9_-]{40,}/)          // 明文 token 出现一次
})

// --- 回归测试:每一个写路由在没有 cookie 时都必须被拦截,且 fake db 完全不被调用 ---
// 这组用例专门覆盖此前 `/admin/clients*` 通配符在 Hono 下失效、导致匿名请求
// 能自助铸造 client token 并写库的认证绕过问题。

const unauthWriteCases = [
  { name: 'POST /admin/accounts', path: '/admin/accounts', body: 'email=a@b.com&password=x' },
  { name: 'POST /admin/accounts/:id/toggle', path: '/admin/accounts/1/toggle', body: '' },
  { name: 'POST /admin/accounts/:id/delete', path: '/admin/accounts/1/delete', body: '' },
  { name: 'POST /admin/clients', path: '/admin/clients', body: 'name=evil' },
  { name: 'POST /admin/clients/:id/toggle', path: '/admin/clients/1/toggle', body: '' },
]

for (const { name, path, body } of unauthWriteCases) {
  test(`${name} without cookie redirects to login and never touches db`, async () => {
    const { app, state } = buildApp()
    const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }, e)
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/admin/login')
    assert.equal(state.calls.createAccount.length, 0)
    assert.equal(state.calls.updateAccount.length, 0)
    assert.equal(state.calls.deleteAccount.length, 0)
    assert.equal(state.calls.createClient.length, 0)
    assert.equal(state.calls.setClientEnabled.length, 0)
  })
}

test('regression: unauthenticated POST /admin/clients must not create a client (critical auth bypass)', async () => {
  const { app, state } = buildApp()
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const res = await app.request('/admin/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=evil',
  }, e)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/admin/login')
  assert.equal(state.clients.length, 0)
})

test('authenticated toggle/delete actually call the db with expected args', async () => {
  const { app, state } = buildApp()
  state.accounts.push({ id: 1, email: 'a@b.com', enabled: 1 })
  state.clients.push({ id: 1, name: 'laptop', enabled: 1, token_hash: 'x' })
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)

  const t1 = await app.request('/admin/accounts/1/toggle', {
    method: 'POST', headers: { cookie },
  }, e)
  assert.equal(t1.status, 302)
  assert.deepEqual(state.calls.updateAccount, [{ id: 1, fields: { enabled: 0 } }])

  const d1 = await app.request('/admin/accounts/1/delete', {
    method: 'POST', headers: { cookie },
  }, e)
  assert.equal(d1.status, 302)
  assert.deepEqual(state.calls.deleteAccount, [1])

  const c1 = await app.request('/admin/clients/1/toggle', {
    method: 'POST', headers: { cookie },
  }, e)
  assert.equal(c1.status, 302)
  assert.deepEqual(state.calls.setClientEnabled, [{ id: 1, enabled: false }])
})

test('GET /admin escapes untrusted client name, account email and leased_by (stored XSS)', async () => {
  const { app, state } = buildApp()
  state.clients.push({ id: 1, name: '<img src=x onerror=alert(1)>', enabled: 1 })
  state.accounts.push({
    id: 1, email: '<script>alert(2)</script>', enabled: 1, leased_by: '<b>evil-client</b>',
  })
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)
  const res = await app.request('/admin', { headers: { cookie } }, e)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'raw client name markup must not appear')
  assert.ok(!html.includes('<script>alert(2)</script>'), 'raw email markup must not appear')
  assert.ok(!html.includes('<b>evil-client</b>'), 'raw leased_by markup must not appear')
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
  assert.match(html, /&lt;b&gt;evil-client&lt;\/b&gt;/)
})
