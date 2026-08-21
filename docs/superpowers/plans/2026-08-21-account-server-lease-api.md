# 账号服务端(Cloudflare 租约 API + 管理后台)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把账号池集中到 Cloudflare Workers + D1 后台维护,客户端启动时通过租约 API 拿一个账号自动登录,并保证不撞号。

**Architecture:** 新增 `server/` 作为独立 Cloudflare Worker(Hono + D1)。纯逻辑(加密、token、租约选择)抽成可注入依赖的模块单测;D1 适配层用 miniflare 做集成测试;API/Admin 路由用 Hono 的 `app.request()` + 假 db 做路由测试。客户端新增 `src/account-source.js` 负责"租约 + 离线兜底",[src/main.js](../../../src/main.js) 的 `chooseAccount()` 改为 async,其余(partition、auto-login)不动。

**Tech Stack:** Cloudflare Workers、Hono、D1(SQLite)、Web Crypto(AES-GCM / SHA-256)、miniflare(测试)、node:test。

## Global Constraints

- 运行时:服务端跑在 Cloudflare Workers,只用 Workers 兼容 API(Web Crypto、fetch、D1 binding);不用 Node-only 模块(no `node:crypto`、no `better-sqlite3`)。
- 加密:AES-256-GCM,密钥来自 Worker secret `ACCOUNT_ENC_KEY`(32 字节 base64);密文格式 `iv_base64:cipher_base64`(GCM authTag 附在密文尾部)。
- Token:库里只存 `sha256(token)` 的 hex,不存明文。
- 租约:TTL 默认 30 分钟(`LEASE_TTL_MS`,epoch ms);"有效租约" = `released_at IS NULL AND expires_at > now`。
- 原子分配:用条件写(`INSERT ... SELECT ... WHERE NOT EXISTS(有效租约) AND EXISTS(enabled)` + `RETURNING id`),受影响 0 行即换下一个候选。
- 依赖安装:仓库根 `.npmrc` 已指向 npmmirror,`server/` 内 `npm install` 会自动继承;安装中途**不要**用 pkill 打断。
- 客户端返回结构保持不变:`chooseAccount()` 产出 `{ email, partition, loginScript }`(可多带一个 `lease` 字段),下游 auto-login / partition 逻辑零改动。
- 所有 API 走 HTTPS,需 `Authorization: Bearer <client-token>`。

---

## 文件结构

```
server/
  package.json      # hono, wrangler(dev), miniflare(dev);type=module
  wrangler.toml     # Worker + D1 binding(DB)+ vars(LEASE_TTL_MS)
  schema.sql        # 建表
  src/
    crypto.js       # encryptPassword / decryptPassword(Web Crypto AES-GCM)
    tokens.js       # generateToken / hashToken(SHA-256 hex)
    lease.js        # leaseAccount(db, {...}) + orderCandidates(纯逻辑)
    db.js           # makeDb(d1) → 实现 lease 端口 + renew/release + verifyClient + admin CRUD
    api.js          # registerApiRoutes(app, {makeDb}):/api/lease /renew /release
    admin.js        # registerAdminRoutes(app, {makeDb}):/admin 登录 + 账号/客户端 CRUD
    index.js        # 组装 Hono app,export default
  test/
    crypto.test.js
    tokens.test.js
    lease.test.js
    db.test.js       # miniflare 本地 D1
    api.test.js      # app.request + 假 db
    admin.test.js    # app.request + 假 db

src/account-source.js  # 客户端:配置读取 + requestLease/renew/release + 离线兜底
test/account-source.test.js
src/main.js            # 改:chooseAccount 变 async + 续租/释放接线
```

---

## Task 1: 服务端脚手架 + 密码加密(crypto.js)

**Files:**
- Create: `server/package.json`
- Create: `server/src/crypto.js`
- Test: `server/test/crypto.test.js`

**Interfaces:**
- Produces:
  - `encryptPassword(plaintext: string, keyBase64: string) -> Promise<string>` 返回 `"iv_b64:cipher_b64"`
  - `decryptPassword(enc: string, keyBase64: string) -> Promise<string>`

- [ ] **Step 1: 建 server/package.json**

```json
{
  "name": "genspark-account-server",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test 'test/*.test.js'",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "wrangler": "^3.90.0",
    "miniflare": "^3.20240925.0"
  }
}
```

- [ ] **Step 2: 写失败测试** `server/test/crypto.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptPassword, decryptPassword } from '../src/crypto.js'

// 32 字节全 0 的 base64,仅测试用
const KEY = Buffer.alloc(32).toString('base64')

test('round-trips a password', async () => {
  const enc = await encryptPassword('123Yin321', KEY)
  assert.notEqual(enc, '123Yin321')
  assert.match(enc, /^[^:]+:[^:]+$/)                 // iv:cipher
  assert.equal(await decryptPassword(enc, KEY), '123Yin321')
})

test('two encryptions of same text differ (random IV)', async () => {
  const a = await encryptPassword('same', KEY)
  const b = await encryptPassword('same', KEY)
  assert.notEqual(a, b)
  assert.equal(await decryptPassword(a, KEY), 'same')
  assert.equal(await decryptPassword(b, KEY), 'same')
})

test('wrong key fails to decrypt', async () => {
  const enc = await encryptPassword('secret', KEY)
  const otherKey = Buffer.alloc(32, 1).toString('base64')
  await assert.rejects(() => decryptPassword(enc, otherKey))
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd server && node --test test/crypto.test.js`
Expected: FAIL(`Cannot find module '../src/crypto.js'`)

