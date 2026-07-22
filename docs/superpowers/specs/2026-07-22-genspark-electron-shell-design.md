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
├── src/script-store.js  读取脚本目录，返回排序后的 css/js 内容
├── src/script-bridge.js 主进程侧 IPC：同步供稿 + CSS 热更新推送
├── src/watcher.js       监听脚本目录变化，触发重新注入
└── src/paths.js         用户数据目录与脚本目录的路径解析、首启初始化

renderer process
└── src/preload.js       document-start 注入 CSS 与 JS
```

模块之间只通过函数参数通信，没有共享可变状态。`main.js` 是唯一知道全部模块的地方。

### 注入时机（2026-07-22 修订）

初版在 `did-finish-load` 注入，导致站点原有内容先渲染、随后才被脚本改写，肉眼可见闪烁。现改为 **document-start**：

- preload 在页面解析任何标签之前运行，用 `ipcRenderer.sendSync` 同步取回脚本内容。同步是必要的——内容必须在解析器产出任何东西之前到手。
- preload 运行时 `document.documentElement` 尚不存在（`readyState === 'loading'`），直接操作会抛错。用 `MutationObserver` 观察 `document` 节点的 `childList`，根元素一出现立即注入。
- JS 通过创建 `<script>` 标签注入，因此仍运行在页面**主世界**，保留访问站点全局变量的能力。实测 genspark.ai 的 CSP 只声明 `frame-ancestors`，不拦截脚本。
- CSS 注入为 `<style>` 元素而非 `webContents.insertCSS`，这样热更新可以直接改写其内容。

### 数据流

```
app ready
  → paths.ensureScriptDir()        创建目录 + 首启写入示例脚本
  → scriptBridge.serveScripts(dir) 注册同步 IPC 供稿
  → windowState.load()             读取上次窗口几何
  → createWindow()                 BrowserWindow（挂 preload）加载 genspark.ai

document-start（渲染进程）
  → preload sendSync 取回脚本
  → 等 documentElement 出现
  → 注入 <style> 与 <script>

脚本目录变化
  → watcher 防抖
  → css 变化 → scriptBridge.pushCSS() → preload 改写 <style>（不刷新）
  → js  变化 → webContents.reload() → 重走 document-start 注入
```

## 组件契约

### `src/paths.js`

| 导出 | 说明 |
| --- | --- |
| `scriptsDir()` | 返回 `app.getPath('userData')/scripts`。 |
| `ensureScriptDir()` | 目录不存在时创建，并写入 `example.css` 与 `example.js`（均带说明注释，内容默认无副作用）。目录已存在时不做任何事，不覆盖用户文件。 |
| `windowStateFile()` | 返回 `app.getPath('userData')/window-state.json`。 |

依赖：`electron.app`、`node:fs`、`node:path`。

### `src/script-store.js`

`collectScripts(dir)` 返回 `{css: [{name, source}], js: [...]}`，各组按文件名字典序排序，注入顺序稳定可预期。目录缺失或文件读取失败时跳过并记日志，不抛错。

### `src/script-bridge.js`（主进程）

| 导出 | 说明 |
| --- | --- |
| `serveScripts(dir)` | 注册同步 IPC handler，preload 请求时立即返回 `collectScripts(dir)`。重复调用会先清掉旧 handler。 |
| `pushCSS(webContents, dir)` | 把当前样式表推给已加载的页面，用于免刷新热更新。webContents 已销毁时静默返回。 |

### `src/preload.js`（渲染进程，document-start）

沙箱化 preload 无法 require 项目文件，因此 IPC 频道名在此与 `script-bridge.js` 手工保持一致。

注入规则：

- CSS 合并进单个 `<style id="genspark-shell-user-css">`，追加到 `documentElement` 末尾；热更新时改写其 `textContent`。
- JS 逐个通过 `<script>` 元素注入，运行在页面**主世界**，可访问站点的 `window` 和全局变量；注入后立即移除元素。
- 每个 JS 文件的注入独立 try/catch 包裹；单个脚本失败只记录文件名，不影响其他脚本与页面。
- 目录为空时注入是无操作，不报错。

### `src/watcher.js`

`watchScripts(dir, onChange)`：`fs.watch` 递归关闭（只看一层），150ms 防抖，回调参数为变化文件的扩展名集合。返回 `close()`。

`main.js` 中的分派逻辑：变化只涉及 `.css` → `pushCSS()`；涉及 `.js` → `webContents.reload()`。

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
