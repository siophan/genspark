import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { makeDb } from '../src/db.js'
// 测试和自建部署共用同一个 shim:这样这几十个用例验证的就是真正跑在服务器上的那份代码。
import { d1Shim } from '../src/sqlite-d1.js'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')


let d1
beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  // D1 默认开启外键检查,node:sqlite 默认关闭。不打开的话 leases → accounts 的外键
  // 在本地形同虚设,"删一个租过的账号"这种线上会 500 的操作在测试里一路绿灯。
  sqlite.exec('PRAGMA foreign_keys = ON')
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

// 后台要回答"哪个客户端占着哪个账号"。名字为空的客户端(后台生成 token 时不填名字)
// 只回名字的话,那一格是空的 —— 和"没租出去"分不清,所以必须带 id。
test('listAccounts 报出持有者的 id、名字和到期时间', async () => {
  const db = makeDb(d1)
  const acc = await seedAccount('held@x.com')
  const free = await seedAccount('free@x.com')
  const anon = await seedClient('', 'h-anon')
  await db.claimAccount({ accountId: acc, clientId: anon, expiresAt: Date.now() + 60000, now: Date.now() })

  const rows = await db.listAccounts()
  const held = rows.find((r) => r.id === acc)
  assert.equal(held.leased_by_id, anon)
  assert.equal(held.leased_by, '')
  assert.ok(held.lease_expires_at > Date.now())

  const idle = rows.find((r) => r.id === free)
  assert.equal(idle.leased_by_id, null)
  assert.equal(idle.lease_expires_at, null)
})

// 归还之后仍要看得见最后用的是哪个号,否则客户端一退出就再也查不了串号问题。
test('listClients 报出最后一条租约,归还后也还在', async () => {
  const db = makeDb(d1)
  const acc = await seedAccount('a@x.com')
  const cid = await seedClient('mac-mini', 'h-mac')
  const virgin = await seedClient('never-leased', 'h-virgin')
  const now = Date.now()
  const leaseId = await db.claimAccount({ accountId: acc, clientId: cid, expiresAt: now + 60000, now })

  let row = (await db.listClients()).find((c) => c.id === cid)
  assert.equal(row.last_account_id, acc)
  assert.equal(row.last_account_email, 'a@x.com')
  assert.equal(row.last_released_at, null)

  await db.releaseLease({ leaseId, clientId: cid, now: now + 1000 })
  row = (await db.listClients()).find((c) => c.id === cid)
  assert.equal(row.last_account_email, 'a@x.com')
  assert.equal(row.last_released_at, now + 1000)

  const none = (await db.listClients()).find((c) => c.id === virgin)
  assert.equal(none.last_account_id, null)
})

// leases.account_id 有外键。D1 默认开外键检查,所以"删一个租过的账号"在后台会直接
// 500 —— 而且是越常用的账号越删不掉。
test('deleteAccount 能删掉有历史租约的账号', async () => {
  const db = makeDb(d1)
  const acc = await seedAccount('used@x.com')
  const cid = await seedClient('c', 'h')
  const now = Date.now()
  const leaseId = await db.claimAccount({ accountId: acc, clientId: cid, expiresAt: now + 1000, now })
  await db.releaseLease({ leaseId, clientId: cid, now: now + 1 })

  assert.equal(await db.deleteAccount(acc, now + 2), true)
  assert.equal((await db.listAccounts()).length, 0)
  const { results } = await d1.prepare('SELECT id FROM leases WHERE account_id = ?').bind(acc).all()
  assert.equal(results.length, 0, '账号没了,它的租约也不该留成孤儿')
})

// 正被人用着的账号删掉,客户端会抱着一个后台已经不存在的号继续跑。先停用,等它自己还。
test('deleteAccount 拒绝删掉正被持有的账号', async () => {
  const db = makeDb(d1)
  const acc = await seedAccount('busy@x.com')
  const cid = await seedClient('c', 'h')
  const now = Date.now()
  await db.claimAccount({ accountId: acc, clientId: cid, expiresAt: now + 60000, now })

  assert.equal(await db.deleteAccount(acc, now), false)
  assert.equal((await db.listAccounts()).length, 1, '账号还在')
})

test('appendClientLogs 写入并按最新在前读出,匿名记录 client_id 为 null', async () => {
  const db = makeDb(d1)
  const cid = await seedClient('mac', 'h-log')
  await db.appendClientLogs({
    clientId: cid, device: 'mac',
    lines: [{ level: 'log', message: '第一条' }, { level: 'error', message: '第二条' }],
    now: 1000,
  })
  await db.appendClientLogs({
    clientId: null, device: 'win-box',
    lines: [{ level: 'error', message: '注册前的匿名一条' }],
    now: 2000,
  })

  const all = await db.listClientLogs({ limit: 10 })
  assert.equal(all.length, 3)
  assert.equal(all[0].message, '注册前的匿名一条', '最新的在最前')
  assert.equal(all[0].client_id, null)
  assert.equal(all[0].device, 'win-box')
  assert.equal(all[0].ts, 2000)

  const mine = await db.listClientLogs({ clientId: cid, limit: 10 })
  assert.equal(mine.length, 2)
  assert.deepEqual(mine.map((r) => r.message), ['第二条', '第一条'])
  assert.equal(mine[0].level, 'error')
})

// 匿名通道是公开可写的(邀请码随公开 Release 分发),所以库里必须有个天花板,
// 否则一个循环脚本就能把 D1 撑爆。
test('pruneClientLogs 只留最新的若干条', async () => {
  const db = makeDb(d1)
  await db.appendClientLogs({
    clientId: null, device: 'd',
    lines: Array.from({ length: 10 }, (_, i) => ({ level: 'log', message: `第${i}条` })),
    now: 5,
  })
  await db.pruneClientLogs(4)
  const left = await db.listClientLogs({ limit: 50 })
  assert.equal(left.length, 4)
  assert.deepEqual(left.map((r) => r.message), ['第9条', '第8条', '第7条', '第6条'])
})

test('appendClientLogs 收到空数组时什么也不做,不炸', async () => {
  const db = makeDb(d1)
  await db.appendClientLogs({ clientId: null, device: 'd', lines: [], now: 1 })
  assert.equal((await db.listClientLogs({ limit: 5 })).length, 0)
})
