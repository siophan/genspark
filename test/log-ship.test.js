const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLogBuffer, formatArg } = require('../src/log-ship')

function fakeConsole() {
  const seen = []
  return {
    seen,
    log: (...a) => seen.push(['log', a]),
    warn: (...a) => seen.push(['warn', a]),
    error: (...a) => seen.push(['error', a]),
  }
}

test('拦下三个级别,但底层 console 的行为一个不少', () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target })
  buf.install()
  target.log('一')
  target.warn('二')
  target.error('三')
  buf.restore()
  target.log('拆掉之后的不该再进缓冲')

  assert.deepEqual(target.seen.map((s) => s[0]), ['log', 'warn', 'error', 'log'], '原样透传')
  assert.equal(buf.size(), 3)
})

test('多个参数拼成一行,Error 带上可读内容', () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target })
  buf.install()
  target.error('[x] 失败:', new Error('boom'))
  buf.restore()
  let taken
  buf.flush(async (b) => { taken = b; return true })
  assert.match(taken[0].message, /\[x\] 失败:/)
  assert.match(taken[0].message, /boom/)
  assert.equal(taken[0].level, 'error')
})

// 溢出时丢新的、留旧的:故障的成因在开头,后面全是它的回声。
test('缓冲满了之后丢掉新行,保住最早的', () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target, max: 3 })
  buf.install()
  for (let i = 0; i < 10; i++) target.log('第' + i)
  buf.restore()
  let taken
  buf.flush(async (b) => { taken = b; return true })
  assert.equal(taken.length, 3)
  assert.deepEqual(taken.map((l) => l.message), ['第0', '第1', '第2'])
})

// 上报本身也会 console.error(post() 失败时就会)。不挡住的话失败一次就自我循环:
// 记一行 → 下次上报带上它 → 又失败 → 再记一行,永不收敛。
test('上报期间产生的日志不进缓冲,避免自我循环', async () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target })
  buf.install()
  target.log('要送的那一行')
  await buf.flush(async () => {
    target.error('上报自己失败了')  // 这一行不能被记下来
    return true
  })
  buf.restore()
  assert.equal(buf.size(), 0, '送成功后缓冲清空,且上报期间那行没被记进来')
})

test('上报失败时把行放回去,下一轮还能重试', async () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target })
  buf.install()
  target.log('一')
  const ok = await buf.flush(async () => false)
  buf.restore()
  assert.equal(ok, false)
  assert.equal(buf.size(), 1, '没送出去就得留着')
})

test('缓冲为空时不调用发送函数', async () => {
  const buf = createLogBuffer({ target: fakeConsole() })
  let called = false
  const ok = await buf.flush(async () => { called = true; return true })
  assert.equal(called, false)
  assert.equal(ok, false)
})

test('formatArg 不会因为循环引用而抛', () => {
  const a = {}
  a.self = a
  assert.equal(typeof formatArg(a), 'string')
})

// 上报成功会把待发队列清空,但诊断面板还要拿这些行给人看 —— 所以历史要单独留一份。
test('snapshot 保留全部记录,上报清空待发队列也不影响它', async () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target })
  buf.install()
  target.log('一')
  target.error('二')
  await buf.flush(async () => true)
  target.log('三')
  buf.restore()

  assert.equal(buf.size(), 1, '待发队列里只剩上报之后那一行')
  assert.deepEqual(buf.snapshot().map((l) => l.message), ['一', '二', '三'], '历史三行都在')
})

test('snapshot 返回副本,外部改不动内部状态', () => {
  const target = fakeConsole()
  const buf = createLogBuffer({ target })
  buf.install()
  target.log('一')
  buf.restore()
  buf.snapshot().push({ level: 'log', message: '外面塞进来的' })
  assert.equal(buf.snapshot().length, 1)
})

// fetch 失败时 undici 抛的是一个信息量为零的外壳:`TypeError: fetch failed`。
// 真正有用的东西在 err.cause 里 —— DNS 没解析出来、TCP 被重置、TLS 被拦,
// 三件完全不同的事在外壳上长得一模一样。只取 stack 等于把答案扔了。
test('formatArg 把 cause 链一起带上', () => {
  const inner = new Error('getaddrinfo ENOTFOUND s.example')
  inner.code = 'ENOTFOUND'
  const outer = new TypeError('fetch failed', { cause: inner })
  const out = formatArg(outer)
  assert.match(out, /fetch failed/)
  assert.match(out, /ENOTFOUND/, 'cause 的内容必须出现')
  assert.match(out, /getaddrinfo/)
})

test('formatArg 对多层 cause 也能展开,且不会被自引用卡死', () => {
  const a = new Error('最里层')
  const b = new Error('中间层', { cause: a })
  const c = new Error('最外层', { cause: b })
  const out = formatArg(c)
  assert.match(out, /最外层/)
  assert.match(out, /中间层/)
  assert.match(out, /最里层/)

  const loop = new Error('自己指自己')
  loop.cause = loop
  assert.equal(typeof formatArg(loop), 'string', '自引用不能变成死循环')
})
