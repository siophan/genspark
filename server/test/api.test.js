import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerApiRoutes } from '../src/api.js'
import { hashToken } from '../src/tokens.js'
import { encryptPassword } from '../src/crypto.js'

const KEY = Buffer.alloc(32).toString('base64')

// 内存假 db:一个可用账号 + 一个已知 token
function makeFakeDbFactory(state) {
  return () => ({
    async verifyClient(hash) {
      if (hash === state.tokenHash) return { id: 42 }
      // 注册出来的 client 也要能通过校验,否则测不出"注册完能不能立刻租号"
      const made = (state.created || []).find((c) => c.token_hash === hash)
      return made && made.enabled !== 0 ? { id: 77 } : null
    },
    async availableAccounts() { return state.available.slice() },
    async lastAccountIdForClient() { return null },
    async claimAccount({ accountId }) {
      const i = state.available.findIndex((a) => a.id === accountId)
      if (i < 0) return null
      state.available.splice(i, 1)
      return 500 + accountId
    },
    async touchAccount() {},
    async renewLease({ leaseId }) { return leaseId === 501 ? 9999 : null },
    async releaseLease(args) { state.released = true; (state.releases ||= []).push(args) },
    async createClient(args) { (state.created ||= []).push(args); return 77 },
  })
}

async function buildApp(state) {
  const app = new Hono()
  registerApiRoutes(app, { makeDb: makeFakeDbFactory(state) })
  return app
}
const env = { DB: {}, ACCOUNT_ENC_KEY: KEY, LEASE_TTL_MS: '1000' }

test('POST /api/lease without token → 401', async () => {
  const app = await buildApp({ tokenHash: await hashToken('t'), available: [] })
  const res = await app.request('/api/lease', { method: 'POST' }, env)
  assert.equal(res.status, 401)
})

test('POST /api/lease returns decrypted password', async () => {
  const tokenHash = await hashToken('secret-token')
  const enc = await encryptPassword('pw123', KEY)
  const state = { tokenHash, available: [{ id: 1, email: 'a@x.com', password_enc: enc }] }
  const app = await buildApp(state)
  const res = await app.request(
    '/api/lease',
    { method: 'POST', headers: { Authorization: 'Bearer secret-token' } },
    env,
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.email, 'a@x.com')
  assert.equal(body.password, 'pw123')
  assert.equal(body.lease_id, 501)
  assert.equal(typeof body.expires_at, 'number')
})

test('POST /api/lease with no accounts → 409', async () => {
  const tokenHash = await hashToken('t')
  const app = await buildApp({ tokenHash, available: [] })
  const res = await app.request(
    '/api/lease',
    { method: 'POST', headers: { Authorization: 'Bearer t' } },
    env,
  )
  assert.equal(res.status, 409)
})

test('POST /api/renew active → 200, expired → 410', async () => {
  const tokenHash = await hashToken('t')
  const app = await buildApp({ tokenHash, available: [] })
  const ok = await app.request(
    '/api/renew',
    { method: 'POST', headers: { Authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ lease_id: 501 }) },
    env,
  )
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).expires_at, 9999)
  const gone = await app.request(
    '/api/renew',
    { method: 'POST', headers: { Authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ lease_id: 999 }) },
    env,
  )
  assert.equal(gone.status, 410)
})

test('POST /api/release → 200 ok', async () => {
  const tokenHash = await hashToken('t')
  const state = { tokenHash, available: [] }
  const app = await buildApp(state)
  const res = await app.request(
    '/api/release',
    { method: 'POST', headers: { Authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ lease_id: 501 }) },
    env,
  )
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  assert.equal(state.released, true)
})

// 解密发生在租约已经落库之后。它一抛,租约还攥在手里,这个账号就白锁满一个
// TTL —— 而 ACCOUNT_ENC_KEY 一旦轮换,整池账号会一次一个地变成幽灵租约。
test('POST /api/lease releases the lease it just took when the password will not decrypt', async () => {
  const tokenHash = await hashToken('t')
  const state = { tokenHash, available: [{ id: 1, email: 'a@x.com', password_enc: 'corrupted-not-iv-colon-cipher' }] }
  const app = await buildApp(state)
  const res = await app.request(
    '/api/lease',
    { method: 'POST', headers: { Authorization: 'Bearer t' } },
    env,
  )
  // 账号必须立刻回到池子里,而不是被锁满一个 TTL。
  assert.equal(state.released, true)
  assert.deepEqual(state.releases.map((r) => r.leaseId), [501])
  assert.equal(res.status, 500)
  assert.equal((await res.json()).error, 'account_unreadable')
})

