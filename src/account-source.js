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