- [ ] **Step 4: 实现** `server/src/crypto.js`

```js
// AES-256-GCM,基于 Web Crypto(Workers 与 Node 18+ 均内置 globalThis.crypto.subtle)。
const enc = new TextEncoder()
const dec = new TextDecoder()

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(bytes) {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

async function importKey(keyBase64) {
  return crypto.subtle.importKey('raw', b64ToBytes(keyBase64), 'AES-GCM', false, [
    'encrypt', 'decrypt',
  ])
}

export async function encryptPassword(plaintext, keyBase64) {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return bytesToB64(iv) + ':' + bytesToB64(cipher)
}

export async function decryptPassword(encStr, keyBase64) {
  const [ivB64, cipherB64] = encStr.split(':')
  const key = await importKey(keyBase64)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(cipherB64),
  )
  return dec.decode(plain)
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && node --test test/crypto.test.js`
Expected: PASS(3 tests)

- [ ] **Step 6: 提交**

```bash
git add server/package.json server/src/crypto.js server/test/crypto.test.js
git commit -m "feat(server): scaffold + AES-GCM password crypto"
```

---

## Task 2: 客户端 token 生成与校验(tokens.js)

**Files:**
- Create: `server/src/tokens.js`
- Test: `server/test/tokens.test.js`

**Interfaces:**
- Produces:
  - `generateToken() -> Promise<string>`(32 字节随机,base64url,无填充)
  - `hashToken(token: string) -> Promise<string>`(sha256 hex,64 字符小写)

- [ ] **Step 1: 写失败测试** `server/test/tokens.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateToken, hashToken } from '../src/tokens.js'

test('generateToken makes unique url-safe tokens', async () => {
  const a = await generateToken()
  const b = await generateToken()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]+$/)                 // base64url,无 +/=
  assert.ok(a.length >= 40)
})

test('hashToken is deterministic 64-hex sha256', async () => {
  const h1 = await hashToken('hello')
  const h2 = await hashToken('hello')
  assert.equal(h1, h2)
  assert.match(h1, /^[0-9a-f]{64}$/)
  // 已知向量:sha256("hello")
  assert.equal(h1, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test test/tokens.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/src/tokens.js`

```js
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
function bytesToB64url(bytes) {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generateToken() {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return bytesToHex(digest)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test test/tokens.test.js`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
git add server/src/tokens.js server/test/tokens.test.js
git commit -m "feat(server): client token generate + sha256 hash"
```

---

## Task 3: 租约选择核心逻辑(lease.js,纯逻辑)

**Files:**
- Create: `server/src/lease.js`
- Test: `server/test/lease.test.js`

**Interfaces:**
- Consumes(一个可注入的 db 端口,Task 4 由 D1 实现;测试用假对象):
  - `db.availableAccounts(now) -> Promise<Array<{id, email, password_enc}>>`
  - `db.lastAccountIdForClient(clientId) -> Promise<number|null>`
  - `db.claimAccount({accountId, clientId, expiresAt, now}) -> Promise<number|null>`(返回 leaseId,竞争失败返回 null)
  - `db.touchAccount(accountId, now) -> Promise<void>`
- Produces:
  - `orderCandidates(candidates, stickyId, random) -> Array`(sticky 排最前,其余用 random 打散)
  - `leaseAccount(db, {clientId, now, ttlMs, random?}) -> Promise<{leaseId, accountId, email, password_enc, expiresAt}|null>`

- [ ] **Step 1: 写失败测试** `server/test/lease.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderCandidates, leaseAccount } from '../src/lease.js'

const A = { id: 1, email: 'a@x.com', password_enc: 'ea' }
const B = { id: 2, email: 'b@x.com', password_enc: 'eb' }
const C = { id: 3, email: 'c@x.com', password_enc: 'ec' }

test('orderCandidates puts sticky account first', () => {
  const ordered = orderCandidates([A, B, C], 3, () => 0)
  assert.equal(ordered[0].id, 3)
  assert.equal(ordered.length, 3)
})

test('orderCandidates without sticky keeps all, no crash', () => {
  const ordered = orderCandidates([A, B], null, () => 0)
  assert.deepEqual(ordered.map((a) => a.id).sort(), [1, 2])
})

// 假 db:第一个 claim 失败(模拟被并发抢走),第二个成功
function fakeDb({ available, sticky = null, failIds = [] }) {
  const claimed = []
  const touched = []
  return {
    async availableAccounts() { return available },
    async lastAccountIdForClient() { return sticky },
    async claimAccount({ accountId }) {
      if (failIds.includes(accountId)) return null
      claimed.push(accountId)
      return 100 + accountId
    },
    async touchAccount(id) { touched.push(id) },
    _claimed: claimed,
    _touched: touched,
  }
}

test('leaseAccount returns null when no accounts available', async () => {
  const res = await leaseAccount(fakeDb({ available: [] }), { clientId: 7, now: 1000, ttlMs: 60000 })
  assert.equal(res, null)
})

