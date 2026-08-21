import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateToken, hashToken } from '../src/tokens.js'

test('generateToken makes unique url-safe tokens', async () => {
  const a = await generateToken()
  const b = await generateToken()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]+$/)                 // base64url,无 +/=
  assert.ok(a.length >= 40)
})

test('hashToken is deterministic 64-hex sha256', async () => {
  const h1 = await hashToken('hello')
  const h2 = await hashToken('hello')
  assert.equal(h1, h2)
  assert.match(h1, /^[0-9a-f]{64}$/)
  // 已知向量:sha256("hello")
  assert.equal(h1, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
})
