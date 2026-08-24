const fsDefault = require('node:fs')
const osDefault = require('node:os')
const path = require('node:path')

function serverConfigFile(userDataDir) { return path.join(userDataDir, 'server-config.json') }
function cachedAccountFile(userDataDir) { return path.join(userDataDir, 'cached-account.json') }
function clientTokenFile(userDataDir) { return path.join(userDataDir, 'client-token.json') }
// 打包后落在 app.asar 根目录(src/ 的上一级),开发态就是仓库根。里面是服务器地址
// 和邀请码,由打包流程生成,不进仓库 —— 仓库是公开的。
function bundledConfigFile() { return path.join(__dirname, '..', 'client-config.json') }

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

function readBundledConfig({ fs = fsDefault, file = bundledConfigFile() } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 与 readServerConfig 同样规范尾部斜杠,理由见那里。
    const apiBase = String(c.apiBase || '').replace(/\/+$/, '')
    if (!apiBase || !c.registerCode) return null
    return { apiBase, registerCode: c.registerCode }
  } catch { return null }
}

// 返回 { token, apiBase } —— apiBase 是签发这个 token 的服务器。老版本写下的文件
// 里没有这一项,那时归属未知,apiBase 为 null。
function readClientToken(userDataDir, { fs = fsDefault } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(clientTokenFile(userDataDir), 'utf8'))
    if (typeof c.token !== 'string' || !c.token) return null
    return { token: c.token, apiBase: typeof c.apiBase === 'string' && c.apiBase ? c.apiBase : null }
  } catch { return null }
}

