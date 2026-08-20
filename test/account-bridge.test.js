const test = require('node:test')
const assert = require('node:assert')

const {
  ACCOUNT_REQUEST, registerLoginScript, clearLoginScript, serveAccount,
} = require('../src/account-bridge')

function fakeIpcMain() {
  const handlers = {}
  return {
    on(channel, fn) { handlers[channel] = fn },
    removeAllListeners(channel) { delete handlers[channel] },
    emitSync(channel, senderId) {
      const event = { sender: { id: senderId }, returnValue: undefined }
      handlers[channel](event)
      return event.returnValue
    },
  }
}

test('serveAccount returns the registered script for that sender, null otherwise', () => {
  const ipc = fakeIpcMain()
  serveAccount(ipc)
  assert.strictEqual(ipc.emitSync(ACCOUNT_REQUEST, 7), null)
  registerLoginScript(7, 'SCRIPT')
  assert.deepStrictEqual(ipc.emitSync(ACCOUNT_REQUEST, 7), { loginScript: 'SCRIPT' })
  assert.strictEqual(ipc.emitSync(ACCOUNT_REQUEST, 8), null)
  clearLoginScript(7)
  assert.strictEqual(ipc.emitSync(ACCOUNT_REQUEST, 7), null)
})
