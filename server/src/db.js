// D1 适配层。所有写用条件语句 + RETURNING 保证并发安全。
export function makeDb(d1) {
  return {
    async availableAccounts(now) {
      const { results } = await d1
        .prepare(
          `SELECT a.id, a.email, a.password_enc
             FROM accounts a
            WHERE a.enabled = 1
              AND NOT EXISTS (
                SELECT 1 FROM leases l
                 WHERE l.account_id = a.id AND l.released_at IS NULL AND l.expires_at > ?1)`,
        )
        .bind(now)
        .all()
      return results || []
    },

    async lastAccountIdForClient(clientId) {
      const row = await d1
        .prepare('SELECT account_id FROM leases WHERE client_id = ?1 ORDER BY id DESC LIMIT 1')
        .bind(clientId)
        .first()
      return row ? row.account_id : null
    },

    async claimAccount({ accountId, clientId, expiresAt, now }) {
      const row = await d1
        .prepare(
          `INSERT INTO leases (account_id, client_id, expires_at, released_at)
             SELECT ?1, ?2, ?3, NULL
              WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND enabled = 1)
                AND NOT EXISTS (
                  SELECT 1 FROM leases
                   WHERE account_id = ?1 AND released_at IS NULL AND expires_at > ?4)
           RETURNING id`,
        )
        .bind(accountId, clientId, expiresAt, now)
        .first()
      return row ? row.id : null
    },

    async touchAccount(accountId, now) {
      await d1.prepare('UPDATE accounts SET last_used_at = ?2 WHERE id = ?1').bind(accountId, now).run()
    },

    async renewLease({ leaseId, clientId, now, ttlMs }) {
      const row = await d1
        .prepare(
          `UPDATE leases SET expires_at = ?3
             WHERE id = ?1 AND client_id = ?2 AND released_at IS NULL AND expires_at > ?4
           RETURNING expires_at`,
        )
        .bind(leaseId, clientId, now + ttlMs, now)
        .first()
      return row ? row.expires_at : null
    },

    async releaseLease({ leaseId, clientId, now }) {
      await d1
        .prepare(
          'UPDATE leases SET released_at = ?3 WHERE id = ?1 AND client_id = ?2 AND released_at IS NULL',
        )
        .bind(leaseId, clientId, now)
        .run()
    },

    async verifyClient(tokenHash, now) {
      const row = await d1
        .prepare('SELECT id FROM clients WHERE token_hash = ?1 AND enabled = 1')
        .bind(tokenHash)
        .first()
      if (!row) return null
      await d1.prepare('UPDATE clients SET last_seen_at = ?2 WHERE id = ?1').bind(row.id, now).run()
      return { id: row.id }
    },

    // 带上 leased_by_id:客户端名字允许为空(后台生成 token 时不填就是空的),
    // 只回名字的话"租给了一个没名字的客户端"和"没租出去"在后台是同一个空格子。
    async listAccounts() {
      const { results } = await d1
        .prepare(
          `SELECT a.id, a.email, a.enabled, a.note, a.last_used_at,
                  l.client_id  AS leased_by_id,
                  c.name       AS leased_by,
                  l.expires_at AS lease_expires_at
             FROM accounts a
             LEFT JOIN leases l
                    ON l.id = (SELECT id FROM leases
                                WHERE account_id = a.id AND released_at IS NULL AND expires_at > ?1
                                ORDER BY id DESC LIMIT 1)
             LEFT JOIN clients c ON c.id = l.client_id
            ORDER BY a.id`,
        )
        .bind(Date.now())
        .all()
      return results || []
    },
    async createAccount({ email, password_enc, note }) {
      const row = await d1
        .prepare('INSERT INTO accounts (email, password_enc, note) VALUES (?1,?2,?3) RETURNING id')
        .bind(email, password_enc, note ?? null)
        .first()
      return row.id
    },
    async updateAccount(id, fields) {
      const sets = []
      const vals = []
      for (const k of ['email', 'password_enc', 'enabled', 'note']) {
        if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]) }
      }
      if (!sets.length) return
      vals.push(id)
      await d1.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()
    },
    // 返回 true 才是真删掉了。两件事绕不开:
    // 1) leases.account_id 有外键、D1 默认开外键检查,不先清租约,DELETE accounts 直接报
    //    FOREIGN KEY constraint failed —— 越常用的账号越删不掉。
    // 2) 正被持有的账号不能删:客户端手上攥着凭据,会继续用一个后台已经不存在的号。
    //    条件 DELETE 兜住"检查完到删之间刚好被人租走"的窗口 —— 那一瞬间账号会留下来。
    async deleteAccount(id, now = Date.now()) {
      await d1
        .prepare(
          `DELETE FROM leases
             WHERE account_id = ?1 AND (released_at IS NOT NULL OR expires_at <= ?2)`,
        )
        .bind(id, now)
        .run()
      const row = await d1
        .prepare(
          `DELETE FROM accounts
             WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM leases
                                WHERE account_id = ?1 AND released_at IS NULL AND expires_at > ?2)
           RETURNING id`,
        )
        .bind(id, now)
        .first()
      return row != null
    },
    // 取最后一条租约(不是最后一条"有效"租约):已归还的也要显示,不然客户端一退出
    // 后台就再也看不出它刚才用的是哪个号,排查串号问题时无从下手。是否仍然持有由
    // released_at / expires_at 判断,交给调用方渲染。
    async listClients() {
      const { results } = await d1
        .prepare(
          `SELECT c.id, c.name, c.enabled, c.last_seen_at,
                  l.account_id  AS last_account_id,
                  l.expires_at  AS last_expires_at,
                  l.released_at AS last_released_at,
                  a.email       AS last_account_email
             FROM clients c
             LEFT JOIN leases l
                    ON l.id = (SELECT id FROM leases WHERE client_id = c.id ORDER BY id DESC LIMIT 1)
             LEFT JOIN accounts a ON a.id = l.account_id
            ORDER BY c.id`,
        )
        .all()
      return results || []
    },
    // enabled 默认 1:后台手工生成的 token 和自助注册的都当场可用。参数保留是因为
    // 停用/启用走 setClientEnabled,而建行时需要能显式指定 —— 测试也依赖它。
    async createClient({ name, token_hash, enabled = 1 }) {
      const row = await d1
        .prepare('INSERT INTO clients (name, token_hash, enabled) VALUES (?1,?2,?3) RETURNING id')
        .bind(name, token_hash, enabled ? 1 : 0)
        .first()
      return row.id
    },
    async setClientEnabled(id, enabled) {
      await d1.prepare('UPDATE clients SET enabled = ?2 WHERE id = ?1').bind(id, enabled ? 1 : 0).run()
    },
  }
}
