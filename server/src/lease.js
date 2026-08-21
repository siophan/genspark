// sticky 账号排最前,其余用注入的 random 洗牌(Fisher–Yates),便于确定性测试。
export function orderCandidates(candidates, stickyId, random = Math.random) {
  const sticky = []
  const rest = []
  for (const c of candidates) {
    if (stickyId != null && c.id === stickyId) sticky.push(c)
    else rest.push(c)
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return [...sticky, ...rest]
}

export async function leaseAccount(db, { clientId, now, ttlMs, random = Math.random }) {
  const candidates = await db.availableAccounts(now)
  if (!candidates.length) return null
  const stickyId = await db.lastAccountIdForClient(clientId)
  const expiresAt = now + ttlMs
  for (const acct of orderCandidates(candidates, stickyId, random)) {
    const leaseId = await db.claimAccount({ accountId: acct.id, clientId, expiresAt, now })
    if (leaseId != null) {
      await db.touchAccount(acct.id, now)
      return { leaseId, accountId: acct.id, email: acct.email, password_enc: acct.password_enc, expiresAt }
    }
  }
  return null
}
