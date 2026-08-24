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
    // 跟真实实现同一份契约:被持有就删不掉,返回 false。
    async deleteAccount(id) {
      calls.deleteAccount.push(id)
      const i = accounts.findIndex((a) => a.id === id)
      if (i < 0 || accounts[i].leased_by_id != null) return false
      accounts.splice(i, 1)
      return true
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

// 已登录地提交一次"新增账号"表单。
async function createAccount(app, e, body) {
  return app.request('/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: await login(app, e) },
    body,
  }, e)
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

// 空 email 的账号是合法的出租候选:客户端租到它、发现没 email、丢掉,白烧一个
// 30 分钟的租约,而且每次启动都会再烧一个。后台上手滑点一下"新增"就够了。
test('POST /admin/accounts rejects an empty email instead of poisoning the pool', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const { app, state } = buildApp()
  const res = await createAccount(app, e, 'email=&password=pw')
  assert.equal(res.status, 400)
  assert.equal(state.calls.createAccount.length, 0)
  assert.equal(state.accounts.length, 0)
})

test('POST /admin/accounts rejects a whitespace-only email', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const { app, state } = buildApp()
  const res = await createAccount(app, e, 'email=%20%20&password=pw')
  assert.equal(res.status, 400)
  assert.equal(state.calls.createAccount.length, 0)
})

test('POST /admin/accounts rejects an empty password', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const { app, state } = buildApp()
  const res = await createAccount(app, e, 'email=a%40x.com&password=')
  assert.equal(res.status, 400)
  assert.equal(state.calls.createAccount.length, 0)
})

test('POST /admin/accounts still creates a valid account, with the email trimmed', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const { app, state } = buildApp()
  const res = await createAccount(app, e, 'email=%20a%40x.com%20&password=pw')
  assert.equal(res.status, 302)
  assert.equal(state.calls.createAccount.length, 1)
  assert.equal(state.calls.createAccount[0].email, 'a@x.com')
})

test('GET /admin 两张表互相指认:账号写持有者,客户端写账号', async () => {
  const { app, state } = buildApp()
  const soon = Date.now() + 60000
  // 名字为空的客户端:只渲染名字的话这一格是空的,和"没租出去"分不清。
  state.accounts.push({ id: 7, email: 'held@x.com', enabled: 1, leased_by_id: 4, leased_by: '', lease_expires_at: soon })
  state.accounts.push({ id: 8, email: 'free@x.com', enabled: 1, leased_by_id: null, leased_by: null, lease_expires_at: null })
  state.clients.push({
    id: 4, name: '', enabled: 1, last_seen_at: Date.now(),
    last_account_id: 7, last_account_email: 'held@x.com', last_expires_at: soon, last_released_at: null,
  })
  state.clients.push({
    id: 5, name: 'macbook', enabled: 1, last_seen_at: Date.now(),
    last_account_id: 9, last_account_email: 'gone@x.com', last_expires_at: soon, last_released_at: Date.now(),
  })
  state.clients.push({ id: 6, name: 'fresh', enabled: 1, last_seen_at: null, last_account_id: null })

  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)
  const html = await (await app.request('/admin', { headers: { cookie } }, e)).text()

  assert.match(html, /#4/, '空名字的持有者要靠 id 认出来')
  assert.match(html, /held@x\.com/)
  assert.match(html, /曾用 gone@x\.com/, '已归还的租约仍要看得见')
  assert.match(html, /—/, '从没租过的客户端画横杠而不是空格')
  assert.ok(!/free@x\.com<\/td><td>#/.test(html), '空闲账号不该有持有者')
})

test('POST /admin/accounts/:id/delete 挡住正被持有的账号,并说清怎么办', async () => {
  const { app, state } = buildApp()
  state.accounts.push({ id: 1, email: 'busy@x.com', enabled: 1, leased_by_id: 4, leased_by: '' })
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)

  const res = await app.request('/admin/accounts/1/delete', { method: 'POST', headers: { cookie } }, e)
  assert.equal(res.status, 409)
  assert.deepEqual(state.calls.deleteAccount, [], '被持有时连删都不该试,免得白清历史租约')
  assert.equal(state.accounts.length, 1)
  const html = await res.text()
  assert.match(html, /#4/, '要指名道姓是谁占着')
  assert.match(html, /停用/, '要告诉操作员下一步怎么走')
})

test('POST /admin/accounts/:id/delete 删一个已经不存在的账号不报错', async () => {
  const { app, state } = buildApp()
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)
  const res = await app.request('/admin/accounts/99/delete', { method: 'POST', headers: { cookie } }, e)
  assert.equal(res.status, 302)
  assert.deepEqual(state.calls.deleteAccount, [])
})

// ---- /admin/logs ----
// 日志正文由客户端上报,而匿名通道是公开可写的 —— 谁拿到安装包都能往里灌任意字符串。
// 这是一个现成的存储型 XSS 入口,转义在这里不是"顺手加的",是这个页面存在的前提。
function withLogs(state, rows) {
  state.db.listClientLogs = async ({ clientId = null, limit = 200 } = {}) => {
    state.logQuery = { clientId, limit }
    return clientId == null ? rows : rows.filter((r) => r.client_id === clientId)
  }
}

test('GET /admin/logs 列出日志,并转义客户端送上来的正文', async () => {
  const { app, state } = buildApp()
  withLogs(state, [
    { id: 2, client_id: null, device: '<img src=x onerror=alert(1)>', ts: 1700000000000, level: 'error', message: '<script>alert(2)</script>' },
    { id: 1, client_id: 4, device: 'mac', ts: 1700000000000, level: 'log', message: '正常一条' },
  ])
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)
  const res = await app.request('/admin/logs', { headers: { cookie } }, e)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(!html.includes('<script>alert(2)</script>'), '正文里的裸标签绝不能出现')
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'device 也是客户端送的')
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
  assert.match(html, /正常一条/)
  assert.match(html, /匿名/, '没有 client_id 的记录要标出来 —— 那是注册前的上报')
})

test('GET /admin/logs?client=4 只看那台机器', async () => {
  const { app, state } = buildApp()
  withLogs(state, [
    { id: 2, client_id: null, device: 'win', ts: 1, level: 'log', message: '匿名的' },
    { id: 1, client_id: 4, device: 'mac', ts: 1, level: 'log', message: '四号的' },
  ])
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)
  const html = await (await app.request('/admin/logs?client=4', { headers: { cookie } }, e)).text()
  assert.equal(state.logQuery.clientId, 4)
  assert.match(html, /四号的/)
  assert.ok(!html.includes('匿名的'))
})

test('GET /admin/logs 未认证时重定向到登录页,且不碰 db', async () => {
  const { app, state } = buildApp()
  let touched = false
  state.db.listClientLogs = async () => { touched = true; return [] }
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const res = await app.request('/admin/logs', {}, e)
  assert.equal(res.status, 302)
  assert.equal(touched, false)
})

test('GET /admin 的客户端表给出通往日志的入口', async () => {
  const { app, state } = buildApp()
  state.clients.push({ id: 4, name: 'mac', enabled: 1, last_seen_at: 1, last_account_id: null })
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const cookie = await login(app, e)
  const html = await (await app.request('/admin', { headers: { cookie } }, e)).text()
  assert.match(html, /\/admin\/logs\?client=4/, '每台机器要能一键看它自己的日志')
})
