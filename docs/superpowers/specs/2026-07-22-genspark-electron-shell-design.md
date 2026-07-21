# Genspark Electron 壳 — 设计文档

日期：2026-07-22
状态：已确认，待实现

## 目标

把 https://www.genspark.ai/ 包装成一个 macOS 桌面应用，并提供用户脚本能力：用户可以放置自己的 CSS / JS 文件注入到页面中，修改文件后自动生效。

## 非目标（YAGNI）

- 不实现 userscript 元数据（`// @match`、`// @require` 等）。本应用只有一个站点，match 规则没有意义。
- 不实现 `GM_*` API（`GM_setValue`、`GM_xmlhttpRequest` 等）。
- 不做代码签名与公证。本地自用，用户首次打开时手动允许即可。
- 不做 Windows / Linux 产物。
- 不做托盘图标、全局快捷键、桌面通知、离线提示页。

## 架构

```
main process (Node)
├── src/main.js          应用入口：生命周期、创建窗口、组装模块
├── src/window-state.js  窗口尺寸/位置持久化
├── src/menu.js          原生菜单与快捷键
├── src/injector.js      读取脚本目录并注入到 webContents
├── src/watcher.js       监听脚本目录变化，触发重新注入
└── src/paths.js         用户数据目录与脚本目录的路径解析、首启初始化
```

模块之间只通过函数参数通信，没有共享可变状态。`main.js` 是唯一知道全部模块的地方。

### 数据流

```
app ready
  → paths.ensureScriptDir()        创建目录 + 首启写入示例脚本
  → windowState.load()             读取上次窗口几何
  → createWindow()                 BrowserWindow 加载 genspark.ai
  → injector.attach(webContents)   监听 did-finish-load，每次加载完成后注入
  → watcher.watch(dir, onChange)   目录变化 → 防抖 → injector.reinject()
```

## 组件契约

### `src/paths.js`

| 导出 | 说明 |
| --- | --- |
| `scriptsDir()` | 返回 `app.getPath('userData')/scripts`。 |
| `ensureScriptDir()` | 目录不存在时创建，并写入 `example.css` 与 `example.js`（均带说明注释，内容默认无副作用）。目录已存在时不做任何事，不覆盖用户文件。 |
| `windowStateFile()` | 返回 `app.getPath('userData')/window-state.json`。 |

依赖：`electron.app`、`node:fs`、`node:path`。

### `src/injector.js`

工厂函数 `createInjector(webContents)`，返回：

| 方法 | 说明 |
| --- | --- |
| `attach()` | 绑定 `did-finish-load`，每次页面加载完成后执行一次全量注入。 |
| `reinjectCSS()` | 卸载已注入的全部 CSS（`removeInsertedCSS`，按保存的 key），重新读取并注入。页面不刷新。 |
| `reloadForJS()` | 调用 `webContents.reload()`；页面重新加载会触发 `did-finish-load`，走全量注入路径。 |
| `dispose()` | 解绑监听。 |

注入规则：

- 读取脚本目录下所有 `*.css` 与 `*.js`，各自按文件名字典序排序后依次注入，顺序稳定可预期。
- CSS 通过 `webContents.insertCSS(source)`，保存返回的 key 以便卸载。
- JS 通过 `webContents.executeJavaScript(source, true)`，运行在页面**主世界**，可访问站点的 `window` 和全局变量。
- 每个 JS 文件的执行独立 try/catch 包裹；单个脚本抛错只在主进程 `console.error` 中记录文件名与错误，不影响其他脚本，也不影响页面。
- 目录为空时注入是无操作，不报错。

### `src/watcher.js`

`watchScripts(dir, onChange)`：`fs.watch` 递归关闭（只看一层），150ms 防抖，回调参数为变化文件的扩展名集合。返回 `close()`。

`main.js` 中的分派逻辑：变化只涉及 `.css` → `reinjectCSS()`；涉及 `.js` → `reloadForJS()`。

### `src/window-state.js`

