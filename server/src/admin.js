import { makeDb as realMakeDb } from './db.js'
import { hashToken, generateToken } from './tokens.js'
import { encryptPassword } from './crypto.js'
import { getSignedCookie, setSignedCookie } from 'hono/cookie'

const COOKIE = 'admin'

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function page(title, body) {
  return `<!doctype html><meta charset=utf-8><title>${esc(title)}</title>` +
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

  const authMw = async (c, next) => {
    if (!(await isAuthed(c))) return c.redirect('/admin/login', 302)
    await next()
  }
  // '/admin' 只精确匹配 /admin 本身;'/admin/*' 覆盖其下所有子路径(含 /admin/login,
  // 因此显式放行登录页,其余一律要求认证)。三条易错的路径拼图(accounts/*、clients*)
  // 已被这两条覆盖式规则取代——clients* 在 Hono 下会被当成静态字面量,匹配不到任何真实
  // 路径,曾导致 /admin/clients* 下所有写路由对匿名请求完全开放。
  app.use('/admin', authMw)
  app.use('/admin/*', async (c, next) => {
    if (c.req.path === '/admin/login') return next()
    return authMw(c, next)
  })

  app.get('/admin', async (c) => {
    const db = makeDb(c.env.DB)
    const accounts = await db.listAccounts()
    const clients = await db.listClients()
    const arows = accounts.map((a) =>
      `<tr><td>${a.id}</td><td>${esc(a.email)}</td><td>${a.enabled ? '✓' : '✗'}</td>` +
      `<td>${esc(a.leased_by || '')}</td><td>` +
      `<form class=inline method=post action=/admin/accounts/${a.id}/toggle><button>开关</button></form> ` +
      `<form class=inline method=post action=/admin/accounts/${a.id}/delete><button>删</button></form></td></tr>`).join('')
    const crows = clients.map((cl) =>
      `<tr><td>${cl.id}</td><td>${esc(cl.name)}</td><td>${cl.enabled ? '✓' : '✗'}</td><td>` +
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
    const name = String(f.name || '')
    const token = await generateToken()
    await db.createClient({ name, token_hash: await hashToken(token) })
    return c.html(page('新 token',
      `<p>客户端 <b>${esc(name)}</b> 的 token(只显示这一次,请复制):</p>` +
      `<pre>${esc(token)}</pre><a href=/admin>返回</a>`))
  })
  app.post('/admin/clients/:id/toggle', async (c) => {
    const db = makeDb(c.env.DB)
    const list = await db.listClients()
    const cl = list.find((x) => x.id === Number(c.req.param('id')))
    if (cl) await db.setClientEnabled(cl.id, !cl.enabled)
    return c.redirect('/admin', 302)
  })
}
