import { describe, expect, it } from 'vitest'
import { signToken, verifyToken } from '../../server/utils/signed-token'

const secret = 'test-secret'

describe('signed tokens', () => {
  it('round-trips a payload', async () => {
    const token = await signToken({ key: 'meetings/x/audio.ogg', exp: 123 }, secret)
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(await verifyToken(token, secret)).toEqual({ key: 'meetings/x/audio.ogg', exp: 123 })
  })

  it('rejects a different secret', async () => {
    const token = await signToken({ a: 1 }, secret)
    expect(await verifyToken(token, 'other')).toBeNull()
  })

  it('rejects tampered payloads and signatures', async () => {
    const token = await signToken({ bytes: 10 }, secret)
    const [body, mac] = token.split('.') as [string, string]
    const forgedBody = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A')
    expect(await verifyToken(`${forgedBody}.${mac}`, secret)).toBeNull()
    const forgedMac = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A')
    expect(await verifyToken(`${body}.${forgedMac}`, secret)).toBeNull()
  })

  it('rejects malformed tokens without throwing', async () => {
    for (const bad of ['', 'nodot', '.', 'a.', '.b', 'a.b.c', 'a b.c', '%%%.###']) {
      expect(await verifyToken(bad, secret)).toBeNull()
    }
  })
})
