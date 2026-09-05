import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { AudioStore, PresignPutInput, StoredAudio, StoredObject } from './audio-store'
import { signToken, verifyToken } from '../signed-token'

/** Payload of a local upload URL token — the moral equivalent of a presigned PUT. */
export interface LocalUploadGrant {
  v: 1
  key: string
  contentType: string
  contentLength: number
  /** Expiry as Unix seconds. */
  exp: number
}

interface ObjectMeta {
  contentType: string
  size: number
}

const storages = new Map<string, Promise<Storage>>()

/**
 * The fs driver is imported lazily so the Cloudflare bundle never evaluates
 * `node:fs` at startup — the local store is only ever used where R2 is absent.
 */
function storageFor(base: string): Promise<Storage> {
  let existing = storages.get(base)
  if (!existing) {
    existing = import('unstorage/drivers/fs').then(({ default: fsDriver }) =>
      createStorage({ driver: fsDriver({ base }) }))
    storages.set(base, existing)
  }
  return existing
}

const metaKey = (key: string) => `${key}.meta`

export interface LocalAudioStore extends AudioStore {
  readonly kind: 'local'
  /** Validate an upload URL token; `null` when forged, malformed or expired. */
  verifyGrant(token: string, nowMs?: number): Promise<LocalUploadGrant | null>
  /** Write the uploaded bytes (called by the local upload route). */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
}

export function createLocalAudioStore(options: { dataDir: string, secret: string }): LocalAudioStore {
  const base = join(options.dataDir, 'audio')
  const storage = () => storageFor(base)

  return {
    kind: 'local',

    async presignPut(input: PresignPutInput) {
      const exp = Math.floor(Date.now() / 1000) + input.expiresInSec
      const grant: LocalUploadGrant = {
        v: 1,
        key: input.key,
        contentType: input.contentType,
        contentLength: input.contentLength,
        exp,
      }
      const token = await signToken(grant, options.secret)
      return {
        // Same-origin relative URL; the browser resolves it against the page.
        url: `/api/uploads/${token}`,
        method: 'PUT' as const,
        headers: { 'content-type': input.contentType },
        expiresAt: new Date(exp * 1000).toISOString(),
      }
    },

    async verifyGrant(token, nowMs = Date.now()) {
      const grant = await verifyToken<LocalUploadGrant>(token, options.secret)
      // The grant is the upload route's whole contract, so validate every field
      // rather than trusting the signature to imply a well-formed payload: a
      // token minted before a shape change would still verify.
      if (!grant || typeof grant !== 'object') return null
      if (grant.v !== 1) return null
      if (typeof grant.key !== 'string' || !grant.key) return null
      if (typeof grant.contentType !== 'string' || !grant.contentType) return null
      if (!Number.isInteger(grant.contentLength) || grant.contentLength < 0) return null
      if (typeof grant.exp !== 'number' || !Number.isFinite(grant.exp)) return null
      if (grant.exp * 1000 <= nowMs) return null
      return grant
    },

    async put(key, body, contentType) {
      const s = await storage()
      await s.setItemRaw(key, body)
      await s.setItem<ObjectMeta>(metaKey(key), { contentType, size: body.byteLength })
    },

    async head(key): Promise<StoredObject | null> {
      const s = await storage()
      if (!(await s.hasItem(key))) return null
      const meta = await s.getItem<ObjectMeta>(metaKey(key))
      const stat = await s.getMeta(key)
      const size = typeof stat.size === 'number' ? stat.size : meta?.size ?? 0
      return { size, contentType: meta?.contentType ?? null }
    },

    async get(key, maxBytes): Promise<StoredAudio | null> {
      const s = await storage()
      const raw = await s.getItemRaw<Uint8Array>(key)
      if (!raw) return null
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
        throw new Error(`Object ${key} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit`)
      }
      const meta = await s.getItem<ObjectMeta>(metaKey(key))
      return { bytes, size: bytes.byteLength, contentType: meta?.contentType ?? null }
    },

    async delete(key) {
      const s = await storage()
      await s.removeItem(key)
      await s.removeItem(metaKey(key))
    },
  }
}
