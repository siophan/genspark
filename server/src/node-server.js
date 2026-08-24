// 自建部署的入口。业务代码一行不改:路由、db.js、crypto.js 全部照搬,
// 差别只在两处 —— D1 换成本机 SQLite,env 从 process.env 组装而不是由运行时注入。
import { serve } from '@hono/node-server'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import app from './index.js'
import { openDatabase } from './sqlite-d1.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaFile = path.join(here, '..', 'schema.sql')

// 缺了就直接不启动,而不是"先跑起来再说":没有 ACCOUNT_ENC_KEY,新加的账号密码
// 会被写成日后无法解密的垃圾;没有 ADMIN_PASSWORD_HASH,后台的签名 cookie 无从校验。
// 两种都是那种"当时看起来正常、事后才发现数据废了"的故障,值得用启动失败换掉。
function required(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`[server] 缺少环境变量 ${name},拒绝启动 —— 带着它跑只会产生日后修不回来的数据。`)
    process.exit(1)
  }
  return v
}

const dbFile = process.env.DB_FILE || path.join(here, '..', 'data', 'accounts.db')
mkdirSync(path.dirname(dbFile), { recursive: true })
const { db } = openDatabase(dbFile, schemaFile)

const env = {
  DB: db,
  ACCOUNT_ENC_KEY: required('ACCOUNT_ENC_KEY'),
  ADMIN_PASSWORD_HASH: required('ADMIN_PASSWORD_HASH'),
  // 不设 = 关闭自助注册,这是 api.js 里明确支持的一种状态(杀手开关),所以只警告。
  REGISTER_CODE: process.env.REGISTER_CODE,
  LEASE_TTL_MS: process.env.LEASE_TTL_MS || '1800000',
}
if (!env.REGISTER_CODE) console.warn('[server] 没有 REGISTER_CODE,自助注册处于关闭状态')

const port = Number(process.env.PORT || 8787)
// 只听回环:对外由 nginx 终止 TLS 再反代过来。直接对公网监听等于把一个
// 明文 HTTP 服务暴露出去,而后台登录的密码就走在这条连接上。
const hostname = process.env.HOST || '127.0.0.1'

serve({ fetch: (req) => app.fetch(req, env), port, hostname }, (info) => {
  console.log(`[server] 账号服务已启动 http://${hostname}:${info.port}  库文件 ${dbFile}`)
})
