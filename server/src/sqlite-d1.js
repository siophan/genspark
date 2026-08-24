import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

// D1 之外的第二种落地方式:同一份 db.js 跑在本机 SQLite 上。
// 这层薄壳原本只活在测试里 —— 现在提到生产代码,自建部署跑的就是被整套用例
// 验证过的那一份,而不是另写一个"应该也一样"的实现。
// D1 底层就是 SQLite,prepare/bind/first/all/run 的语义逐条对应。
export function d1Shim(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      let bound = []
      const api = {
        bind(...args) { bound = args; return api },
        // D1 没有命中时返回 null,node:sqlite 返回 undefined。
        first() { const r = stmt.get(...bound); return r === undefined ? null : r },
        all() { return { results: stmt.all(...bound) } },
        run() { const r = stmt.run(...bound); return { meta: { changes: Number(r.changes ?? 0) } } },
      }
      return api
    },
  }
}

// 打开(必要时创建)库并把 schema 打上。schema.sql 全是 IF NOT EXISTS,
// 所以每次启动都执行一遍是安全的,也顺带让部署免去"记得先建表"这一步。
export function openDatabase(file, schemaFile) {
  const sqlite = new DatabaseSync(file)
  // D1 默认开启外键检查,node:sqlite 默认关闭。不打开的话两种部署的行为会不一样,
  // 而"删一个租过的账号"这类操作正好踩在这个差异上。
  sqlite.exec('PRAGMA foreign_keys = ON')
  // 单进程多请求并发读写,WAL 下读不阻塞写。
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  if (schemaFile) sqlite.exec(readFileSync(schemaFile, 'utf8'))
  return { sqlite, db: d1Shim(sqlite) }
}
