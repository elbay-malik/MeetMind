/**
 * Compact HMAC-signed tokens (Web Crypto, so they work on Node and Cloudflare
 * Workers). Used to mint time-limited, single-purpose upload URLs for the
 * local audio store, mirroring what a presigned URL does for R2.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** Sign `payload` (any JSON value) into `<base64url(json)>.<base64url(hmac)>`. */
export async function signToken(payload: unknown, secret: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body))
  return `${body}.${toBase64Url(new Uint8Array(mac))}`
}

/**
 * Verify a token produced by {@link signToken} and return its payload, or
 * `null` when the signature does not match or the token is malformed.
 * Expiry is the caller's concern (the payload shape is theirs).
 */
export async function verifyToken<T = unknown>(token: string, secret: string): Promise<T | null> {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null
  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(mac)) return null
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(mac),
      encoder.encode(body),
    )
    if (!ok) return null
    return JSON.parse(decoder.decode(fromBase64Url(body))) as T
  }
  catch {
    return null
  }
}
