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
  // 先把格式挡住:密文列被截断、或者干脆存进了别的东西时,不做检查就会一路
  // 掉进 Web Crypto 里抛出一个跟原因毫无关系的错误(atob 的 InvalidCharacter、
  // 或者 iv 长度不对)。这里给一个可预期的失败,调用方才好分辨。
  const parts = String(encStr ?? '').split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('decryptPassword: expected "iv_b64:cipher_b64"')
  }
  const [ivB64, cipherB64] = parts
  const key = await importKey(keyBase64)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(cipherB64),
  )
  return dec.decode(plain)
}
