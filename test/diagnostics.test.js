const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { collectFacts, buildReportText, renderDiagnosticsHtml } = require('../src/diagnostics')

const USERDATA = path.join('/u')
const BUNDLED = path.join('/pkg', 'client-config.json')

function fakeFs(files) {
  return {
    existsSync: (p) => p in files,
    readFileSync(p) { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
  }
}

const env = { platform: 'win32', version: '1.0.0', userDataDir: USERDATA, bundledFile: BUNDLED }

test('内置配置齐全时,报出服务器地址,但绝不报邀请码本身', () => {
  const fs = fakeFs({
    [BUNDLED]: JSON.stringify({ apiBase: 'https://s.dev', registerCode: 'SUPER-SECRET-CODE' }),
    [path.join(USERDATA, 'client-token.json')]: JSON.stringify({ token: 'tok-abc' }),
  })
  const text = buildReportText(collectFacts({ ...env, fs }), [])
  assert.match(text, /https:\/\/s\.dev/)
  assert.match(text, /win32/)
  assert.ok(!text.includes('SUPER-SECRET-CODE'), '邀请码绝不能显示 —— 这个面板会被截图发出去')
  assert.ok(!text.includes('tok-abc'), 'token 同理')
  assert.match(text, /邀请码.*有/, '只说有没有')
  assert.match(text, /本机 token.*有/)
})

test('内置配置缺失时说清楚 —— 这就是不会自动登录的直接原因', () => {
  const text = buildReportText(collectFacts({ ...env, fs: fakeFs({}) }), [])
  assert.match(text, /client-config\.json.*没找到/)
  assert.match(text, /本机 token.*无/)
})

test('日志行按顺序附在后面', () => {
  const lines = [{ level: 'log', message: '第一步' }, { level: 'error', message: '炸了' }]
  const text = buildReportText(collectFacts({ ...env, fs: fakeFs({}) }), lines)
  assert.ok(text.indexOf('第一步') < text.indexOf('炸了'))
  assert.match(text, /error.*炸了/)
})

test('没有任何日志行时也不留白,明说一句', () => {
  const text = buildReportText(collectFacts({ ...env, fs: fakeFs({}) }), [])
  assert.match(text, /没有/)
})

// 面板内容里有报错文本,报错文本里什么字符都可能有。
test('渲染成 HTML 时转义,textarea 不会被内容提前闭合', () => {
  const lines = [{ level: 'error', message: '</textarea><script>alert(1)</script>' }]
  const html = renderDiagnosticsHtml(collectFacts({ ...env, fs: fakeFs({}) }), lines)
  assert.ok(!html.includes('</textarea><script>'), '裸标签不能出现')
  assert.match(html, /&lt;\/textarea&gt;/)
  assert.match(html, /<textarea[^>]*readonly/, '正文放在只读 textarea 里,Ctrl+A 就能全选')
})
