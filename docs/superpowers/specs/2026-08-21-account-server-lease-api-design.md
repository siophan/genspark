# 账号服务端(租约分配 API + 管理后台)设计 — Cloudflare 版

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
- 托管:**Cloudflare Workers + D1**(serverless,免运维、自动 HTTPS、这点量基本免费)。
- 分配模式:**服务端租约分配**(不是下发整个池子)。
- 代码位置:同仓库新增 `server/` 目录。
- 默认用户地区:国内(Cloudflare 无国内节点,但本方案为低频调用且有离线兜底,影响很小)。

## 为什么 Cloudflare(相对自建 VPS)

- 无服务器运维:不用管机器、systemd、更新、监控。
- HTTPS / 证书自动,不用 nginx + certbot。
- D1 就是托管版 SQLite,SQL 基本一致,自带备份。
- 免费额度对本量级绰绰有余;有免费 `*.workers.dev` 域名,也可绑自有域名。

代价(已接受):
- 代码按 Workers 运行时写(见下:Hono 代替 Fastify、D1 binding 代替 better-sqlite3)。
- 原子租约不能用交互式事务,改为一条**条件 UPDATE**(见"租约语义")。
- 国内访问 Cloudflare 稳定性偶尔飘;因是低频调用且有兜底链,影响可接受。

## YAGNI(明确不做)

- 多管理员 / 角色权限(单管理员密码即可)。
- 用量图表 / 报表。
- 账号自动注册。
- 客户端自动更新。

需要时再加,不在本期。

## 架构 / 目录

同仓库新增 `server/`,一个 Cloudflare Workers 项目(用 wrangler 管理):

```
server/
  src/
    index.js      # Worker 入口:Hono app,挂 /api 与 /admin
    lease.js      # 租约核心逻辑(尽量纯函数,便于单测)
    crypto.js     # 账号密码加密 / 解密(Web Crypto,AES-GCM)
    tokens.js     # 客户端 token 生成 / 校验(库里只存 hash)
    api.js        # 路由:/api/lease /renew /release
    admin.js      # 管理页路由 + 管理员登录
    db.js         # D1 查询封装(prepared statements)
  test/           # node:test;涉及 D1 的用 node:sqlite + 一层薄 D1 shim
  schema.sql      # 建表语句(wrangler d1 migrations 用)
  wrangler.toml   # Worker 配置 + D1 binding + secrets 声明
  package.json    # 服务端独立依赖(hono、wrangler)
```

- 运行时:Cloudflare Workers + Hono(轻量路由)+ D1(SQLite)。
- 加密:Web Crypto(Workers 与 Node 均内置),不引第三方加密库。
- 服务端 `package.json` 独立于客户端,不与 Electron 依赖混用。

## 数据模型(D1 / SQLite)

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

密码字段存**加密后**的密文,密钥来自 Worker secret(不进库、不进 git)。

## 加密

- 对称加密账号密码:AES-256-GCM,通过 Web Crypto(`crypto.subtle`)实现。
- 密钥来自 Worker secret `ACCOUNT_ENC_KEY`(32 字节,base64)。
- 存储格式:`iv:ciphertext`(GCM 的 authTag 附在密文尾部,各段 base64,冒号分隔)。
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
- **原子分配(D1 版)**:D1 不支持交互式事务(先 SELECT 再 UPDATE 加锁),因此改为
  **一条带条件的写语句**保证不撞号——先算出候选 `account_id`,再执行
  `INSERT INTO leases (...) SELECT ... WHERE NOT EXISTS (该账号仍有有效租约)`
  或等价的条件写,并用 `RETURNING` 拿回结果;若受影响行数为 0 说明被并发抢走,
  重试挑下一个候选(有限次)。这样即使两个请求同时进来也不会给同一个号发出两条有效租约。
- **粘性(sticky)**:分配时优先尝试该 client 上次用过的账号(若当前可用),让客户端本地
  session 分区保持热态、减少重登;该号被抢或不可用时再从其余可用账号里挑。
- 选中后更新 `accounts.last_used_at`。

## 客户端改动

改账号来源,新增 `src/account-source.js`,尽量不动现有 auto-login / partition 逻辑。

- **配置**:userData 下 `server-config.json`,含 `{ apiBase, token }`。缺失或字段
  为空时视为"未配置",走离线兜底。
  > 本节写于最初版本,当时的结论是"绝不硬编码进包(dmg/exe 会被反编译)"。后来
  > 为了能把安装包直接发给别人,改成了包内带 `apiBase` + 邀请码、客户端自助领
  > token —— 反编译能挖出邀请码这一点仍然成立,只是防线换成了"自助注册出来的
  > 客户端默认停用"。见《客户端自助注册》一节,那里是当前的实现。
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

