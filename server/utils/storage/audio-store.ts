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
 * store using a time-limited URL minted by the server.
 *
 * The server inspects and deletes objects, and from Phase 4 also reads them, to
 * hand the audio to the speech-to-text provider. Callers pass the size they will
 * accept: the cap checked at upload does not bind later, because an R2 object
 * stays writable for as long as its presigned PUT lives. The raw video still
 * never reaches any of this — only the audio the browser already compressed,
 * which was always destined for transcription.
 */
export interface AudioStore {
  readonly kind: 'r2' | 'local'
  presignPut(input: PresignPutInput): Promise<UploadInstructions>
  head(key: string): Promise<StoredObject | null>
  /**
   * The object's bytes, or `null` when it is not there. `maxBytes` is refused
   * before the body is buffered where the driver can tell in advance.
   */
  get(key: string, maxBytes?: number): Promise<StoredAudio | null>
  delete(key: string): Promise<void>
}

export interface StoredAudio extends StoredObject {
  bytes: Uint8Array
}