`loadState()` 返回 `{width, height, x, y}`，无文件或解析失败时返回默认值 1400×900、位置交给系统。`trackWindow(win)` 监听 `resize`/`move`/`close`，防抖 500ms 写回 JSON。屏幕布局变化导致窗口落到可见区域外时，回退到默认几何。

### `src/menu.js`

`buildMenu({onOpenScriptsDir})` 构建并 `Menu.setApplicationMenu`。

| 快捷键 | 动作 |
| --- | --- |
| ⌘R | 刷新 |
| ⌘⇧R | 强制刷新（忽略缓存） |
| ⌘[ / ⌘] | 后退 / 前进 |
| ⌘+ / ⌘- / ⌘0 | 放大 / 缩小 / 重置缩放 |
| ⌥⌘I | 切换 DevTools |
| ⌘, | 在 Finder 中打开脚本目录（`shell.openPath`） |

其余保留标准的 App / Edit / Window 菜单项（复制粘贴、最小化、关闭等必须保留，否则网页内无法使用系统级编辑快捷键）。

### `src/main.js`

窗口配置：

```js
{
  width, height, x, y,          // 来自 window-state
  webPreferences: {
    contextIsolation: true,     // 远程站点必须保持沙箱
    nodeIntegration: false,
    sandbox: true,
  },
}
```

- 加载 `https://www.genspark.ai/`。
- `setWindowOpenHandler`：目标 host 属于 `genspark.ai`（含子域）时 `{action: 'allow'}` 在应用内新窗口打开；否则 `shell.openExternal` 并 `{action: 'deny'}`。
- `will-navigate`：非 `genspark.ai` 域名一律阻止并 `shell.openExternal`。
- macOS 行为：关闭窗口不退出应用，`activate` 时重建窗口；`window-all-closed` 在非 darwin 才 `app.quit()`。

## 错误处理

| 情况 | 行为 |
| --- | --- |
| 脚本目录不可创建（权限） | 主进程 `console.error`，应用照常启动，注入功能静默停用。 |
| 单个脚本文件读取失败 | 跳过该文件，记录日志，继续注入其余文件。 |
| JS 脚本抛出异常 | try/catch 隔离，记录 `[injector] example.js: <error>`，不影响页面与其他脚本。 |
| `window-state.json` 损坏 | 捕获解析错误，使用默认几何，下次保存时覆盖。 |
| 页面加载失败（断网） | 使用 Electron 默认的错误页面，不做自定义处理。 |

## 测试策略

用 `node --test`（Node 内置 test runner，无需额外依赖）覆盖不依赖 Electron 运行时的纯逻辑：

- `paths.ensureScriptDir()`：目录不存在时创建并写入示例；目录已存在时不覆盖已有文件。（注入 `app.getPath` 的替身）
- `injector` 的文件收集与排序：给定一组文件名，返回正确分组与字典序。
- `watcher` 的防抖与扩展名分派：连续多次变化只触发一次回调，扩展名集合正确。
- `window-state` 的加载回退：文件缺失、JSON 损坏、几何落在屏幕外三种情况都回退到默认值。

为此，上述模块中依赖 Electron 的部分（`app.getPath`、`webContents`）通过参数注入，纯逻辑抽成可独立导入的函数。

手动验证清单（Electron 集成部分无自动化测试）：启动后站点正常加载并登录；改 `example.css` 后页面样式立即变化且未刷新；改 `example.js` 后页面刷新且脚本生效；点击站外链接在系统浏览器打开；关闭再打开窗口尺寸位置保持。

## 打包

`electron-builder`，配置写在 `package.json` 的 `build` 字段：

```
appId: com.ezreal.genspark-shell
productName: Genspark
mac.target: [dmg, zip]
mac.arch: [arm64, x64]
mac.category: public.app-category.productivity
files: src/**, package.json
```

不签名不公证。构建命令 `npm run dist`。产物在 `dist/`。

图标：不提供自定义图标，使用 Electron 默认图标。（后续如需替换，放 `build/icon.icns` 即可被 electron-builder 自动识别。）

## 依赖

- `electron`（devDependency）
- `electron-builder`（devDependency）

运行时零依赖。热重载用 Node 内置 `fs.watch`，不引入 `chokidar`。