- 路由 `/admin/*`,单管理员登录:密码存 hash(Worker secret `ADMIN_PASSWORD_HASH`),
  会话用签名 cookie。
- 页面功能:
  - 账号:列表(含 enabled 开关、last_used、当前租给哪个 client)、新增、编辑、删除。
  - 客户端:生成新 token(**只在生成时明文显示一次**,库里存 hash)、停用/启用、看
    last_seen。
- 极简实现:Worker 直接返回服务端渲染的 HTML + 少量原生 JS,不引前端框架。

## 测试策略(TDD)

纯逻辑单测(node:test,不碰 D1):
- `lease.js`:候选选择(enabled + 无有效租约)、粘性优先、无可用返回、条件写落空后的
  重试选下一个候选;把 DB 访问抽象成可注入接口来纯测。
- `crypto.js`:加密后能解密回原文;密文格式;错误密钥/密文的处理(Web Crypto 在 Node
  下同样可用)。
- `tokens.js`:生成 token、`sha256` 校验命中/不命中、停用 client 被拒。
- 客户端 `account-source.js`:配置读取兜底、lease 成功映射到老结构、失败回落链
  (缓存 → 桌面文件 → null)。用可注入的 fetch/fs 做纯测试。

集成测试(少量):Hono 的 `app.request()` 直接打真实的 `index.js`,不需要 workerd;
涉及 D1 的用 Node 内置 `node:sqlite` 加一层薄 shim(D1 底层就是 SQLite)。覆盖
lease → renew → release → 再 lease 全流程;并发两次 lease 不撞号(验证条件写)。

原计划用 miniflare,但它依赖的 workerd 原生二进制从镜像装下来没有代码签名,
Apple Silicon 会直接 SIGKILL,所以改成上面这套零额外依赖的方案。`db.js`、
`schema.sql`、`wrangler.toml` 都是生产用的真 D1 产物,没有为了可测性改过。

## 部署(Cloudflare)

> **先看这条,否则下面每一步都可能卡住。** 如果任何 wrangler 命令报
> `TypeError: fetch failed`,而 `curl https://api.cloudflare.com/client/v4/user`
> 明明是通的,那不是网络断了,也不是没登录。原因是 Node 的 happy-eyeballs 默认
> 只给每个候选地址 250ms 完成 TCP 握手,而国内到 Cloudflare 的握手常在 400ms
> 以上 —— 每个地址都被判超时,最后聚合成 `ETIMEDOUT`。curl 没有这个限制,所以
> **"curl 通、wrangler 不通"就是这个问题的指纹**。给下面每一条 wrangler 命令
> 加上前缀即可:
>
> ```
> NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000 npx wrangler ...
> ```
>
> 嫌长就 `export` 一次,当前终端里后续所有命令都生效。

1. `cd server && npm ci`(装 wrangler、hono)。
2. `npx wrangler login`(一次性授权)。
3. 建 D1:`npx wrangler d1 create genspark-accounts`,把返回的 database_id 写进
   `wrangler.toml` 的 D1 binding。
4. 建表:`npx wrangler d1 execute genspark-accounts --remote --file schema.sql`。
   两个细节都会决定成败:第 1 步已经 `cd server`,所以路径是 `schema.sql` 而不是
   `server/schema.sql`;`--remote` 也不能省 —— wrangler v3 的 `d1 execute` 默认打
   在**本地模拟库**上,漏掉它表就只建在本地,线上 Worker 每个 API 调用都 500,而
   客户端会静默回落到缓存/桌面文件,表现成"配置好了但从来没生效"。
5. 塞 secrets:`npx wrangler secret put ACCOUNT_ENC_KEY`、`npx wrangler secret put ADMIN_PASSWORD_HASH`。
   两个值都要自己先生成好,命令只是把它贴进去:

   - `ACCOUNT_ENC_KEY`:32 字节随机数的 base64(AES-256-GCM 的密钥)。
     `openssl rand -base64 32`
   - `ADMIN_PASSWORD_HASH`:管理员密码的 sha256,小写十六进制 —— 与代码里的
     `hashToken` 完全一致。
     `printf '%s' 'YOUR_PASSWORD' | shasum -a 256 | cut -d' ' -f1`

   管理员密码请用一长串随机字符串。`ADMIN_PASSWORD_HASH` 是无盐、单轮的 sha256,
   而且它同时被当作后台 cookie 的签名密钥 —— 一个能被猜到或被跑字典的弱密码,
   等于把后台和 cookie 一起交出去。
