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
