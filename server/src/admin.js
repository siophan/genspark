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

// 时间戳只用于展示。null 说明这个客户端从来没来过 —— 自助注册后还没被批准的样子。
function stamp(ms) {
  if (!ms) return '从未'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

// 客户端名字可以为空,所以标签永远带上 id —— 后台要能一眼分清是哪台机器。
function clientLabel(id, name) {
  const n = String(name ?? '').trim()
  if (id == null) return n
  return n ? `#${id} ${n}` : `#${id}`
}

// 账号那一列:租出去了就写"谁 + 到期时间",没租出去留空。
function holderCell(a) {
  if (a.leased_by_id == null && !a.leased_by) return ''
  const who = esc(clientLabel(a.leased_by_id, a.leased_by))
  return a.lease_expires_at ? `${who}<br><small>到期 ${esc(stamp(a.lease_expires_at))}</small>` : who
}

// 客户端那一列:仍持有就写账号 + 到期,已归还/已过期就写"曾用",从来没租过写 —。
// 账号被删掉时 email 是 null,退回 #id,免得整格空掉。
function heldAccountCell(cl, now) {
  if (cl.last_account_id == null) return '—'
  const label = esc(cl.last_account_email || `#${cl.last_account_id}`)
  const held = !cl.last_released_at && Number(cl.last_expires_at) > now
  return held
    ? `${label}<br><small>到期 ${esc(stamp(cl.last_expires_at))}</small>`
    : `<small>曾用 ${label}</small>`
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
    const now = Date.now()
    const arows = accounts.map((a) =>
      `<tr><td>${a.id}</td><td>${esc(a.email)}</td><td>${a.enabled ? '✓' : '✗'}</td>` +
      `<td>${holderCell(a)}</td><td>` +
      `<form class=inline method=post action=/admin/accounts/${a.id}/toggle><button>开关</button></form> ` +
      `<form class=inline method=post action=/admin/accounts/${a.id}/delete><button>删</button></form></td></tr>`).join('')
    const crows = clients.map((cl) =>
      `<tr><td>${cl.id}</td><td>${esc(cl.name)}</td>` +
      `<td>${cl.enabled ? '✓' : '✗ 已停用'}</td>` +
      `<td>${heldAccountCell(cl, now)}</td>` +
      `<td>${esc(stamp(cl.last_seen_at))}</td><td>` +
      `<form class=inline method=post action=/admin/clients/${cl.id}/toggle><button>开关</button></form></td></tr>`).join('')
    return c.html(page('后台',
      '<h1>账号</h1>' +
      '<form method=post action=/admin/accounts><input name=email placeholder=email>' +
      '<input name=password placeholder=密码><input name=note placeholder=备注><button>新增</button></form>' +
      `<table><tr><th>id<th>email<th>启用<th>租给<th>操作</tr>${arows}</table>` +
      '<h1>客户端</h1>' +
      '<form method=post action=/admin/clients><input name=name placeholder=名称><button>生成 token</button></form>' +
      `<table><tr><th>id<th>名称<th>状态<th>账号<th>最后活动<th>操作</tr>${crows}</table>`))
  })

  app.post('/admin/accounts', async (c) => {
    const db = makeDb(c.env.DB)
    const f = await c.req.parseBody()
    const email = String(f.email ?? '').trim()
    const password = String(f.password ?? '')
    // email 为空的账号仍然是完全合法的出租候选:客户端租到它、发现 email 是空的、
    // 把它丢掉 —— 白烧一个 30 分钟的租约,而且每次启动都会再烧一个。后台上一次
    // 手滑点到"新增"就够了,所以挡在入口。
    if (!email || !password.trim()) {
      return c.html(page('新增失败',
        '<p>email 和密码都不能为空。</p><a href=/admin>返回</a>'), 400)
    }
    const enc = await encryptPassword(password, c.env.ACCOUNT_ENC_KEY)
    await db.createAccount({ email, password_enc: enc, note: f.note ? String(f.note) : null })
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
    const db = makeDb(c.env.DB)
    const id = Number(c.req.param('id'))
    const a = (await db.listAccounts()).find((x) => x.id === id)
    // 已经不在了就当删过了,别拿"删不掉"糊操作员一脸。
    if (!a) return c.redirect('/admin', 302)
    // 先读一眼是想在常见情况下早退,不白清一遍历史租约;真正把关的是 deleteAccount 里
    // 那条条件 DELETE —— 只有它防得住"读完到删之间刚好被人租走"。
    if (a.leased_by_id == null && (await db.deleteAccount(id))) return c.redirect('/admin', 302)
    const who = clientLabel(a.leased_by_id, a.leased_by) || '另一个客户端'
    return c.html(page('删不掉',
      `<p>账号 <b>${esc(a.email)}</b> 正被 <b>${esc(who)}</b> 持有。删掉它,那个客户端` +
      '会抱着一份后台已经不存在的凭据继续跑。</p>' +
      '<p>先点"开关"停用它 —— 停用之后不会再被租出去,等这一轮租约归还或到期' +
      '(最长 30 分钟)再删。</p><a href=/admin>返回</a>'), 409)
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
