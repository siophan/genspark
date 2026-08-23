import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { makeDb } from '../src/db.js'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

// 极薄的 D1 兼容 shim,让为 D1 binding 写的 db.js 能在本地用 node:sqlite 测试,
// 无需 workerd/miniflare。D1 底层即 SQLite,prepare/bind/first/all/run 语义一致。
function d1Shim(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      let bound = []
      const api = {
        bind(...args) { bound = args; return api },
        first() { const r = stmt.get(...bound); return r === undefined ? null : r },
        all() { return { results: stmt.all(...bound) } },
        run() { return stmt.run(...bound) },
      }
      return api
    },
  }
}

let d1
beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  d1 = d1Shim(sqlite)
})

async function seedAccount(email, penc = 'enc', enabled = 1) {
  const r = await d1
    .prepare('INSERT INTO accounts (email, password_enc, enabled) VALUES (?,?,?) RETURNING id')
    .bind(email, penc, enabled)
    .first()
  return r.id
}
async function seedClient(name = 'c1', hash = 'h1') {
  const r = await d1
    .prepare('INSERT INTO clients (name, token_hash) VALUES (?,?) RETURNING id')
    .bind(name, hash)
    .first()
  return r.id
}

test('availableAccounts excludes disabled and actively-leased', async () => {
  const db = makeDb(d1)
  const a1 = await seedAccount('a@x.com')
  await seedAccount('b@x.com', 'enc', 0)                 // disabled
  const a3 = await seedAccount('c@x.com')
  const client = await seedClient()
  await db.claimAccount({ accountId: a3, clientId: client, expiresAt: 999999999999, now: 1000 })
  const avail = await db.availableAccounts(1000)
  assert.deepEqual(avail.map((a) => a.id).sort(), [a1])
})

test('claimAccount is atomic: only one of two concurrent claims wins', async () => {
  const db = makeDb(d1)
  const a1 = await seedAccount('a@x.com')
  const client = await seedClient()
  const [r1, r2] = await Promise.all([
    db.claimAccount({ accountId: a1, clientId: client, expiresAt: 999999999999, now: 1000 }),
    db.claimAccount({ accountId: a1, clientId: client, expiresAt: 999999999999, now: 1000 }),
  ])
  const wins = [r1, r2].filter((x) => x != null)
  assert.equal(wins.length, 1)
})

test('expired lease frees the account again', async () => {
  const db = makeDb(d1)
  const a1 = await seedAccount('a@x.com')
  const client = await seedClient()
  await db.claimAccount({ accountId: a1, clientId: client, expiresAt: 500, now: 100 })
  const avail = await db.availableAccounts(1000)
  assert.deepEqual(avail.map((a) => a.id), [a1])
})

test('renewLease extends only an active lease owned by the client', async () => {
  const db = makeDb(d1)
  const a1 = await seedAccount('a@x.com')
  const client = await seedClient()
  const leaseId = await db.claimAccount({ accountId: a1, clientId: client, expiresAt: 2000, now: 100 })
  const newExp = await db.renewLease({ leaseId, clientId: client, now: 1000, ttlMs: 5000 })
  assert.equal(newExp, 6000)
  const other = await seedClient('c2', 'h2')
  assert.equal(await db.renewLease({ leaseId, clientId: other, now: 1000, ttlMs: 5000 }), null)
})

test('releaseLease frees the account before expiry', async () => {
  const db = makeDb(d1)
  const a1 = await seedAccount('a@x.com')
  const client = await seedClient()
  const leaseId = await db.claimAccount({ accountId: a1, clientId: client, expiresAt: 999999999999, now: 100 })
  await db.releaseLease({ leaseId, clientId: client, now: 200 })
  assert.deepEqual((await db.availableAccounts(300)).map((a) => a.id), [a1])
})

test('verifyClient returns id for enabled token, null otherwise', async () => {
  const db = makeDb(d1)
  await seedClient('c1', 'goodhash')
  assert.ok((await db.verifyClient('goodhash', 1000)).id)
  assert.equal(await db.verifyClient('nope', 1000), null)
})

test('lastAccountIdForClient returns most recent lease account', async () => {
  const db = makeDb(d1)
  const a1 = await seedAccount('a@x.com')
  const a2 = await seedAccount('b@x.com')
  const client = await seedClient()
  await db.claimAccount({ accountId: a1, clientId: client, expiresAt: 10, now: 1 })
  await db.claimAccount({ accountId: a2, clientId: client, expiresAt: 999999999999, now: 2 })
  assert.equal(await db.lastAccountIdForClient(client), a2)
})

test('admin CRUD: create/list/update/delete account, create client', async () => {
  const db = makeDb(d1)
  const id = await db.createAccount({ email: 'z@x.com', password_enc: 'e', note: 'hi' })
  assert.ok(id)
  let list = await db.listAccounts()
  assert.equal(list.length, 1)
  await db.updateAccount(id, { enabled: 0, note: 'off' })
  await db.deleteAccount(id)
  assert.equal((await db.listAccounts()).length, 0)
  const cid = await db.createClient({ name: 'c', token_hash: 'hh' })
  assert.ok(cid)
  assert.equal((await db.listClients()).length, 1)
})

test('createClient 默认启用,也可显式停用', async () => {
  const db = makeDb(d1)
  const a = await db.createClient({ name: 'manual', token_hash: 'h1' })
  const b = await db.createClient({ name: 'auto:x', token_hash: 'h2', enabled: 0 })
  const rows = await db.listClients()
  assert.equal(rows.find((r) => r.id === a).enabled, 1)
  assert.equal(rows.find((r) => r.id === b).enabled, 0)
})

test('停用的客户端拿着有效 token 也验不过', async () => {
  const db = makeDb(d1)
  const id = await db.createClient({ name: 'auto:x', token_hash: 'pending-hash', enabled: 0 })
  assert.equal(await db.verifyClient('pending-hash', Date.now()), null)
  // 批准之后才通
  await db.setClientEnabled(id, true)
  const ok = await db.verifyClient('pending-hash', Date.now())
  assert.equal(ok.id, id)
})