test('POST /api/lease releases the lease when ACCOUNT_ENC_KEY has been rotated', async () => {
  const tokenHash = await hashToken('t')
  const enc = await encryptPassword('pw123', KEY)
  const state = { tokenHash, available: [{ id: 1, email: 'a@x.com', password_enc: enc }] }
  const app = await buildApp(state)
  const rotated = { ...env, ACCOUNT_ENC_KEY: Buffer.alloc(32, 7).toString('base64') }
  const res = await app.request(
    '/api/lease',
    { method: 'POST', headers: { Authorization: 'Bearer t' } },
    rotated,
  )
  assert.equal(state.released, true)
  assert.equal(res.status, 500)
  assert.equal((await res.json()).error, 'account_unreadable')
})

// ---- POST /api/register ----

const regEnv = { ...env, REGISTER_CODE: 'invite-me' }

test('register issues a token and stores only its hash', async () => {
  const state = { tokenHash: await hashToken('t'), available: [] }
  const app = await buildApp(state)
  const res = await app.request(
    '/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me', device: 'mac-air' }) },
    regEnv,
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(typeof body.token, 'string')
  assert.ok(body.token.length >= 32)
  assert.equal(body.client_id, 77)
  assert.equal(state.created.length, 1)
  assert.equal(state.created[0].name, 'auto:mac-air')
  // 不能带着 enabled: 0 建行 —— 那会让新装的客户端第一次打开租不到号
  assert.notEqual(state.created[0].enabled, 0)
  // 库里存的必须是哈希,不是 token 本身
  assert.equal(state.created[0].token_hash, await hashToken(body.token))
  assert.notEqual(state.created[0].token_hash, body.token)
})

test('register rejects a wrong invite code', async () => {
  const state = { tokenHash: await hashToken('t'), available: [] }
  const app = await buildApp(state)
  const res = await app.request(
    '/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'nope' }) },
    regEnv,
  )
  assert.equal(res.status, 403)
  assert.equal(state.created, undefined)
})

test('register is disabled when REGISTER_CODE is unset', async () => {
  const state = { tokenHash: await hashToken('t'), available: [] }
  const app = await buildApp(state)
  // 没有 REGISTER_CODE 时,连正确的空码也不能放行
  for (const body of [JSON.stringify({ code: '' }), JSON.stringify({}), '']) {
    const res = await app.request(
      '/api/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      env,
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'registration_disabled')
  }
  assert.equal(state.created, undefined)
})

test('register needs no bearer token but every other /api route still does', async () => {
  const state = { tokenHash: await hashToken('t'), available: [] }
  const app = await buildApp(state)
  const reg = await app.request(
    '/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me' }) },
    regEnv,
  )
  assert.equal(reg.status, 200)
  for (const route of ['/api/lease', '/api/renew', '/api/release']) {
    const res = await app.request(route, { method: 'POST' }, regEnv)
    assert.equal(res.status, 401, `${route} 必须仍然要 bearer`)
  }
})

test('register falls back to a placeholder name and caps its length', async () => {
  const state = { tokenHash: await hashToken('t'), available: [] }
  const app = await buildApp(state)
  await app.request('/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me', device: '   ' }) }, regEnv)
  assert.equal(state.created[0].name, 'auto:unknown')

  await app.request('/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me', device: 'x'.repeat(200) }) }, regEnv)
  assert.equal(state.created[1].name, 'auto:' + 'x'.repeat(60))

  // 非字符串的 device 不能让处理器抛
  await app.request('/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me', device: { evil: 1 } }) }, regEnv)
  assert.equal(state.created[2].name, 'auto:unknown')
})

test('two registrations never issue the same token', async () => {
  const state = { tokenHash: await hashToken('t'), available: [] }
  const app = await buildApp(state)
  const tokens = new Set()
  for (let i = 0; i < 5; i++) {
    const res = await app.request('/api/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me' }) }, regEnv)
    tokens.add((await res.json()).token)
  }
  assert.equal(tokens.size, 5)
})

test('注册拿到的 token 立刻就能租号', async () => {
  const enc = await encryptPassword('pw', KEY)
  const state = { tokenHash: await hashToken('other'), available: [{ id: 1, email: 'a@x.com', password_enc: enc }] }
  const app = await buildApp(state)
  const reg = await app.request('/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me', device: 'brand-new' }) }, regEnv)
  const { token } = await reg.json()

  const lease = await app.request('/api/lease',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token } }, regEnv)
  assert.equal(lease.status, 200, '刚注册的客户端必须能直接租到号')
  assert.equal((await lease.json()).email, 'a@x.com')
})

