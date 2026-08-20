const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

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

function partitionName(email) {
  const hash = crypto.createHash('sha1').update(email).digest('hex').slice(0, 12)
  return `persist:acct-${hash}`
}

function pickAccount(accounts, opts = {}) {
  if (!accounts.length) return null
  const random = opts.random || Math.random
  let pool = accounts
  if (opts.avoidRepeatLast && accounts.length >= 2 && opts.lastEmail) {
    const filtered = accounts.filter((a) => a.email !== opts.lastEmail)
    if (filtered.length) pool = filtered
  }
  return pool[Math.floor(random() * pool.length)]
}

function lastAccountFile(userDataDir) {
  return path.join(userDataDir, 'last-account.json')
}

function readLastEmail(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).email || null
  } catch {
    return null
  }
}

function writeLastEmail(file, email) {
  try {
    fs.writeFileSync(file, JSON.stringify({ email }))
  } catch (err) {
    console.error(`[accounts] cannot write ${file}:`, err.message)
  }
}

module.exports = {
  EXAMPLE_EMAILS, EXAMPLE_PASSWORD, DEFAULT_TEMPLATE,
  accountsFile, ensureAccountsFile, loadAccounts, isExampleAccount, realAccounts,
  partitionName, pickAccount, lastAccountFile, readLastEmail, writeLastEmail,
}