6. 部署:`npx wrangler deploy`。得到 `https://<name>.<account>.workers.dev`(或绑自有域名)。
7. 首次:管理页登录 → 录入账号 → 生成客户端 token → 填进各客户端的
   `server-config.json`(`apiBase` 指向 Worker 域名)。

   `apiBase` **必须**是 `https://`。代码不做强制,而 `http://` 会让客户端 token
   和账号密码以明文走线路。尾部斜杠写不写都行(客户端会规范掉)。

## 客户端自助注册(零配置分发)

要把安装包直接发给别人用,原来那套"每人手工在 userData 里造一个
`server-config.json`"是不可接受的:路径写错、JSON 少个逗号、token 粘串行,
全都不报错,应用照常打开、只是永远不走 API。配错的表现和"没配"完全一样。

改成客户端自助领取:

1. 打包时把 `client-config.json`(`apiBase` + `registerCode`)放进包根目录
   (`build.files` 里声明,`.gitignore` 掉真实文件,仓库里只有 `.example`)。
2. 首次启动、本地没有 token 时,客户端 `POST /api/register`,带上邀请码和
   `os.hostname()`。服务端建一条 client,**`enabled = 0`**,返回一个 token。
3. 客户端把 token 存进 `userData/client-token.json`(0600),之后每次启动直接用。
4. 新注册的客户端**当场可用**,不需要批准。管理员事后在后台看到它,可以随时停用。

`{ apiBase, token }` 的解析优先级:手写的 `server-config.json` > 已存的
`client-token.json` > 现场注册。第一条是排障和指向另一套部署的逃生口。

### 两条不能动的规则

**租号被 401 拒绝时绝不重新注册。** 客户端只在本地压根没有 token 时才注册。
否则在后台停用一台机器,它下次启动自己再领一个新 token,吊销就形同虚设。

**停用必须立刻生效。** `verifyClient` 要求 `enabled = 1`,所以在后台点一下停用,
那台机器下一个请求就被拒。配合上一条(401 不重新注册),这是唯一有效的管控手段,
两条缺一不可。

### 取舍:没有准入,只有事后停用

仓库是公开的,CI 每次 push 到 main 都把安装包发成 GitHub Release。任何人都能
下载、解开 `app.asar`、读到邀请码。而自助注册出来的客户端**默认启用**
(`db.createClient` 的 `enabled` 默认 1,注册路径不覆盖它)。

两件事叠加的结果就是:**拿到安装包的人可以直接从账号池里租号,没有任何门。**
这是明确选择的,不是疏漏 —— 换来的是"发给别人,他装上打开就能用",中间不需要
任何人做任何操作。

管控全部是事后的:

- 在后台把某个 client 停用,它下一个请求即被拒。
- 被陌生人刷了,删掉 Cloudflare 上的 `REGISTER_CODE`,自助注册立刻整体关闭,
  已注册的客户端不受影响。

要恢复准入,只需在 `api.js` 的注册路径上传 `enabled: 0`(db 层已经支持),再把
后台的"待批准"状态加回去。要更强的隔离,则需要把仓库转私有,让 Release 不再
公开可下。

### happy-eyeballs:客户端也踩同一个坑

`src/main.js` 开头那行 `nodeNet.setDefaultAutoSelectFamilyAttemptTimeout(5000)`
不是调优,是功能能否工作的前提。Electron 主进程的 `fetch` 就是 Node 的 undici,
而 Node 默认只给每个候选地址 250ms 完成 TCP 握手;国内到 Cloudflare 实测 451ms,
于是每个地址都超时,聚合成一个信息量为零的 `fetch failed`。客户端把它读作
"服务器不可用",静默回落到桌面账号池 —— 功能看着装好了,却从来没生效过。
这一行必须在任何请求发出之前执行。(同一个坑在部署章节里以 `NODE_OPTIONS`
的形式打过一次,那是 wrangler CLI 侧。)

## 兼容 / 回滚

- 桌面文件逻辑完整保留,作为离线兜底;把 `server-config.json` 删掉即退回纯本地模式。
- 服务端与客户端解耦:Worker 挂了,客户端用缓存/桌面文件继续可用。