test('leaseAccount claims sticky first and sets expiry', async () => {
  const db = fakeDb({ available: [A, B, C], sticky: 2 })
  const res = await leaseAccount(db, { clientId: 7, now: 1000, ttlMs: 60000, random: () => 0 })
  assert.equal(res.accountId, 2)
  assert.equal(res.email, 'b@x.com')
  assert.equal(res.password_enc, 'eb')
  assert.equal(res.leaseId, 102)
  assert.equal(res.expiresAt, 61000)
  assert.deepEqual(db._touched, [2])
})

test('leaseAccount retries next candidate when claim loses the race', async () => {
  // sticky=1 会先试,但 failIds 含 1 → 换下一个
  const db = fakeDb({ available: [A, B, C], sticky: 1, failIds: [1] })
  const res = await leaseAccount(db, { clientId: 7, now: 0, ttlMs: 1000, random: () => 0 })
  assert.notEqual(res, null)
  assert.notEqual(res.accountId, 1)
  assert.ok(db._claimed.length === 1)
})

test('leaseAccount returns null when every claim loses', async () => {
  const db = fakeDb({ available: [A, B], failIds: [1, 2] })
  const res = await leaseAccount(db, { clientId: 7, now: 0, ttlMs: 1000 })
  assert.equal(res, null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test test/lease.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/src/lease.js`

```js
// sticky 账号排最前,其余用注入的 random 洗牌(Fisher–Yates),便于确定性测试。
export function orderCandidates(candidates, stickyId, random = Math.random) {
  const sticky = []
  const rest = []
  for (const c of candidates) {
    if (stickyId != null && c.id === stickyId) sticky.push(c)
    else rest.push(c)
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return [...sticky, ...rest]
}

export async function leaseAccount(db, { clientId, now, ttlMs, random = Math.random }) {
  const candidates = await db.availableAccounts(now)
  if (!candidates.length) return null
  const stickyId = await db.lastAccountIdForClient(clientId)
  const expiresAt = now + ttlMs
  for (const acct of orderCandidates(candidates, stickyId, random)) {
    const leaseId = await db.claimAccount({ accountId: acct.id, clientId, expiresAt, now })
    if (leaseId != null) {
      await db.touchAccount(acct.id, now)
      return { leaseId, accountId: acct.id, email: acct.email, password_enc: acct.password_enc, expiresAt }
    }
  }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test test/lease.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add server/src/lease.js server/test/lease.test.js
git commit -m "feat(server): lease selection logic (sticky + race-safe retry)"
```

---

## Task 4: D1 适配层 + 建表(db.js,miniflare 集成测试)

**Files:**
- Create: `server/schema.sql`
- Create: `server/wrangler.toml`
- Create: `server/src/db.js`
- Test: `server/test/db.test.js`

**Interfaces:**
- Consumes: D1Database(`env.DB`);`lease.js` 需要的端口方法。
- Produces: `makeDb(d1) -> db`,含:
  - lease 端口:`availableAccounts(now)`、`lastAccountIdForClient(clientId)`、`claimAccount({accountId,clientId,expiresAt,now})`、`touchAccount(accountId,now)`
  - `renewLease({leaseId, clientId, now, ttlMs}) -> Promise<number|null>`(新 expiresAt 或 null)
  - `releaseLease({leaseId, clientId, now}) -> Promise<void>`
  - `verifyClient(tokenHash, now) -> Promise<{id}|null>`(仅 enabled,并更新 last_seen)
  - admin:`listAccounts()`、`createAccount({email,password_enc,note})`、`updateAccount(id,{...})`、`deleteAccount(id)`、`listClients()`、`createClient({name,token_hash})`、`setClientEnabled(id,enabled)`

- [ ] **Step 1: 建表** `server/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_enc  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  last_used_at  INTEGER
);
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER
);
CREATE TABLE IF NOT EXISTS leases (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  expires_at    INTEGER NOT NULL,
  released_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leases_active ON leases(account_id, released_at, expires_at);
```

- [ ] **Step 2: 建** `server/wrangler.toml`

```toml
name = "genspark-account-server"
main = "src/index.js"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "genspark-accounts"
database_id = "REPLACE_WITH_ID_FROM_wrangler_d1_create"   # 部署时填入

[vars]
LEASE_TTL_MS = "1800000"
```

- [ ] **Step 3: 写失败测试** `server/test/db.test.js`

```js
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { makeDb } from '../src/db.js'

let mf, d1
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

before(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'test-db' },
  })
  d1 = await mf.getD1Database('DB')
})
after(async () => { await mf.dispose() })

