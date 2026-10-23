import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import { RangeNotSatisfiableError } from './audio-store'
import type {
  AudioStore,
  ByteWindow,
  OpenedAudio,
  PresignPutInput,
  StoredAudio,
  StoredObject,
} from './audio-store'
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
      // Modification time plus size changes whenever the bytes do, which a
      // size-only validator would not.
      const mtime = stat.mtime instanceof Date ? stat.mtime.getTime() : 0
      return { size, contentType: meta?.contentType ?? null, etag: `"${mtime.toString(36)}-${size}"` }
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
      return { bytes, size: bytes.byteLength, contentType: meta?.contentType ?? null, etag: null }
    },

    async openRange(key, window: ByteWindow | null): Promise<OpenedAudio | null> {
      // Straight to the file: unstorage has no streaming read, and buffering a
      // whole object per range request is what this method exists to avoid. The
      // fs driver stores a key at <base>/<key with slashes as directories>.
      //
      // node:fs and node:stream are imported here, not at module scope, for the
      // same reason the fs driver is: server/utils/storage/index.ts imports this
      // file unconditionally, so a top-level Node import would be evaluated on
      // deploy targets that have no such modules even when R2 is the driver.
      const [{ createReadStream }, { stat }, { Readable }] = await Promise.all([
        import('node:fs'),
        import('node:fs/promises'),
        import('node:stream'),
      ])

      const path = join(base, ...key.split('/'))
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) return null

      // A window starting at or past the end cannot be served. R2 answers 416
      // here, and a caller that behaves differently per driver would make the
      // local tier useless for proving the route -- so mirror it. An empty
      // object is exempt: there is no satisfiable window at all, and the empty
      // stream below is the honest answer.
      if (window && info.size > 0 && window.start >= info.size) {
        throw new RangeNotSatisfiableError(info.size)
      }

      // end = -1 for an empty object: an inclusive window cannot say 'nothing'
      // any other way, and rounding it to one byte promises a byte we lack.
      //
      // Clamped to the real end, because `served` is what the caller turns into
      // content-length. createReadStream tolerates an `end` past EOF and simply
      // stops early, so an unclamped window would announce more bytes than the
      // stream ever sends -- a truncated response the client cannot tell from a
      // dropped connection. R2 clamps for us by reporting Content-Range; here
      // it has to be done by hand.
      const served: ByteWindow = window
        ? { start: window.start, end: Math.min(window.end, info.size - 1) }
        : { start: 0, end: info.size - 1 }
      const meta = await (await storage()).getItem<ObjectMeta>(metaKey(key))
      // createReadStream rejects a negative end, so an empty window has to be
      // served as an empty stream rather than asked of the filesystem.
      const body: ReadableStream<Uint8Array> = served.end < served.start
        ? new ReadableStream({
            start(controller) {
              controller.close()
            },
          })
        : Readable.toWeb(createReadStream(path, { start: served.start, end: served.end })) as ReadableStream<Uint8Array>

      return {
        body,
        size: info.size,
        contentType: meta?.contentType ?? null,
        window: served,
        // Same shape as `head`'s: modification time plus size, so a replacement
        // of equal length is still a cache miss.
        etag: `"${(info.mtime instanceof Date ? info.mtime.getTime() : 0).toString(36)}-${info.size}"`,
      }
    },

    async delete(key) {
      const s = await storage()
      await s.removeItem(key)
      await s.removeItem(metaKey(key))
    },
  }
}
