import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerAdminRoutes } from '../src/admin.js'
import { hashToken } from '../src/tokens.js'

const PW = 'admin-pass'
let ADMIN_HASH
test.before(async () => { ADMIN_HASH = await hashToken(PW) })

function fakeDbFactory() {
  const accounts = []
  const clients = []
  let nid = 1
  const db = {
    async listAccounts() { return accounts },
    async createAccount({ email, password_enc }) { const id = nid++; accounts.push({ id, email, password_enc, enabled: 1 }); return id },
    async updateAccount() {},
    async deleteAccount(id) { const i = accounts.findIndex((a) => a.id === id); if (i >= 0) accounts.splice(i, 1) },
    async listClients() { return clients },
    async createClient({ name, token_hash }) { const id = nid++; clients.push({ id, name, token_hash, enabled: 1 }); return id },
    async setClientEnabled() {},
  }
  return () => db
}

function buildApp() {
  const app = new Hono()
  registerAdminRoutes(app, { makeDb: fakeDbFactory() })
  return app
}
const env = { DB: {}, ACCOUNT_ENC_KEY: Buffer.alloc(32).toString('base64'), ADMIN_PASSWORD_HASH: () => ADMIN_HASH }

test('GET /admin without cookie redirects to login', async () => {
  const res = await buildApp().request('/admin', {}, { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/admin/login')
})

test('login with wrong password fails, correct sets cookie', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const bad = await buildApp().request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
  }, e)
  assert.equal(bad.status, 401)

  const ok = await buildApp().request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${PW}`,
  }, e)
  assert.equal(ok.status, 302)
  assert.match(ok.headers.get('set-cookie') || '', /admin=/)
})

test('creating a client returns the plaintext token once', async () => {
  const e = { ...env, ADMIN_PASSWORD_HASH: ADMIN_HASH }
  const app = buildApp()
  // 先登录拿 cookie
  const login = await app.request('/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${PW}`,
  }, e)
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const res = await app.request('/admin/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: 'name=laptop',
  }, e)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /[A-Za-z0-9_-]{40,}/)          // 明文 token 出现一次
})
