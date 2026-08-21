import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderCandidates, leaseAccount } from '../src/lease.js'

const A = { id: 1, email: 'a@x.com', password_enc: 'ea' }
const B = { id: 2, email: 'b@x.com', password_enc: 'eb' }
const C = { id: 3, email: 'c@x.com', password_enc: 'ec' }

test('orderCandidates puts sticky account first', () => {
  const ordered = orderCandidates([A, B, C], 3, () => 0)
  assert.equal(ordered[0].id, 3)
  assert.equal(ordered.length, 3)
})

test('orderCandidates without sticky keeps all, no crash', () => {
  const ordered = orderCandidates([A, B], null, () => 0)
  assert.deepEqual(ordered.map((a) => a.id).sort(), [1, 2])
})

// 假 db:第一个 claim 失败(模拟被并发抢走),第二个成功
function fakeDb({ available, sticky = null, failIds = [] }) {
  const claimed = []
  const touched = []
  return {
    async availableAccounts() { return available },
    async lastAccountIdForClient() { return sticky },
    async claimAccount({ accountId }) {
      if (failIds.includes(accountId)) return null
      claimed.push(accountId)
      return 100 + accountId
    },
    async touchAccount(id) { touched.push(id) },
    _claimed: claimed,
    _touched: touched,
  }
}

test('leaseAccount returns null when no accounts available', async () => {
  const res = await leaseAccount(fakeDb({ available: [] }), { clientId: 7, now: 1000, ttlMs: 60000 })
  assert.equal(res, null)
})

test('leaseAccount claims sticky first and sets expiry', async () => {
  const db = fakeDb({ available: [A, B, C], sticky: 2 })
  const res = await leaseAccount(db, { clientId: 7, now: 1000, ttlMs: 60000, random: () => 0 })
  assert.equal(res.accountId, 2)
  assert.equal(res.email, 'b@x.com')
  assert.equal(res.password_enc, 'eb')
  assert.equal(res.leaseId, 102)
  assert.equal(res.expiresAt, 61000)
  assert.deepEqual(db._touched, [2])
})

test('leaseAccount retries next candidate when claim loses the race', async () => {
  // sticky=1 会先试,但 failIds 含 1 → 换下一个
  const db = fakeDb({ available: [A, B, C], sticky: 1, failIds: [1] })
  const res = await leaseAccount(db, { clientId: 7, now: 0, ttlMs: 1000, random: () => 0 })
  assert.notEqual(res, null)
  assert.notEqual(res.accountId, 1)
  assert.ok(db._claimed.length === 1)
})

test('leaseAccount returns null when every claim loses', async () => {
  const db = fakeDb({ available: [A, B], failIds: [1, 2] })
  const res = await leaseAccount(db, { clientId: 7, now: 0, ttlMs: 1000 })
  assert.equal(res, null)
})
