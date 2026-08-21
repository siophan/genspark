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
    async verifyClient(hash) { return hash === state.tokenHash ? { id: 42 } : null },
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
    async releaseLease() { state.released = true },
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
