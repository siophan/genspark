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

    async listAccounts() {
      const { results } = await d1
        .prepare(
          `SELECT a.id, a.email, a.enabled, a.note, a.last_used_at,
                  (SELECT c.name FROM leases l JOIN clients c ON c.id = l.client_id
                    WHERE l.account_id = a.id AND l.released_at IS NULL AND l.expires_at > ?1
                    ORDER BY l.id DESC LIMIT 1) AS leased_by
             FROM accounts a ORDER BY a.id`,
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
    async deleteAccount(id) {
      await d1.prepare('DELETE FROM accounts WHERE id = ?1').bind(id).run()
    },
    async listClients() {
      const { results } = await d1
        .prepare('SELECT id, name, enabled, last_seen_at FROM clients ORDER BY id')
        .all()
      return results || []
    },
    // enabled 默认 1:后台手工生成 token 是管理员的明确动作,当场可用。自助注册
    // 必须显式传 0 —— 邀请码内置在公开可下载的安装包里,等于公开,批准这一步是
    // 陌生人拿不到账号的唯一防线。
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
