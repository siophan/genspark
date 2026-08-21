import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/index.js'

// 入口点的冒烟测试:两组路由(api / admin)确实都挂上去了,而且挂在一起没互相
// 打架。api.js 和 admin.js 各自的行为由它们自己的测试覆盖,这里只验组装。
// Hono 的 app.request() 不需要 workerd,所以这层一直是能测的 —— 而在此之前,
// 加上 admin cookie 的 secure: true 让本地 wrangler dev 不好使,整条 admin
// 路径其实从没有被端到端跑过一次。
const env = {
  DB: {},
  ACCOUNT_ENC_KEY: Buffer.alloc(32).toString('base64'),
  ADMIN_PASSWORD_HASH: 'f'.repeat(64),
}

test('the Worker entry point composes both route groups', async () => {
  const lease = await app.request('/api/lease', { method: 'POST' }, env)
  assert.equal(lease.status, 401)                        // api 中间件已生效

  const admin = await app.request('/admin', { method: 'GET' }, env)
  assert.equal(admin.status, 302)                        // admin 认证中间件已生效
  assert.equal(admin.headers.get('location'), '/admin/login')

  const login = await app.request('/admin/login', { method: 'GET' }, env)
  assert.equal(login.status, 200)                        // 登录页被显式放行
  assert.match(await login.text(), /<form method=post action=\/admin\/login>/)
})
