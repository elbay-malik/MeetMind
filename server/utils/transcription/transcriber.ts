export interface TranscribeInput {
  bytes: Uint8Array
  /** Media type of the audio, used for the upload part's filename and type. */
  contentType: string
  /** ISO-639-1 hint. Omitting it lets the model detect the language. */
  language?: string
}

/**
 * Turns compressed audio into a provider reply. Implemented by the real provider
 * and by a local stub, chosen the same way the storage and database drivers are,
 * so development and CI need no API key.
 */
export interface Transcriber {
  readonly kind: 'groq' | 'stub'
  /**
   * The reply as bytes, in the shape of Whisper's verbose_json, unparsed: it is
   * stored as it came and read back a page at a time (ADR-0012 §2), because
   * parsing a reply that grows with the meeting does not fit one request.
   */
  transcribe(input: TranscribeInput): Promise<Uint8Array>
}

/** Raised when the provider refuses the request; carries what the UI should say. */
export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    /** A 429's Retry-After, when the provider gave one or a default applies. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}
