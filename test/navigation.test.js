const test = require('node:test')
const assert = require('node:assert')

const { HOME_URL, isInternal, isBrowsable } = require('../src/navigation')

test('the home url is the genspark site', () => {
  assert.strictEqual(isInternal(HOME_URL), true)
})

test('the site and its subdomains are internal', () => {
  assert.strictEqual(isInternal('https://www.genspark.ai/agents'), true)
  assert.strictEqual(isInternal('https://genspark.ai/'), true)
  assert.strictEqual(isInternal('https://api.genspark.ai/x'), true)
})

test('other sites are external', () => {
  assert.strictEqual(isInternal('https://google.com/'), false)
  assert.strictEqual(isInternal('https://example.com/genspark.ai'), false)
})

test('a lookalike host is not treated as internal', () => {
  assert.strictEqual(isInternal('https://notgenspark.ai/'), false)
  assert.strictEqual(isInternal('https://genspark.ai.evil.com/'), false)
})

test('non-http schemes are never internal', () => {
  assert.strictEqual(isInternal('file:///etc/passwd'), false)
  assert.strictEqual(isInternal('javascript:alert(1)'), false)
})

test('malformed urls are not internal', () => {
  assert.strictEqual(isInternal('not a url'), false)
  assert.strictEqual(isInternal(''), false)
})

test('only http urls may be handed to the system browser', () => {
  assert.strictEqual(isBrowsable('https://example.com/'), true)
  assert.strictEqual(isBrowsable('http://example.com/'), true)
  assert.strictEqual(isBrowsable('file:///etc/passwd'), false)
  assert.strictEqual(isBrowsable('javascript:alert(1)'), false)
  assert.strictEqual(isBrowsable('not a url'), false)
})

test('an in-site popup is allowed and keeps the preload', () => {
  const { decideWindowOpen } = require('../src/navigation')

  const decision = decideWindowOpen('https://www.genspark.ai/zh-cn', '/path/to/preload.js')

  assert.strictEqual(decision.action, 'allow')
  // A popup does not inherit webPreferences, so the preload must be restated
  // or the user scripts never run in it.
  assert.strictEqual(
    decision.overrideBrowserWindowOptions.webPreferences.preload,
    '/path/to/preload.js',
  )
})

test('a popup keeps the renderer sandboxed', () => {
  const { decideWindowOpen } = require('../src/navigation')

  const { webPreferences } = decideWindowOpen('https://www.genspark.ai/x', '/p.js')
    .overrideBrowserWindowOptions

  assert.strictEqual(webPreferences.contextIsolation, true)
  assert.strictEqual(webPreferences.nodeIntegration, false)
  assert.strictEqual(webPreferences.sandbox, true)
})

test('an off-site popup is denied', () => {
  const { decideWindowOpen } = require('../src/navigation')

  assert.deepStrictEqual(decideWindowOpen('https://example.com/', '/p.js'), { action: 'deny' })
})