test('后台停用之后,同一个 token 立刻失效', async () => {
  const enc = await encryptPassword('pw', KEY)
  const state = { tokenHash: await hashToken('other'), available: [{ id: 1, email: 'a@x.com', password_enc: enc }] }
  const app = await buildApp(state)
  const reg = await app.request('/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-me' }) }, regEnv)
  const { token } = await reg.json()

  // 模拟管理员在后台点了停用
  state.created[0].enabled = 0

  const lease = await app.request('/api/lease',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token } }, regEnv)
  assert.equal(lease.status, 401, '停用必须立刻生效 —— 这是现在唯一的管控手段')
})

// ---- /api/logs ----
// 打包后的 GUI 应用没有可看的控制台。这条接口是唯一的观测口,所以它必须在
// "客户端还没注册成功"时也能收 —— 那正是最需要日志的时刻。
function logDbFactory(state) {
  return () => ({
    async verifyClient(hash) { return hash === state.tokenHash ? { id: 42 } : null },
    async appendClientLogs(args) { (state.appended ||= []).push(args) },
    async pruneClientLogs(keep) { state.pruned = keep },
  })
}
async function buildLogApp(state) {
  const app = new Hono()
  registerApiRoutes(app, { makeDb: logDbFactory(state) })
  return app
}
const logEnv = { DB: {}, ACCOUNT_ENC_KEY: KEY, REGISTER_CODE: 'invite-1' }

test('POST /api/logs 带有效 token → 记在那个 client 名下', async () => {
  const state = { tokenHash: await hashToken('good') }
  const app = await buildLogApp(state)
  const res = await app.request('/api/logs', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify({ device: 'mac', lines: [{ level: 'error', message: 'boom' }] }),
  }, logEnv)
  assert.equal(res.status, 200)
  assert.equal(state.appended.length, 1)
  assert.equal(state.appended[0].clientId, 42)
  assert.deepEqual(state.appended[0].lines, [{ level: 'error', message: 'boom' }])
})

test('POST /api/logs 无 token 但邀请码对 → 匿名收下,client_id 为 null', async () => {
  const state = { tokenHash: await hashToken('good') }
  const app = await buildLogApp(state)
  const res = await app.request('/api/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'invite-1', device: 'win-box', lines: [{ level: 'log', message: 'hi' }] }),
  }, logEnv)
  assert.equal(res.status, 200)
  assert.equal(state.appended[0].clientId, null)
  assert.equal(state.appended[0].device, 'win-box')
})

test('POST /api/logs 既没 token 也没对的邀请码 → 401,一条都不写', async () => {
  const state = { tokenHash: await hashToken('good') }
  const app = await buildLogApp(state)
  const res = await app.request('/api/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'wrong', lines: [{ level: 'log', message: 'hi' }] }),
  }, logEnv)
  assert.equal(res.status, 401)
  assert.equal(state.appended, undefined)
})

// 停用一台机器之后它还能往日志表里写,吊销就漏了一半。停用的 token 必须退回匿名
// 路径 —— 没有邀请码就一条都不收。
test('POST /api/logs 停用客户端的 token 不再算认证通过', async () => {
  const state = { tokenHash: 'nobody-matches-this' }
  const app = await buildLogApp(state)
  const res = await app.request('/api/logs', {
    method: 'POST',
    headers: { Authorization: 'Bearer disabled-token', 'content-type': 'application/json' },
    body: JSON.stringify({ lines: [{ level: 'log', message: 'hi' }] }),
  }, logEnv)
  assert.equal(res.status, 401)
  assert.equal(state.appended, undefined)
})

test('POST /api/logs 砍掉超量的条数、过长的正文和乱来的 level', async () => {
  const state = { tokenHash: await hashToken('good') }
  const app = await buildLogApp(state)
  const lines = Array.from({ length: 200 }, (_, i) => ({ level: 'log', message: `第${i}条` }))
  lines.push({ level: '<script>', message: 'x'.repeat(5000) })
  const res = await app.request('/api/logs', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify({ device: 'd'.repeat(300), lines }),
  }, logEnv)
  assert.equal(res.status, 200)
  const got = state.appended[0]
  assert.ok(got.lines.length <= 50, `条数应被砍到 50 以内,实际 ${got.lines.length}`)
  assert.ok(got.lines.every((l) => l.message.length <= 500), '每条正文不超过 500 字')
  assert.ok(got.lines.every((l) => ['log', 'warn', 'error'].includes(l.level)), 'level 只认三种')
  assert.ok(got.device.length <= 60, 'device 也要设上限')
  assert.ok(state.pruned > 0, '写完要修一次保留上限')
})

test('POST /api/logs 空 lines 直接 200,不碰 db', async () => {
  const state = { tokenHash: await hashToken('good') }
  const app = await buildLogApp(state)
  const res = await app.request('/api/logs', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify({ lines: [] }),
  }, logEnv)
  assert.equal(res.status, 200)
  assert.equal(state.appended, undefined)
})