beforeEach(async () => {
  for (const t of ['leases', 'clients', 'accounts']) {
    await d1.prepare(`DROP TABLE IF EXISTS ${t}`).run()
  }
  for (const stmt of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
    await d1.prepare(stmt).run()
  }
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
  // 给 a3 一个有效租约
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
  // now 已过 expiresAt=500
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
  // 别的 client 续不了
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
```

- [ ] **Step 4: 跑测试确认失败**

先装依赖(继承根 .npmrc 的 npmmirror,勿中途打断):

```bash
cd server && npm install
```

Run: `cd server && node --test test/db.test.js`
Expected: FAIL(`makeDb` 未定义)

- [ ] **Step 5: 实现** `server/src/db.js`

```js
// D1 适配层。所有写用条件语句 + RETURNING 保证并发安全。
export function makeDb(d1) {
  return {
    async availableAccounts(now) {
      const { results } = await d1
        .prepare(
          `SELECT a.id, a.email, a.password_enc
             FROM accounts a
            WHERE a.enabled = 1
              AND NOT EXISTS (
                SELECT 1 FROM leases l
                 WHERE l.account_id = a.id AND l.released_at IS NULL AND l.expires_at > ?1)`,
        )
        .bind(now)
        .all()
      return results || []
    },

    async lastAccountIdForClient(clientId) {
      const row = await d1
        .prepare('SELECT account_id FROM leases WHERE client_id = ?1 ORDER BY id DESC LIMIT 1')
        .bind(clientId)
        .first()
      return row ? row.account_id : null
    },

    async claimAccount({ accountId, clientId, expiresAt, now }) {
      const row = await d1
        .prepare(
          `INSERT INTO leases (account_id, client_id, expires_at, released_at)
             SELECT ?1, ?2, ?3, NULL
              WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND enabled = 1)
                AND NOT EXISTS (
                  SELECT 1 FROM leases
                   WHERE account_id = ?1 AND released_at IS NULL AND expires_at > ?4)
           RETURNING id`,
        )
        .bind(accountId, clientId, expiresAt, now)
        .first()
      return row ? row.id : null
    },

    async touchAccount(accountId, now) {
      await d1.prepare('UPDATE accounts SET last_used_at = ?2 WHERE id = ?1').bind(accountId, now).run()
    },

    async renewLease({ leaseId, clientId, now, ttlMs }) {
      const row = await d1
        .prepare(
          `UPDATE leases SET expires_at = ?3
             WHERE id = ?1 AND client_id = ?2 AND released_at IS NULL AND expires_at > ?4
           RETURNING expires_at`,
        )
        .bind(leaseId, clientId, now + ttlMs, now)
        .first()
      return row ? row.expires_at : null
    },

    async releaseLease({ leaseId, clientId, now }) {
      await d1
        .prepare(
          'UPDATE leases SET released_at = ?3 WHERE id = ?1 AND client_id = ?2 AND released_at IS NULL',
        )
        .bind(leaseId, clientId, now)
        .run()
    },

    async verifyClient(tokenHash, now) {
      const row = await d1
        .prepare('SELECT id FROM clients WHERE token_hash = ?1 AND enabled = 1')
        .bind(tokenHash)
        .first()
      if (!row) return null
      await d1.prepare('UPDATE clients SET last_seen_at = ?2 WHERE id = ?1').bind(row.id, now).run()
      return { id: row.id }
    },

    async listAccounts() {
      const { results } = await d1
        .prepare(
          `SELECT a.id, a.email, a.enabled, a.note, a.last_used_at,
                  (SELECT c.name FROM leases l JOIN clients c ON c.id = l.client_id
                    WHERE l.account_id = a.id AND l.released_at IS NULL AND l.expires_at > ?1
                    ORDER BY l.id DESC LIMIT 1) AS leased_by
             FROM accounts a ORDER BY a.id`,
        )
        .bind(Date.now())
        .all()
      return results || []
    },
    async createAccount({ email, password_enc, note }) {
      const row = await d1
        .prepare('INSERT INTO accounts (email, password_enc, note) VALUES (?1,?2,?3) RETURNING id')
        .bind(email, password_enc, note ?? null)
        .first()
      return row.id
    },
    async updateAccount(id, fields) {
      const sets = []
      const vals = []
      for (const k of ['email', 'password_enc', 'enabled', 'note']) {
        if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]) }
      }
      if (!sets.length) return
      vals.push(id)
      await d1.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()
    },
    async deleteAccount(id) {
      await d1.prepare('DELETE FROM accounts WHERE id = ?1').bind(id).run()
    },
    async listClients() {
      const { results } = await d1
        .prepare('SELECT id, name, enabled, last_seen_at FROM clients ORDER BY id')
        .all()
      return results || []
    },
    async createClient({ name, token_hash }) {
      const row = await d1
        .prepare('INSERT INTO clients (name, token_hash) VALUES (?1,?2) RETURNING id')
        .bind(name, token_hash)
        .first()
      return row.id
    },
    async setClientEnabled(id, enabled) {
      await d1.prepare('UPDATE clients SET enabled = ?2 WHERE id = ?1').bind(id, enabled ? 1 : 0).run()
    },
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server && node --test test/db.test.js`
Expected: PASS(8 tests)

- [ ] **Step 7: 提交**

```bash
git add server/schema.sql server/wrangler.toml server/src/db.js server/test/db.test.js server/package-lock.json
git commit -m "feat(server): D1 adapter + schema (atomic claim verified via miniflare)"
```

---

## Task 5: 租约 API 路由(api.js)

**Files:**
- Create: `server/src/api.js`
- Test: `server/test/api.test.js`

**Interfaces:**
- Consumes: `leaseAccount`(Task 3)、`hashToken`(Task 2)、`decryptPassword`(Task 1)、db 端口(Task 4);Hono。
- Produces: `registerApiRoutes(app, { makeDb }) -> void`,挂:
  - `POST /api/lease` → `200 {email,password,lease_id,expires_at}` / `401` / `409 {error:"no_account_available"}`
  - `POST /api/renew` `{lease_id}` → `200 {expires_at}` / `401` / `410 {error:"lease_expired"}`
  - `POST /api/release` `{lease_id}` → `200 {ok:true}` / `401`
  - env 读取:`c.env.DB`、`c.env.ACCOUNT_ENC_KEY`、`c.env.LEASE_TTL_MS`

- [ ] **Step 1: 写失败测试** `server/test/api.test.js`

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test test/api.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/src/api.js`

```js
import { makeDb as realMakeDb } from './db.js'
import { leaseAccount } from './lease.js'
import { hashToken } from './tokens.js'
import { decryptPassword } from './crypto.js'

function bearer(c) {
  const h = c.req.header('Authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}

export function registerApiRoutes(app, { makeDb = realMakeDb } = {}) {
  // 鉴权中间件:校验 token,把 client 挂到 c.var
  app.use('/api/*', async (c, next) => {
    const token = bearer(c)
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const db = makeDb(c.env.DB)
    const client = await db.verifyClient(await hashToken(token), Date.now())
    if (!client) return c.json({ error: 'unauthorized' }, 401)
    c.set('db', db)
    c.set('client', client)
    await next()
  })

  app.post('/api/lease', async (c) => {
    const db = c.get('db')
    const ttlMs = Number(c.env.LEASE_TTL_MS || 1800000)
    const res = await leaseAccount(db, { clientId: c.get('client').id, now: Date.now(), ttlMs })
    if (!res) return c.json({ error: 'no_account_available' }, 409)
    const password = await decryptPassword(res.password_enc, c.env.ACCOUNT_ENC_KEY)
    return c.json({ email: res.email, password, lease_id: res.leaseId, expires_at: res.expiresAt })
  })

  app.post('/api/renew', async (c) => {
    const db = c.get('db')
    const { lease_id } = await c.req.json().catch(() => ({}))
    const ttlMs = Number(c.env.LEASE_TTL_MS || 1800000)
    const expiresAt = await db.renewLease({ leaseId: lease_id, clientId: c.get('client').id, now: Date.now(), ttlMs })
    if (expiresAt == null) return c.json({ error: 'lease_expired' }, 410)
    return c.json({ expires_at: expiresAt })
  })

  app.post('/api/release', async (c) => {
    const db = c.get('db')
    const { lease_id } = await c.req.json().catch(() => ({}))
    await db.releaseLease({ leaseId: lease_id, clientId: c.get('client').id, now: Date.now() })
    return c.json({ ok: true })
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test test/api.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
git add server/src/api.js server/test/api.test.js
git commit -m "feat(server): lease/renew/release API routes with bearer auth"
```

---

## Task 6: 管理后台(admin.js)+ Worker 入口(index.js)

**Files:**
- Create: `server/src/admin.js`
- Create: `server/src/index.js`
- Test: `server/test/admin.test.js`

**Interfaces:**
- Consumes: db 端口(Task 4)、`hashToken`(Task 2)、`encryptPassword`(Task 1)、`generateToken`(Task 2)、Hono + hono/cookie。
- Produces:
  - `registerAdminRoutes(app, { makeDb }) -> void`:
    - `GET /admin/login`(表单)、`POST /admin/login`(密码 = env `ADMIN_PASSWORD_HASH` 的 sha256 比对,成功下发签名 cookie)
    - `GET /admin`(账号 + 客户端列表,HTML;未登录 302 到 /admin/login)
    - `POST /admin/accounts`(新增,明文密码→`encryptPassword` 存)、`POST /admin/accounts/:id/toggle`、`POST /admin/accounts/:id/delete`
    - `POST /admin/clients`(生成 token,**明文只回显一次**)、`POST /admin/clients/:id/toggle`
    - 认证:签名 cookie `admin`,HMAC 用 env `ADMIN_PASSWORD_HASH` 作 key(不额外加 secret)
  - `index.js`:`const app = new Hono(); registerApiRoutes(app); registerAdminRoutes(app); export default app`

- [ ] **Step 1: 写失败测试** `server/test/admin.test.js`

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test test/admin.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/src/admin.js`

```js
import { makeDb as realMakeDb } from './db.js'
import { hashToken, generateToken } from './tokens.js'
import { encryptPassword } from './crypto.js'
import { getSignedCookie, setSignedCookie } from 'hono/cookie'

const COOKIE = 'admin'

function page(title, body) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title>` +
    `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px}` +
    `table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left}` +
    `input,button{padding:6px 8px;margin:2px}form.inline{display:inline}</style>${body}`
}

async function isAuthed(c) {
  const key = c.env.ADMIN_PASSWORD_HASH
  const v = await getSignedCookie(c, key, COOKIE)
  return v === '1'
}

export function registerAdminRoutes(app, { makeDb = realMakeDb } = {}) {
  app.get('/admin/login', (c) =>
    c.html(page('登录', '<h1>老猫后台</h1><form method=post action=/admin/login>' +
      '<input type=password name=password placeholder=管理员密码 autofocus>' +
      '<button>登录</button></form>')))

  app.post('/admin/login', async (c) => {
    const form = await c.req.parseBody()
    const ok = (await hashToken(String(form.password || ''))) === c.env.ADMIN_PASSWORD_HASH
    if (!ok) return c.html(page('登录', '<p>密码错误</p><a href=/admin/login>返回</a>'), 401)
    await setSignedCookie(c, COOKIE, '1', c.env.ADMIN_PASSWORD_HASH, {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/admin', maxAge: 86400,
    })
    return c.redirect('/admin', 302)
  })

  app.use('/admin', async (c, next) => {
    if (!(await isAuthed(c))) return c.redirect('/admin/login', 302)
    await next()
  })
  app.use('/admin/accounts/*', async (c, next) => {
    if (!(await isAuthed(c))) return c.redirect('/admin/login', 302)
    await next()
  })
  app.use('/admin/clients*', async (c, next) => {
    if (!(await isAuthed(c))) return c.redirect('/admin/login', 302)
    await next()
  })

  app.get('/admin', async (c) => {
    const db = makeDb(c.env.DB)
    const accounts = await db.listAccounts()
    const clients = await db.listClients()
    const arows = accounts.map((a) =>
      `<tr><td>${a.id}</td><td>${a.email}</td><td>${a.enabled ? '✓' : '✗'}</td>` +
      `<td>${a.leased_by || ''}</td><td>` +
      `<form class=inline method=post action=/admin/accounts/${a.id}/toggle><button>开关</button></form> ` +
      `<form class=inline method=post action=/admin/accounts/${a.id}/delete><button>删</button></form></td></tr>`).join('')
    const crows = clients.map((cl) =>
      `<tr><td>${cl.id}</td><td>${cl.name}</td><td>${cl.enabled ? '✓' : '✗'}</td><td>` +
      `<form class=inline method=post action=/admin/clients/${cl.id}/toggle><button>开关</button></form></td></tr>`).join('')
    return c.html(page('后台',
      '<h1>账号</h1>' +
      '<form method=post action=/admin/accounts><input name=email placeholder=email>' +
      '<input name=password placeholder=密码><input name=note placeholder=备注><button>新增</button></form>' +
      `<table><tr><th>id<th>email<th>启用<th>租给<th>操作</tr>${arows}</table>` +
      '<h1>客户端</h1>' +
      '<form method=post action=/admin/clients><input name=name placeholder=名称><button>生成 token</button></form>' +
      `<table><tr><th>id<th>名称<th>启用<th>操作</tr>${crows}</table>`))
  })

  app.post('/admin/accounts', async (c) => {
    const db = makeDb(c.env.DB)
    const f = await c.req.parseBody()
    const enc = await encryptPassword(String(f.password || ''), c.env.ACCOUNT_ENC_KEY)
    await db.createAccount({ email: String(f.email || ''), password_enc: enc, note: f.note ? String(f.note) : null })
    return c.redirect('/admin', 302)
  })
  app.post('/admin/accounts/:id/toggle', async (c) => {
    const db = makeDb(c.env.DB)
    const list = await db.listAccounts()
    const a = list.find((x) => x.id === Number(c.req.param('id')))
    if (a) await db.updateAccount(a.id, { enabled: a.enabled ? 0 : 1 })
    return c.redirect('/admin', 302)
  })
  app.post('/admin/accounts/:id/delete', async (c) => {
    await makeDb(c.env.DB).deleteAccount(Number(c.req.param('id')))
    return c.redirect('/admin', 302)
  })

  app.post('/admin/clients', async (c) => {
    const db = makeDb(c.env.DB)
    const f = await c.req.parseBody()
    const token = await generateToken()
    await db.createClient({ name: String(f.name || ''), token_hash: await hashToken(token) })
    return c.html(page('新 token',
      `<p>客户端 <b>${f.name}</b> 的 token(只显示这一次,请复制):</p>` +
      `<pre>${token}</pre><a href=/admin>返回</a>`))
  })
  app.post('/admin/clients/:id/toggle', async (c) => {
    const db = makeDb(c.env.DB)
    const list = await db.listClients()
    const cl = list.find((x) => x.id === Number(c.req.param('id')))
    if (cl) await db.setClientEnabled(cl.id, !cl.enabled)
    return c.redirect('/admin', 302)
  })
}
```