function writeClientToken(userDataDir, token, { fs = fsDefault, apiBase = null } = {}) {
  // 0600:这是这台机器的通行证,同机别的用户不该读得到。理由同 writeCachedAccount,
  // mode 只在创建时生效,所以照样补一次 chmod。
  const file = clientTokenFile(userDataDir)
  try { fs.writeFileSync(file, JSON.stringify({ token, apiBase }), { mode: 0o600 }) }
  catch (e) {
    // 存不下来不该让这次启动失败 —— 本次照常用,只是下次会重新注册一个。
    console.error('[account-source] token write failed:', e.message)
    return false
  }
  try { fs.chmodSync(file, 0o600) } catch {}
  return true
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

async function registerClient({ apiBase, registerCode, device }, { fetch = globalThis.fetch } = {}) {
  // 这是唯一不需要 bearer 的请求。post() 仍会带一个空的 Authorization 头,服务端
  // 在这条路由上不看它 —— 为一个请求另写一套发送逻辑不值得。
  const r = await post(apiBase, '/api/register', '', { code: registerCode, device }, fetch)
  return r.ok && r.body && typeof r.body.token === 'string' && r.body.token ? r.body.token : null
}

// 解出这台机器该用的 { apiBase, token }。三条来源,优先级从高到低:
//   1. 手写的 server-config.json —— 排障和指向另一套部署的逃生口
//   2. 已经注册过、存在本地的 token
//   3. 用内置邀请码现场注册一个
async function resolveConfig(userDataDir, opts = {}) {
  const { fs = fsDefault, fetch = globalThis.fetch, os = osDefault, bundledFile = bundledConfigFile() } = opts
  const manual = readServerConfig(userDataDir, { fs })
  if (manual) {
    console.log('[account-source] 用 server-config.json 里指定的服务器')
    return manual
  }

  const bundled = readBundledConfig({ fs, file: bundledFile })
  if (!bundled) {
    console.error('[account-source] 没有可用的内置配置(client-config.json 缺失或不完整),不会自动登录')
    return null
  }

  // token 只对签发它的那台服务器有意义。服务器地址变了还拿着旧 token 去,会一路
  // 401 —— 而客户端被 401 拒绝时绝不重新注册(否则后台停用就形同虚设),于是永久
  // 卡死。所以判据是"这个 token 是不是这台服务器发的"这个纯本地事实,与网络无关,
  // 更不是"被拒绝了就重来"。
  //
  // 老版本写下的文件没有 apiBase,一律当成"属于当前服务器"。反过来当成未知、
  // 进而重新注册的话,等于给被停用的机器开了一条复活路径:升级一次就能领到新
  // token,把后台的停用绕过去。宁可老装机在换服务器时需要一次人工处理,也不能
  // 让吊销出现这种缺口 —— 换服务器时正确的做法是把 clients 表一起迁过去。
  const existing = readClientToken(userDataDir, { fs })
  if (existing && (existing.apiBase === null || existing.apiBase === bundled.apiBase)) {
    console.log('[account-source] 复用本机已有的 client-token.json')
    return { apiBase: bundled.apiBase, token: existing.token }
  }
  if (existing) {
    console.log('[account-source] 已有 token 是给 ' + (existing.apiBase || '(未知服务器)') +
      ' 签发的,当前服务器是 ' + bundled.apiBase + ',重新注册')
  }

  // 只有在本地压根没有 token 时才走到这里。租号被 401 拒绝时绝不能触发注册 ——
  // 否则在后台停用一台机器,它下次启动自己再领一个新 token,吊销就形同虚设。
  let device = 'unknown'
  try { device = String(os.hostname() || 'unknown') } catch {}
  console.log('[account-source] 本机还没有 token,向 ' + bundled.apiBase + ' 注册,device=' + device)
  const token = await registerClient({ ...bundled, device }, { fetch })
  if (!token) {
    console.error('[account-source] 注册没成功,这次不会自动登录')
    return null
  }
  console.log('[account-source] 注册成功,token 已写入本机')
  writeClientToken(userDataDir, token, { fs, apiBase: bundled.apiBase })
  return { apiBase: bundled.apiBase, token }
}

// 日志上报的目标。刻意与 resolveConfig 分开而不是复用它:resolveConfig 在没有 token
// 时会注册一个新客户端,而"上报一次日志"绝不该产生这种副作用 —— 否则在后台停用一台
// 机器,它下次开机光是上报日志就又冒出一个新 client,吊销变成打地鼠。这里只读。
function logTarget(userDataDir, opts = {}) {
  const { fs = fsDefault, os = osDefault, bundledFile = bundledConfigFile() } = opts
  const manual = readServerConfig(userDataDir, { fs })
  const bundled = readBundledConfig({ fs, file: bundledFile })
  const apiBase = (manual && manual.apiBase) || (bundled && bundled.apiBase)
  if (!apiBase) return null
  const stored = readClientToken(userDataDir, { fs })
  const token = (manual && manual.token) || (stored && stored.token)
  const registerCode = bundled ? bundled.registerCode : null
  // 两样都没有就没法过服务端那道认证,发出去只会白挨一个 401。
  if (!token && !registerCode) return null
  let device = 'unknown'
  try { device = String(os.hostname() || 'unknown') } catch {}
  return { apiBase, token: token || null, registerCode: registerCode || null, device }
}

// token 和邀请码一起发。客户端被停用之后 token 验不过,服务端会退回匿名路径收下 ——
// 一台机器刚被停用时的日志恰恰是最该看到的,不该因为吊销而失明。
async function sendLogs(target, lines, { fetch = globalThis.fetch } = {}) {
  if (!target || !target.apiBase || !lines || !lines.length) return false
  const r = await post(target.apiBase, '/api/logs', target.token || '', {
    code: target.registerCode || undefined,
    device: target.device,
    lines,
  }, fetch)
  return r.ok
}

// 远端优先;失败回落本地缓存(lease=null,表示无需续租);都没有返回 null。
async function resolveRemoteAccount(userDataDir, opts = {}) {
  const { fetch = globalThis.fetch, fs = fsDefault } = opts
  const cfg = await resolveConfig(userDataDir, opts)
  if (!cfg) {
    console.error('[account-source] 没有服务器配置,跳过远端取号')
    return null
  }
  const leased = await requestLease(cfg, { fetch })
  // A 200 is not the same as a usable account: a half-deployed Worker, or an
  // apiBase typo'd onto some unrelated JSON endpoint, answers 200 with a body
  // that has no credentials in it. Treated as "no lease" — it must not reach
  // the caller, and above all it must not overwrite a good cached account with
  // {} and destroy the offline fallback for the next launch too.
  if (leased && leased.email && leased.password) {
    // 只记 lease_id。这些日志会离开本机、显示在后台网页上,账号和密码绝不能进去 ——
    // 后台自己能把 lease_id 对应到账号,不需要客户端替它说。
    console.log('[account-source] 取号成功 lease_id=' + leased.lease_id)
    writeCachedAccount(userDataDir, { email: leased.email, password: leased.password }, { fs })
    return {
      email: leased.email,
      password: leased.password,
      lease: { apiBase: cfg.apiBase, token: cfg.token, leaseId: leased.lease_id, expiresAt: leased.expires_at },
    }
  }
  const cached = readCachedAccount(userDataDir, { fs })
  if (cached) {
    console.warn('[account-source] 远端取号没成功,回落到本机缓存的账号')
    return { email: cached.email, password: cached.password, lease: null }
  }
  console.error('[account-source] 远端和本机缓存都没有可用账号')
  return null
}

module.exports = {
  serverConfigFile, cachedAccountFile, clientTokenFile, bundledConfigFile,
  readServerConfig, readCachedAccount, writeCachedAccount,
  readBundledConfig, readClientToken, writeClientToken, registerClient, resolveConfig,
  logTarget, sendLogs,
  requestLease, renewLease, renewTrackedLeases, releaseLease, resolveRemoteAccount,
  LEASE_RENEWED, LEASE_GONE, LEASE_RETRY,
}
