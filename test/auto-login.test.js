// test/auto-login.test.js
const test = require('node:test')
const assert = require('node:assert')

const { buildLoginScript } = require('../src/auto-login')

test('buildLoginScript embeds escaped credentials in a callable IIFE', () => {
  const src = buildLoginScript('a@x.com', 'p"1\n2')
  assert.match(src, /^\(function/)
  assert.ok(src.includes(JSON.stringify('a@x.com')))
  assert.ok(src.includes(JSON.stringify('p"1\n2')))
  // no raw newline from the password leaked into source
  assert.ok(!src.includes('p"1\n2'))
})

test('buildLoginScript references the B2C form fields it will fill', () => {
  const src = buildLoginScript('a@x.com', 'p')
  assert.ok(src.includes("input[type=password]"))
  assert.ok(src.includes('login.genspark.ai'))
})

test('buildLoginScript targets the verified genspark login elements', () => {
  const src = buildLoginScript('a@x.com', 'p')
  // B2C form fields and the real submit button
  assert.ok(src.includes('#email'))
  assert.ok(src.includes('#password'))
  assert.ok(src.includes('#next'))
  assert.ok(src.includes('#loginWithEmailWrapper'))
  // landing-page modal steps (styled div/span, matched by text)
  assert.ok(src.includes('更多选项'))
  assert.ok(src.includes('登'))
})

test('buildLoginScript includes the branded loading overlay', () => {
  const src = buildLoginScript('a@x.com', 'p')
  assert.ok(src.includes('gs-auto-login-overlay'))
  assert.ok(src.includes('老猫'))
  assert.ok(src.includes('position:fixed'))
  assert.ok(src.includes('@keyframes gsspin'))
})
