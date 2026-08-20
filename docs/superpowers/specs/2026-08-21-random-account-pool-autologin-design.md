# 随机账号池 + 自动登录 设计

## 目标

App 每次打开时,从一个账号池中随机挑选一个账号,并自动完成登录。账号采用邮箱+密码方式(genspark 走 Azure B2C 表单登录)。

## 需求确认

- 登录方式:邮箱 + 密码(Azure B2C 表单)。
- 会话策略:**每个账号一个独立持久会话分区**。随机选中某账号后,若该分区已登录则免密直进,未登录才自动填密码登录。
- 账号池文件:放在**桌面** `~/Desktop/genspark-accounts.json`,用户手动编辑,明文密码(单机自用,可接受)。
- 文件不存在时:自动生成带示例的模板供用户修改。
- 随机规则:随机挑一个;可选"尽量不连续重复上一次账号"。

## 账号池文件

路径:`~/Desktop/genspark-accounts.json`

格式:

```json
{
  "avoidRepeatLast": true,
  "accounts": [
    { "email": "example1@mail.com", "password": "改成你的密码" },
    { "email": "example2@mail.com", "password": "改成你的密码" }
  ]
}
```

- 首次不存在时,写入上面这个模板(示例账号占位),不阻塞启动。
- 解析失败 / 空列表 / 全是示例账号:跳过自动登录,正常打开,控制台给出提示。
- `avoidRepeatLast: true` 且账号数 ≥ 2 时,尽量不选中上一次用过的账号。
- "上一次用的是谁"记录在用户数据目录(`.../Genspark/last-account.json`),不写回桌面文件。

## 会话分区 + 自动登录

- 稳定分区名:`persist:acct-<邮箱派生的稳定ID>`(如对 email 取 hash),保证同一账号每次同一分区、cookie 持久。
- 启动流程:
  1. 读桌面账号池 → 随机挑账号 → 用其分区创建 BrowserWindow(`webPreferences.partition`)。
  2. 通过与现有脚本注入相同的 IPC 通道,把该账号凭据只发给这个窗口。
  3. 注入一个**内置自动登录脚本**(项目内置,不放进用户可编辑的 scripts 目录):
     - 已登录 → 登录表单不出现 → 脚本不动作。
     - 未登录 → 监视页面,到 Azure B2C 表单时自动填邮箱+密码并提交;必要时先点"登录"入口进入表单。

## 待实现阶段确定的不确定点

- Azure B2C 登录页的输入框/按钮选择器,以及 genspark 落地页 → 登录表单的跳转步骤,需在实现时跑起 App 观察真实 DOM 后对准。
- 端到端真正登录由用户亲自运行验证;协助方不代为向线上页面提交真实密码。

## 模块划分(不改动无关代码)

- 新增 `src/accounts.js`:定位/生成桌面账号池、解析、随机选号(含 avoidRepeatLast)、读写 last-account。
- `src/main.js`:createWindow 接受选中的账号,设置 partition,并把凭据经 IPC 提供给窗口。
- 新增内置自动登录脚本 + 在 preload 侧的凭据获取通道(与现有 sendSync 脚本通道同构)。

## 测试

- accounts.js 的纯函数(随机选号、avoidRepeatLast、模板生成、解析容错)用现有 `node --test` 覆盖。
- 分区/自动登录属集成行为,由运行 App 手动验证(用户在场登录一次)。
