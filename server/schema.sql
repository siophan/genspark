CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_enc  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  last_used_at  INTEGER
);
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER
);
CREATE TABLE IF NOT EXISTS leases (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  expires_at    INTEGER NOT NULL,
  released_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leases_active ON leases(account_id, released_at, expires_at);

-- 客户端上报的启动日志。打包后的 GUI 应用没有可看的控制台,取号链路一旦静默失败
-- 就完全不可观测,所以让客户端把 console 输出送到这里。
-- client_id 为 NULL 表示注册成功之前的匿名上报 —— 那时客户端还没有 token,只能用
-- 内置邀请码鉴权。邀请码随公开 Release 分发、事实上已公开,所以这条通道是公开可写的:
-- 写入量靠接口层的条数/长度上限和全局保留上限兜住,device 是这类记录唯一的身份线索。
CREATE TABLE IF NOT EXISTS client_logs (
  id         INTEGER PRIMARY KEY,
  client_id  INTEGER REFERENCES clients(id),
  device     TEXT,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_logs_recent ON client_logs(id DESC);