- [ ] **Step 4: 实现 Worker 入口** `server/src/index.js`

```js
import { Hono } from 'hono'
import { registerApiRoutes } from './api.js'
import { registerAdminRoutes } from './admin.js'

const app = new Hono()
registerApiRoutes(app)
registerAdminRoutes(app)
app.get('/', (c) => c.text('genspark account server'))

export default app
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && node --test test/admin.test.js`
Expected: PASS(3 tests)

- [ ] **Step 6: 跑全部服务端测试**

Run: `cd server && npm test`
Expected: 全绿(crypto/tokens/lease/db/api/admin)

- [ ] **Step 7: 提交**

```bash
git add server/src/admin.js server/src/index.js server/test/admin.test.js
git commit -m "feat(server): admin backend (accounts + client tokens) and Worker entry"
```

---

## Task 7: 客户端账号来源(account-source.js)

**Files:**
- Create: `src/account-source.js`
- Test: `test/account-source.test.js`

**Interfaces:**
- Consumes: 注入的 `fetch`、`fs`(默认 `node:fs` / 全局 fetch)。
- Produces:
  - `serverConfigFile(userDataDir) -> string`
  - `readServerConfig(userDataDir, {fs}) -> {apiBase, token}|null`(缺文件/缺字段→null)
  - `cachedAccountFile(userDataDir) -> string`
  - `readCachedAccount(userDataDir, {fs}) -> {email, password}|null`
  - `writeCachedAccount(userDataDir, {email,password}, {fs}) -> void`
  - `requestLease({apiBase, token}, {fetch}) -> {email,password,lease_id,expires_at}|null`
  - `renewLease({apiBase, token, leaseId}, {fetch}) -> number|null`
  - `releaseLease({apiBase, token, leaseId}, {fetch}) -> void`
  - `resolveRemoteAccount(userDataDir, {fetch, fs}) -> {email, password, lease}|null`,`lease` = `{apiBase, token, leaseId, expiresAt}` 或 null(来自缓存兜底时)

