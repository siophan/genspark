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
