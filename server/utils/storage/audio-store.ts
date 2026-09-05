import type { UploadInstructions } from '#shared/types/meeting'

export interface PresignPutInput {
  key: string
  contentType: string
  contentLength: number
  /** Seconds the upload URL stays valid. */
  expiresInSec: number
}

export interface StoredObject {
  size: number
  contentType: string | null
}

/**
 * Where compressed meeting audio lives. The browser uploads straight to the
 * store using a time-limited URL minted by the server; the server itself only
 * ever inspects or deletes objects — it never proxies audio bytes in
 * production (R2). The local driver stands in when R2 is not configured.
 */
export interface AudioStore {
  readonly kind: 'r2' | 'local'
  presignPut(input: PresignPutInput): Promise<UploadInstructions>
  head(key: string): Promise<StoredObject | null>
  delete(key: string): Promise<void>
}