- [ ] **Step 1: 写失败测试** `test/account-source.test.js`

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/account-source.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `src/account-source.js`

```js
const fsDefault = require('node:fs')
const path = require('node:path')

function serverConfigFile(userDataDir) { return path.join(userDataDir, 'server-config.json') }
function cachedAccountFile(userDataDir) { return path.join(userDataDir, 'cached-account.json') }

function readServerConfig(userDataDir, { fs = fsDefault } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(serverConfigFile(userDataDir), 'utf8'))
    if (!c.apiBase || !c.token) return null
    return { apiBase: c.apiBase, token: c.token }
  } catch { return null }
}

function readCachedAccount(userDataDir, { fs = fsDefault } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(cachedAccountFile(userDataDir), 'utf8'))
    if (!c.email || !c.password) return null
    return { email: c.email, password: c.password }
  } catch { return null }
}

function writeCachedAccount(userDataDir, { email, password }, { fs = fsDefault } = {}) {
  try { fs.writeFileSync(cachedAccountFile(userDataDir), JSON.stringify({ email, password })) }
  catch (e) { console.error('[account-source] cache write failed:', e.message) }
}

async function post(apiBase, endpoint, token, body, fetchImpl) {
  const res = await fetchImpl(apiBase + endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) return null
  return res.json()
}

async function requestLease({ apiBase, token }, { fetch = globalThis.fetch } = {}) {
  try { return await post(apiBase, '/api/lease', token, null, fetch) }
  catch { return null }
}

async function renewLease({ apiBase, token, leaseId }, { fetch = globalThis.fetch } = {}) {
  try {
    const out = await post(apiBase, '/api/renew', token, { lease_id: leaseId }, fetch)
    return out ? out.expires_at : null
  } catch { return null }
}

async function releaseLease({ apiBase, token, leaseId }, { fetch = globalThis.fetch } = {}) {
  try { await post(apiBase, '/api/release', token, { lease_id: leaseId }, fetch) }
  catch { /* 尽力,失败无所谓,租约会过期 */ }
}

// 远端优先;失败回落本地缓存(lease=null,表示无需续租);都没有返回 null。
async function resolveRemoteAccount(userDataDir, { fetch = globalThis.fetch, fs = fsDefault } = {}) {
  const cfg = readServerConfig(userDataDir, { fs })
  if (!cfg) return null
  const leased = await requestLease(cfg, { fetch })
  if (leased) {
    writeCachedAccount(userDataDir, { email: leased.email, password: leased.password }, { fs })
    return {
      email: leased.email,
      password: leased.password,
      lease: { apiBase: cfg.apiBase, token: cfg.token, leaseId: leased.lease_id, expiresAt: leased.expires_at },
    }
  }
  const cached = readCachedAccount(userDataDir, { fs })
  if (cached) return { email: cached.email, password: cached.password, lease: null }
  return null
}

module.exports = {
  serverConfigFile, cachedAccountFile,
  readServerConfig, readCachedAccount, writeCachedAccount,
  requestLease, renewLease, releaseLease, resolveRemoteAccount,
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/account-source.test.js`
Expected: PASS(9 tests)

