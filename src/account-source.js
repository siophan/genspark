const fsDefault = require('node:fs')
const path = require('node:path')

function serverConfigFile(userDataDir) { return path.join(userDataDir, 'server-config.json') }
function cachedAccountFile(userDataDir) { return path.join(userDataDir, 'cached-account.json') }

function readServerConfig(userDataDir, { fs = fsDefault } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(serverConfigFile(userDataDir), 'utf8'))
    // server-config.json 是用户手写的,`https://xxx.workers.dev/` 是极可能的写法。
    // 直接拼接会得到 `//api/lease`,Hono 对它一律 404,而客户端把任何非 2xx 都读成
    // "服务器不可用",于是永远回落到缓存/桌面文件 —— 配置看着好好的,功能却从没生效
    // 过。所以在唯一的读取入口把尾部斜杠一次性规范掉。
    const apiBase = String(c.apiBase || '').replace(/\/+$/, '')
    if (!apiBase || !c.token) return null
    return { apiBase, token: c.token }
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
  // 0600:文件里是明文密码,默认的 0644 会让同一台 Mac 上任何别的用户都读得到。
  // 写失败照旧只记一行日志 —— 缓存不上不该让这次已经拿到手的账号作废。
  const file = cachedAccountFile(userDataDir)
  try {
    fs.writeFileSync(file, JSON.stringify({ email, password }), { mode: 0o600 })
  }
  catch (e) { console.error('[account-source] cache write failed:', e.message); return }
  // mode only applies when writeFileSync creates the file, so a cache written
  // by an older build stays 0644 through every overwrite. Tighten it directly.
  try { fs.chmodSync(file, 0o600) } catch {}
}

// 永不抛。统一返回 { ok, status, body }:status 为 0 表示请求根本没发出去
// (网络异常),否则就是真实的 HTTP 状态码。调用方靠 status 区分"服务器明确
// 地说了什么"和"这一次没成"。日志里只有路径与状态码,绝不包含 token 或密码。
async function post(apiBase, endpoint, token, body, fetchImpl) {
  let res
  try {
    res = await fetchImpl(apiBase + endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    console.error('[account-source] POST ' + endpoint + ' could not be sent (offline?):', err)
    return { ok: false, status: 0, body: null }
  }
  if (!res.ok) {
    // 带上状态码,否则 404(apiBase 写错)、401(token 失效)和真的离线
    // 在日志里长得一模一样,配置错了根本无从发现。
    console.error('[account-source] POST ' + endpoint + ' returned HTTP ' + res.status)
    return { ok: false, status: res.status, body: null }
  }
  try { return { ok: true, status: res.status, body: await res.json() } }
  catch (err) {
    console.error('[account-source] POST ' + endpoint + ' returned an unreadable body:', err)
    return { ok: false, status: res.status, body: null }
  }
}

async function requestLease({ apiBase, token }, { fetch = globalThis.fetch } = {}) {
  const r = await post(apiBase, '/api/lease', token, null, fetch)
  return r.ok ? r.body : null
}

// renewLease 的三态返回。两态(number|null)是不够的:把一次 Wi-Fi 抖动当成
// "租约没了",调用方就会永久停止续租,租约 30 分钟后在服务端过期,另一台机器
// 拿到同一个账号 —— 正是这个功能本来要防的事。
const LEASE_RENEWED = 'renewed'   // { status, expiresAt }:续租成功
const LEASE_GONE = 'gone'         // 服务端明确说租约没了(HTTP 410 lease_expired)
const LEASE_RETRY = 'retry'       // 只是这一次没成(网络异常/5xx/坏 body),租约大概率还在

async function renewLease({ apiBase, token, leaseId }, { fetch = globalThis.fetch } = {}) {
  const r = await post(apiBase, '/api/renew', token, { lease_id: leaseId }, fetch)
  if (r.ok && r.body && typeof r.body.expires_at === 'number') {
    return { status: LEASE_RENEWED, expiresAt: r.body.expires_at }
  }
  if (r.status === 410) return { status: LEASE_GONE }
  return { status: LEASE_RETRY }
}

// 一轮续租,就地维护跟踪集合:确实没了的踢出去,续上的更新到期时间,
// 只是这一次没成的原样留着等下一轮。永不抛。
async function renewTrackedLeases(leases, { fetch = globalThis.fetch } = {}) {
  for (const held of leases) {
    // 安全网:就算续租一直卡在"这一次没成"上,到期时间已经过去的租约
    // 也已经真的死了,不能无限重试下去。
    if (typeof held.expiresAt === 'number' && held.expiresAt <= Date.now()) {
      leases.delete(held)
      continue
    }
    const r = await renewLease(held, { fetch })
    if (r.status === LEASE_RENEWED) held.expiresAt = r.expiresAt
    else if (r.status === LEASE_GONE) leases.delete(held)
  }
}

async function releaseLease({ apiBase, token, leaseId }, { fetch = globalThis.fetch } = {}) {
  await post(apiBase, '/api/release', token, { lease_id: leaseId }, fetch)
}

// 远端优先;失败回落本地缓存(lease=null,表示无需续租);都没有返回 null。
async function resolveRemoteAccount(userDataDir, { fetch = globalThis.fetch, fs = fsDefault } = {}) {
  const cfg = readServerConfig(userDataDir, { fs })
  if (!cfg) return null
  const leased = await requestLease(cfg, { fetch })
  // A 200 is not the same as a usable account: a half-deployed Worker, or an
  // apiBase typo'd onto some unrelated JSON endpoint, answers 200 with a body
  // that has no credentials in it. Treated as "no lease" — it must not reach
  // the caller, and above all it must not overwrite a good cached account with
  // {} and destroy the offline fallback for the next launch too.
  if (leased && leased.email && leased.password) {
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
  requestLease, renewLease, renewTrackedLeases, releaseLease, resolveRemoteAccount,
  LEASE_RENEWED, LEASE_GONE, LEASE_RETRY,
}
