// AES-256-GCM,基于 Web Crypto(Workers 与 Node 18+ 均内置 globalThis.crypto.subtle)。
const enc = new TextEncoder()
const dec = new TextDecoder()

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(bytes) {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

async function importKey(keyBase64) {
  return crypto.subtle.importKey('raw', b64ToBytes(keyBase64), 'AES-GCM', false, [
    'encrypt', 'decrypt',
  ])
}

export async function encryptPassword(plaintext, keyBase64) {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return bytesToB64(iv) + ':' + bytesToB64(cipher)
}

export async function decryptPassword(encStr, keyBase64) {
  const [ivB64, cipherB64] = encStr.split(':')
  const key = await importKey(keyBase64)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(cipherB64),
  )
  return dec.decode(plain)
}
