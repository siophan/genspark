import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptPassword, decryptPassword } from '../src/crypto.js'

// 32 字节全 0 的 base64,仅测试用
const KEY = Buffer.alloc(32).toString('base64')

test('round-trips a password', async () => {
  const enc = await encryptPassword('123Yin321', KEY)
  assert.notEqual(enc, '123Yin321')
  assert.match(enc, /^[^:]+:[^:]+$/)                 // iv:cipher
  assert.equal(await decryptPassword(enc, KEY), '123Yin321')
})

test('two encryptions of same text differ (random IV)', async () => {
  const a = await encryptPassword('same', KEY)
  const b = await encryptPassword('same', KEY)
  assert.notEqual(a, b)
  assert.equal(await decryptPassword(a, KEY), 'same')
  assert.equal(await decryptPassword(b, KEY), 'same')
})

test('wrong key fails to decrypt', async () => {
  const enc = await encryptPassword('secret', KEY)
  const otherKey = Buffer.alloc(32, 1).toString('base64')
  await assert.rejects(() => decryptPassword(enc, otherKey))
})