- [ ] **Step 5: 提交**

```bash
git add src/account-source.js test/account-source.test.js
git commit -m "feat(client): remote account source with lease + offline fallback"
```

---

## Task 8: 接入 main.js(async chooseAccount + 续租/释放)

**Files:**
- Modify: `src/main.js`
- (无新增单测;`main.js` 是 Electron 接线层,靠既有 `npm test` 全绿 + 手动冒烟验证)

**Interfaces:**
- Consumes: `resolveRemoteAccount`、`renewLease`、`releaseLease`(Task 7);现有 `partitionName`、`buildLoginScript`。

- [ ] **Step 1: 引入 account-source,把桌面逻辑抽成 pickLocalAccount**

在 [src/main.js](../../../src/main.js) 顶部 require 区加入:

```js
const { resolveRemoteAccount, renewLease, releaseLease } = require('./account-source')
```

把现有 `chooseAccount()` 里的桌面文件逻辑抽成一个同步函数 `pickLocalAccount(userData)`,返回 `{ email, password }` 或 null(不再直接拼 loginScript):

```js
// 桌面文件兜底:读池子挑一个,返回明文账号或 null。
function pickLocalAccount(userData) {
  const file = accountsFile(app.getPath('desktop'))
  ensureAccountsFile(file)
  const { avoidRepeatLast, accounts } = loadAccounts(file)
  const real = realAccounts(accounts)
  if (!real.length) return null
  const lastFile = lastAccountFile(userData)
  const account = pickAccount(real, { lastEmail: readLastEmail(lastFile), avoidRepeatLast })
  if (!account) return null
  writeLastEmail(lastFile, account.email)
  return { email: account.email, password: account.password }
}
```

