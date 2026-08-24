// 打包后的 GUI 应用没有可看的控制台 —— console.error 落进虚空,取号那条链路一旦
// 静默失败就完全不可观测("没自动登录"是唯一症状)。所以把 console 输出攒在内存里,
// 再送到服务器,后台按机器分开显示。
//
// 明确的取舍(使用者选定):不落磁盘。客户端连不上服务器时日志同样送不出去,
// 后台会是一片空白 —— 而空白既可能是"连不上"也可能是"日志没生效",分不出来。
// 后台那个页面上写了这句话,免得读的人把空白当成"启动正常"。

const MAX_LINES = 200

// console 的实参什么都可能是。Error 要带上 stack(排障就靠它),普通对象走 JSON,
// 循环引用会让 JSON.stringify 抛 —— 一个日志格式化函数把宿主程序搞崩是不可接受的。
function formatArg(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
  try { return JSON.stringify(a) ?? String(a) }
  catch { return String(a) }
}

function createLogBuffer({ max = MAX_LINES, target = console } = {}) {
  const lines = []
  // 待发队列(lines)会被上报清空,但诊断面板要把这一整场启动摊开给人看,
  // 所以历史单独留一份,不随上报消失。
  const history = []
  const originals = {}
  let paused = false

  function record(level, args) {
    // 上报过程自己也会 console.error(post() 失败时就会)。不挡住的话失败一次就自我
    // 循环:记一行 → 下次上报带上它 → 又失败 → 再记一行,永不收敛。
    if (paused) return
    // 溢出时丢新的、留旧的:故障的成因在开头,后面全是它的回声。
    if (lines.length >= max) return
    const line = { level, message: args.map(formatArg).join(' ') }
    lines.push(line)
    if (history.length < max) history.push(line)
  }

  function install() {
    for (const name of ['log', 'warn', 'error']) {
      if (originals[name]) continue
      const orig = target[name].bind(target)
      originals[name] = orig
      // 原行为一个不少:开发态还是要能在终端里看见。
      target[name] = (...args) => { record(name, args); orig(...args) }
    }
  }

  function restore() {
    for (const name of Object.keys(originals)) target[name] = originals[name]
    for (const name of Object.keys(originals)) delete originals[name]
  }

  // send(lines) → truthy 表示送到了。没送到就把行放回去等下一轮 —— 一次 Wi-Fi 抖动
  // 不该让这批日志永久消失,而重试的量由 max 兜着。
  async function flush(send) {
    if (!lines.length) return false
    const batch = lines.splice(0, lines.length)
    paused = true
    let ok = false
    try { ok = Boolean(await send(batch)) }
    catch { ok = false }
    finally { paused = false }
    if (!ok) lines.unshift(...batch.slice(0, max))
    return ok
  }

  // 副本:面板拿到的是快照,外面怎么改都动不了内部状态。
  return { install, restore, flush, size: () => lines.length, snapshot: () => history.slice() }
}

module.exports = { createLogBuffer, formatArg, MAX_LINES }
