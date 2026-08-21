# 账号服务端(租约分配 API + 管理后台)设计

日期:2026-08-21
状态:已批准,待写实现计划

## 背景

客户端("老猫" Electron 壳)现在从桌面文件 `~/Desktop/genspark-accounts.json`
读取账号池,本地随机挑一个自动登录(见 [src/accounts.js](../../../src/accounts.js)、
[src/main.js](../../../src/main.js) 的 `chooseAccount()`)。

问题:
- 每台机器都持有**全部**账号明文密码,暴露面大。
- 无法阻止两个客户端同时用同一个账号——而每账号绑定一个持久 session 分区,
  撞号会让两台机器的 genspark session 互相打架。
- 停用某账号、看谁在用、统计使用,都做不到。

目标:把账号集中到自建后台维护,客户端启动时通过 API **租**一个账号自动登录。

## 决策(已确认)

- 使用规模:小团队(几人~几十人)。
- 托管:自己的香港 VPS(免 ICP 备案,对国内延迟友好)。
- 分配模式:**服务端租约分配**(不是下发整个池子)。
- 代码位置:同仓库新增 `server/` 目录。
- 默认用户地区:国内(部署章节按香港节点写,后续可调)。

## YAGNI(明确不做)

- 多管理员 / 角色权限(单管理员密码即可)。
- 用量图表 / 报表。
- 账号自动注册。
- 客户端自动更新。

需要时再加,不在本期。

## 架构 / 目录

同仓库新增 `server/`,和客户端一起版本管理:

```
server/
  src/
    db.js         # better-sqlite3 建表 + 查询封装
    lease.js      # 租约核心逻辑(尽量纯函数,便于单测)
    crypto.js     # 账号密码加密 / 解密
    tokens.js     # 客户端 token 生成 / 校验(库里只存 hash)
    api.js        # Fastify 路由:/api/lease /renew /release
    admin.js      # 管理页路由 + 管理员登录
    server.js     # 组装 + 启动
  test/           # node:test,与客户端同风格
  migrations.sql  # 建表语句
  package.json    # 服务端独立依赖(Fastify、better-sqlite3)
```

- 运行时:Node + Fastify + better-sqlite3(单文件 DB,几十人量级足够)。
- 部署:香港 VPS,nginx 反代 + Let's Encrypt(certbot)出 HTTPS,systemd 守护。
- 服务端 `package.json` 独立于客户端,避免把服务端依赖打进 Electron 包。

## 数据模型

```sql
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_enc  TEXT NOT NULL,           -- 加密后的密文
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  last_used_at  INTEGER                  -- epoch ms
);

CREATE TABLE clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,    -- sha256(token)
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER
);

CREATE TABLE leases (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  expires_at    INTEGER NOT NULL,        -- epoch ms
  released_at   INTEGER                  -- NULL = 仍有效
);
```

一个账号"有有效租约" = 存在一条 `released_at IS NULL AND expires_at > now` 的 lease。

密码字段存**加密后**的密文,密钥来自服务端环境变量(不进库、不进 git)。

## 加密

- 对称加密账号密码:AES-256-GCM,密钥来自环境变量 `ACCOUNT_ENC_KEY`(32 字节,
  base64 或 hex)。
- 存储格式:`iv:authTag:ciphertext`(各段 base64,冒号分隔),便于解密时切分。
- 管理页默认对密码打码,仅在明确"查看/编辑"时解密回显。

## API 契约

所有 `/api/*` 需 `Authorization: Bearer <client-token>`,走 HTTPS。
token 校验:`sha256(token)` 命中 `clients.token_hash` 且 `enabled=1`,并更新
`last_seen_at`。

### POST /api/lease

请求体:空(客户端身份由 token 决定)。

成功 `200`:
```json
{ "email": "a@b.com", "password": "明文", "lease_id": 123, "expires_at": 1690000000000 }
```

- 分配算法(见"租约语义")。
- 无可用账号:`409 { "error": "no_account_available" }`。
- token 无效 / 被停用:`401`。

### POST /api/renew

请求体:`{ "lease_id": 123 }`。

- 该 lease 属于本 client、且仍有效(`released_at IS NULL AND expires_at > now`):
  延长 `expires_at`,返回 `200 { "expires_at": ... }`。
- 已过期 / 已释放 / 不属于本 client:`410 { "error": "lease_expired" }`
  (客户端收到后应重新 `lease`)。

### POST /api/release

请求体:`{ "lease_id": 123 }`。

