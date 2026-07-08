/**
 * Message protocol between the main thread and the ffmpeg orchestration
 * worker. The worker owns the ffmpeg.wasm lifecycle; the main thread only
 * sends jobs and renders the streamed status.
 */

export interface ExtractOptions {
  /**
   * How the input reaches the WASM FS. WORKERFS reads the File in place and
   * keeps it out of the 2 GB WASM heap; MEMFS copies it in (~2x file size)
   * and exists only as a debug/A-B path for small fixtures.
   */
  mountMode: 'workerfs' | 'memfs'
  /**
   * Load @ffmpeg/ffmpeg's internal worker from the self-hosted copy at
   * /ffmpeg/esm/worker.js instead of the bundler-resolved chunk. Escape
   * hatch for production builds that mangle the nested worker.
   */
  selfHostedClassWorker: boolean
  /** Encode with libopus' speech-tuned mode (`-application voip`). */
  voipTuning: boolean
}

export type ExtractRequest
  = | { type: 'extract', jobId: string, file: File, options: ExtractOptions }
    | { type: 'cancel' }

export type ExtractResponse
  = | { type: 'loading', jobId: string, phase: 'fetch-core' | 'ready' }
    | { type: 'meta', jobId: string, durationSec: number }
    | { type: 'progress', jobId: string, ratio: number, outTimeSec: number, source: 'event' | 'log' }
    | { type: 'log', jobId: string, stream: 'stdout' | 'stderr', message: string }
    | { type: 'done', jobId: string, data: ArrayBuffer, elapsedMs: number }
    | { type: 'error', jobId: string, message: string }
