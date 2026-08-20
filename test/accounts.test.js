const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  DEFAULT_TEMPLATE, accountsFile, ensureAccountsFile,
  loadAccounts, isExampleAccount, realAccounts,
} = require('../src/accounts')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genspark-acct-'))
}

test('accountsFile lives on the given desktop dir', () => {
  assert.strictEqual(accountsFile('/D'), path.join('/D', 'genspark-accounts.json'))
})

test('DEFAULT_TEMPLATE parses and has example accounts', () => {
  const parsed = JSON.parse(DEFAULT_TEMPLATE)
  assert.strictEqual(Array.isArray(parsed.accounts), true)
  assert.ok(parsed.accounts.length >= 1)
})

test('ensureAccountsFile writes template only when missing', () => {
  const file = path.join(tmpdir(), 'genspark-accounts.json')
  assert.strictEqual(ensureAccountsFile(file), true)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), DEFAULT_TEMPLATE)
  fs.writeFileSync(file, '{"accounts":[]}')
  assert.strictEqual(ensureAccountsFile(file), false)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"accounts":[]}')
})

test('loadAccounts tolerates bad json', () => {
  const file = path.join(tmpdir(), 'x.json')
  fs.writeFileSync(file, 'not json')
  assert.deepStrictEqual(loadAccounts(file), { avoidRepeatLast: true, accounts: [] })
})

test('loadAccounts reads a valid pool', () => {
  const file = path.join(tmpdir(), 'x.json')
  fs.writeFileSync(file, JSON.stringify({
    avoidRepeatLast: false,
    accounts: [{ email: 'a@x.com', password: 'p' }],
  }))
  assert.deepStrictEqual(loadAccounts(file), {
    avoidRepeatLast: false,
    accounts: [{ email: 'a@x.com', password: 'p' }],
  })
})

test('example accounts are recognised and filtered out', () => {
  const tmpl = JSON.parse(DEFAULT_TEMPLATE)
  assert.strictEqual(isExampleAccount(tmpl.accounts[0]), true)
  assert.strictEqual(isExampleAccount({ email: 'real@x.com', password: 'p' }), false)
  const mixed = [tmpl.accounts[0], { email: 'real@x.com', password: 'p' }, { email: '', password: '' }]
  assert.deepStrictEqual(realAccounts(mixed), [{ email: 'real@x.com', password: 'p' }])
})
