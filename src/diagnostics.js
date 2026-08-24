const fsDefault = require('node:fs')
const path = require('node:path')

// 启动诊断面板。存在的理由:打包后的 GUI 应用没有可看的控制台,而"上报到服务器"
// 这条路在连不上服务器时恰好是断的 —— 那正是最需要看到原因的时候。所以还得有一份
// 就在屏幕上的、能复制走的说明。
//
// 这个面板会被截图发出去,所以邀请码、token、账号密码一律只报"有/无",绝不报值。

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function readJson(file, fs) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// 返回 [标签, 值] 的数组。每一条都是我排查时反复要问的那几个问题之一。
function collectFacts({ platform, version, electron, userDataDir, bundledFile, fs = fsDefault } = {}) {
  const bundled = readJson(bundledFile, fs)
  const token = readJson(path.join(userDataDir, 'client-token.json'), fs)
  const cached = readJson(path.join(userDataDir, 'cached-account.json'), fs)
  const manual = readJson(path.join(userDataDir, 'server-config.json'), fs)

  const code = bundled && typeof bundled.registerCode === 'string' ? bundled.registerCode : ''
  return [
    ['平台', String(platform)],
    ['应用版本', String(version)],
    ...(electron ? [['Electron', String(electron)]] : []),
    ['userData 目录', String(userDataDir)],
    ['内置 client-config.json', bundled ? '找到了' : '没找到(这样一定不会自动登录)'],
    ['服务器地址', (manual && manual.apiBase) || (bundled && bundled.apiBase) || '(没有)'],
    ['邀请码', code ? `有(${code.length} 字符)` : '无'],
    ['本机 token', token && token.token ? '有' : '无(说明还没注册成功过)'],
    ['缓存的账号', cached && cached.email ? '有' : '无'],
  ]
}

function buildReportText(facts, lines) {
  const head = facts.map(([k, v]) => `${k}: ${v}`).join('\n')
  const body = lines.length
    ? lines.map((l) => `[${l.level}] ${l.message}`).join('\n')
    : '(没有记录到任何启动日志)'
  return `${head}\n\n----- 启动日志 -----\n${body}\n`
}

function renderDiagnosticsHtml(facts, lines) {
  const text = buildReportText(facts, lines)
  // 正文放只读 textarea:Ctrl+A / Ctrl+C 直接能全选复制,不依赖 clipboard API ——
  // 这个页面是从 data: URL 加载的,那里的 navigator.clipboard 不一定可用。
  return '<!doctype html><meta charset=utf-8><title>启动诊断</title>' +
    '<style>body{font:13px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;margin:0;padding:16px}' +
    'h1{font-size:15px;margin:0 0 4px}p{margin:0 0 12px;color:#666}' +
    'textarea{width:100%;height:calc(100vh - 110px);box-sizing:border-box;font:12px/1.45 ui-monospace,Consolas,monospace;' +
    'white-space:pre;padding:10px;border:1px solid #ccc;border-radius:6px;resize:none}</style>' +
    '<h1>老猫 · 启动诊断</h1>' +
    '<p>这次启动没能自动登录。点一下下面的框,按 Ctrl+A 全选、Ctrl+C 复制,把内容发给开发者。</p>' +
    `<textarea readonly spellcheck=false>${esc(text)}</textarea>`
}

module.exports = { collectFacts, buildReportText, renderDiagnosticsHtml, esc }