- [ ] **Step 2: 把 chooseAccount 改成 async(远端优先,桌面兜底)**

```js
// 远端租约优先;失败回落本地缓存 / 桌面池;都没有返回 null。
async function chooseAccount() {
  const userData = app.getPath('userData')
  const remote = await resolveRemoteAccount(userData)   // {email,password,lease}|null
  const chosen = remote || pickLocalAccount(userData)   // {email,password}|null
  if (!chosen) return null
  return {
    email: chosen.email,
    partition: partitionName(chosen.email),
    loginScript: buildLoginScript(chosen.email, chosen.password),
    lease: remote ? remote.lease : null,
  }
}
```

- [ ] **Step 3: 加续租/释放管理(模块级)**

在 `createWindow` 之前加入租约跟踪:

```js
// 活跃租约集合:窗口拿到 lease 后登记,定时续租,退出时释放。
const activeLeases = new Set()
let renewTimer = null

function trackLease(lease) {
  if (!lease) return
  activeLeases.add(lease)
  if (!renewTimer) {
    renewTimer = setInterval(async () => {
      for (const l of activeLeases) {
        const exp = await renewLease(l)
        if (exp == null) activeLeases.delete(l)   // 已失效:下次启动会重租,不打断当前会话
        else l.expiresAt = exp
      }
    }, 10 * 60 * 1000)
    if (renewTimer.unref) renewTimer.unref()
  }
}

async function releaseAllLeases() {
  const leases = [...activeLeases]
  activeLeases.clear()
  await Promise.all(leases.map((l) => releaseLease(l)))
}
```

- [ ] **Step 4: createWindow 登记租约;whenReady/activate 改 await;before-quit 释放**

`createWindow(dir, account)` 里,在 `if (account) { ... }` 块内追加登记(仅当带 lease):

```js
  if (account) {
    const wcId = win.webContents.id
    registerLoginScript(wcId, account.loginScript)
    win.webContents.on('destroyed', () => clearLoginScript(wcId))
    trackLease(account.lease)                    // 新增
  }
```

`whenReady` 与 `activate` 两处的 `chooseAccount()` 改为 `await`:

```js
app.whenReady().then(async () => {
  const dir = scriptsDir(app.getPath('userData'))
  ensureScriptDir(dir)
  serveScripts(dir)
  serveAccount()

  app.on('browser-window-created', (_event, win) => guardWindowTitle(win))
  buildMenu({ onOpenScriptsDir: () => shell.openPath(dir) })
  createWindow(dir, await chooseAccount())

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dir, await chooseAccount())
  })
})

// 退出前尽力释放租约,让账号立即回到可用池(失败也无妨,会自然过期)。
app.on('before-quit', (e) => {
  if (!activeLeases.size) return
  e.preventDefault()
  releaseAllLeases().finally(() => app.exit(0))
})
```

- [ ] **Step 5: 跑既有测试确认没打破**

Run: `npm test`
Expected: 既有客户端测试 + 新增 account-source 测试全绿。

- [ ] **Step 6: 手动冒烟(需真实 Worker + 一个 token)**

在 userData(`~/Library/Application Support/Genspark/`)放 `server-config.json`:
```json
{ "apiBase": "https://<你的 worker 域名>", "token": "<后台生成的 token>" }
```
后台先录入一个真实账号。跑 `npm start`:预期出现"老猫 · 正在登录…"遮罩 → 自动填 B2C → 登录后显示页面。删掉 `server-config.json` 再跑,应回退到桌面池逻辑。

- [ ] **Step 7: 提交**

```bash
git add src/main.js
git commit -m "feat(client): async chooseAccount via lease API with renew/release + desktop fallback"
```

---

## Self-Review(对照 spec)

**Spec coverage:**
- 架构/目录 → 文件结构 + 各 Task 覆盖。
- 数据模型 → Task 4 `schema.sql`。
- 加密 → Task 1。
- API 契约(lease/renew/release、401/409/410)→ Task 5。
- 租约语义(TTL、续租、崩溃回收、原子分配、粘性)→ Task 3(选择/粘性/重试)+ Task 4(条件写/过期/续租/释放,含并发测试)+ Task 8(客户端续租/释放)。
- 客户端改动(config、async chooseAccount、回落链、续租/释放)→ Task 7 + Task 8。
- 管理后台(登录、账号 CRUD、token 生成一次性回显、启停)→ Task 6。
- 测试策略 → 各 Task 的 TDD 步骤;miniflare 集成在 Task 4。
- 部署 → 见 spec 部署章节(实现完成后按其执行 `wrangler d1 create`/`secret put`/`deploy`)。
- 兼容/回滚 → Task 8 桌面兜底 + 删除 config 退回本地。

**Placeholder scan:** `wrangler.toml` 的 `database_id` 是部署时才有的真实值(deploy 步骤填),非计划占位;其余无 TBD/TODO。

**Type consistency:** db 端口方法名(`availableAccounts`/`lastAccountIdForClient`/`claimAccount`/`touchAccount`/`renewLease`/`releaseLease`/`verifyClient` 及 admin CRUD)在 Task 3 消费、Task 4 实现、Task 5/6 使用处一致;客户端 `resolveRemoteAccount` 返回的 `lease={apiBase,token,leaseId,expiresAt}` 与 Task 8 的 `renewLease/releaseLease` 入参一致。
