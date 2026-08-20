const fs = require('node:fs')
const path = require('node:path')

const EXAMPLE_EMAILS = new Set(['example1@mail.com', 'example2@mail.com'])
const EXAMPLE_PASSWORD = '改成你的密码'

const DEFAULT_TEMPLATE = JSON.stringify(
  {
    avoidRepeatLast: true,
    accounts: [
      { email: 'example1@mail.com', password: '改成你的密码' },
      { email: 'example2@mail.com', password: '改成你的密码' },
    ],
  },
  null,
  2,
)

function accountsFile(desktopDir) {
  return path.join(desktopDir, 'genspark-accounts.json')
}

function ensureAccountsFile(file) {
  if (fs.existsSync(file)) return false
  try {
    fs.writeFileSync(file, DEFAULT_TEMPLATE)
    return true
  } catch (err) {
    console.error(`[accounts] cannot write ${file}:`, err.message)
    return false
  }
}

function loadAccounts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
    return { avoidRepeatLast: parsed.avoidRepeatLast !== false, accounts }
  } catch {
    return { avoidRepeatLast: true, accounts: [] }
  }
}

function isExampleAccount(a) {
  return EXAMPLE_EMAILS.has(a.email) || a.password === EXAMPLE_PASSWORD
}

function realAccounts(accounts) {
  return accounts.filter((a) => a && a.email && a.password && !isExampleAccount(a))
}

module.exports = {
  EXAMPLE_EMAILS, EXAMPLE_PASSWORD, DEFAULT_TEMPLATE,
  accountsFile, ensureAccountsFile, loadAccounts, isExampleAccount, realAccounts,
}
