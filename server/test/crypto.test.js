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

// 格式守卫:密文列被截断/写坏时,给一个可预期的失败,而不是从 Web Crypto 深处
// 抛出一个跟原因毫无关系的错误。
test('decryptPassword rejects an input that is not iv_b64:cipher_b64', async () => {
  for (const bad of ['', 'nocolon', ':cipher', 'iv:', 'a:b:c', null, undefined]) {
    await assert.rejects(
      () => decryptPassword(bad, KEY),
      /expected "iv_b64:cipher_b64"/,
      'should have rejected: ' + JSON.stringify(bad),
    )
  }
})