- 幂等:把该 lease 的 `released_at` 置为 now(已释放则无操作)。
- 返回 `200 { "ok": true }`。

## 租约语义

- **TTL**:30 分钟(`LEASE_TTL_MS`,可配)。
- **续租间隔**:客户端每 10 分钟 `renew` 一次。
- **崩溃回收**:客户端异常退出不 release,租约到期后账号自动回到可用池。
- **原子分配**:选号 + 写租约在同一个 `BEGIN IMMEDIATE` 事务内完成,防止两个
  并发请求抢到同一个号。
- **粘性(sticky)**:分配时优先把该 client 上次用过的账号(若当前可用)再分给它,
  使客户端本地 session 分区保持热态、减少重登;该号不可用时再从其余可用账号里挑。
- 选中后更新 `accounts.last_used_at`。

## 客户端改动

改账号来源,新增 `src/account-source.js`,尽量不动现有 auto-login / partition 逻辑。

- **配置**:userData 下 `server-config.json`,含 `{ apiBase, token }`。不硬编码进包
  (dmg/exe 会被反编译)。缺失或字段为空时视为"未配置",走离线兜底。
- **`chooseAccount()` 改为 async**:
  1. 已配置 → `POST {apiBase}/api/lease`,拿 `{email, password, lease_id, expires_at}`。
  2. 成功 → 用现有 `partitionName(email)` + `buildLoginScript(email, password)` 拼成
     现有结构 `{ email, partition, loginScript }`,并把 `lease_id` 交给续租/释放逻辑;
     同时把 `{email, password}` 缓存到 userData(离线兜底用)。
  3. 服务端不可达 / 401 / 409 → 依次回落:本地缓存 → 现有桌面文件逻辑
     ([src/accounts.js](../../../src/accounts.js) 保留不删)→ 都没有则返回 null(窗口正常打开,不自动登录)。
- **启动流程**:[src/main.js](../../../src/main.js) 的 `whenReady` 改成 `await chooseAccount()`
  后再 `createWindow`(现在是同步)。`activate` 重开窗口同理。
- **续租 / 释放**:租到账号后启动一个 10 分钟定时器调 `renew`;`renew` 返回 410 时
  记录(下次启动重租,不打断当前会话);`app.on('before-quit')` 时 `release`(尽力,
  失败忽略,反正会过期)。

## 管理后台

- 路由 `/admin/*`,单管理员登录:密码存 hash(`ADMIN_PASSWORD_HASH` 环境变量或
  首次启动生成),会话用签名 cookie。
- 页面功能:
  - 账号:列表(含 enabled 开关、last_used、当前租给哪个 client)、新增、编辑、删除。
  - 客户端:生成新 token(**只在生成时明文显示一次**,库里存 hash)、停用/启用、看
    last_seen。
- 极简实现:服务端渲染 HTML + 少量原生 JS,不引前端框架。

## 测试策略(TDD,node:test)

纯逻辑单测:
- `lease.js`:可用账号筛选(enabled + 无有效租约)、过期回收、粘性优先、无可用返回。
- `crypto.js`:加密后能解密回原文;密文格式;错误密钥/密文的处理。
- `tokens.js`:生成 token、`sha256` 校验命中/不命中、停用 client 被拒。
- 客户端 `account-source.js`:配置读取兜底、lease 成功映射到老结构、失败回落链
  (缓存 → 桌面文件 → null)。用可注入的 fetch/fs 做纯测试。

集成测试(少量):Fastify 路由跑 lease → renew → release → 再 lease 全流程,用内存/临时
SQLite;并发两次 lease 不撞号。

## 部署(香港 VPS)

1. `git pull` 到 VPS。
2. `cd server && npm ci`。
3. 环境变量(systemd unit 的 `Environment=` 或 `.env`):`ACCOUNT_ENC_KEY`、
   `ADMIN_PASSWORD_HASH`、`PORT`、`DB_PATH`、可选 `LEASE_TTL_MS`。
4. `systemd` 起服务(自启 + 崩溃重启)。
5. nginx 反代到 `PORT`,`certbot` 签 Let's Encrypt 证书,强制 HTTPS。
6. 首次:管理页登录 → 录入账号 → 生成客户端 token → 填进各客户端的
   `server-config.json`。

## 兼容 / 回滚

- 桌面文件逻辑完整保留,作为离线兜底;把 `server-config.json` 删掉即退回纯本地模式。
- 服务端与客户端解耦:服务端挂了,客户端用缓存/桌面文件继续可用。
