import type { ExtractOptions, ExtractRequest, ExtractResponse } from '../workers/ffmpeg.protocol'

export type ExtractStatus
  = 'idle' | 'loading-core' | 'probing' | 'extracting' | 'done' | 'error' | 'cancelled'

export interface ExtractState {
  status: ExtractStatus
  fileName: string | null
  fileBytes: number
  durationSec: number | null
  ratio: number
  outTimeSec: number
  progressSource: 'event' | 'log' | null
  elapsedMs: number
  outputBytes: number
  outputUrl: string | null
  error: string | null
  logs: string[]
  jsHeapPeakMB: number | null
}

export interface RunMeasurement {
  startedAt: string
  inputName: string
  inputMB: number
  durationSec: number | null
  mountMode: ExtractOptions['mountMode']
  wallClockMs: number
  outputMB: number | null
  realizedKbps: number | null
  jsHeapPeakMB: number | null
  result: 'done' | 'error' | 'cancelled'
  note: string
}

const MAX_LOG_LINES = 200

/**
 * Client-only composable driving the ffmpeg orchestration worker.
 * One worker instance per composable call; one job at a time.
 */
export function useAudioExtract() {
  const state = reactive<ExtractState>({
    status: 'idle',
    fileName: null,
    fileBytes: 0,
    durationSec: null,
    ratio: 0,
    outTimeSec: 0,
    progressSource: null,
    elapsedMs: 0,
    outputBytes: 0,
    outputUrl: null,
    error: null,
    logs: [],
    jsHeapPeakMB: null,
  })
  const measurements = ref<RunMeasurement[]>([])

  let worker: Worker | null = null
  let activeJobId: string | null = null
  let activeOptions: ExtractOptions | null = null
  let startedAtIso = ''
  let ticker: ReturnType<typeof setInterval> | null = null
  let heapSampler: ReturnType<typeof setInterval> | null = null
  let t0 = 0

  function sampleHeap() {
    // Non-standard, Chromium-only, renderer-wide approximation. The
    // authoritative reading is Chrome's Task Manager, done manually.
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    if (!memory) return
    const usedMB = memory.usedJSHeapSize / (1024 * 1024)
    state.jsHeapPeakMB = Math.max(state.jsHeapPeakMB ?? 0, Math.round(usedMB))
  }

  function stopTimers() {
    if (ticker) clearInterval(ticker)
    if (heapSampler) clearInterval(heapSampler)
    ticker = null
    heapSampler = null
  }

  function recordRun(result: RunMeasurement['result'], note = '') {
    measurements.value.push({
      startedAt: startedAtIso,
      inputName: state.fileName ?? '?',
      inputMB: Number((state.fileBytes / (1024 * 1024)).toFixed(1)),
      durationSec: state.durationSec,
      mountMode: activeOptions?.mountMode ?? 'workerfs',
      wallClockMs: Math.round(state.elapsedMs),
      outputMB: result === 'done' ? Number((state.outputBytes / (1024 * 1024)).toFixed(2)) : null,
      realizedKbps: result === 'done' && state.durationSec
        ? Number(((state.outputBytes * 8) / state.durationSec / 1000).toFixed(1))
        : null,
      jsHeapPeakMB: state.jsHeapPeakMB,
      result,
      note,
    })
  }

  function onMessage(event: MessageEvent<ExtractResponse>) {
    const msg = event.data
    if (msg.jobId !== activeJobId) return
    switch (msg.type) {
      case 'loading':
        state.status = msg.phase === 'fetch-core' ? 'loading-core' : 'probing'
        break
      case 'meta':
        state.durationSec = msg.durationSec
        break
      case 'progress':
        state.status = 'extracting'
        // Prefer log-derived progress unless only the event source reports.
        if (msg.source === 'log' || state.progressSource !== 'log') {
          state.ratio = msg.ratio
          state.outTimeSec = msg.outTimeSec
          state.progressSource = msg.source
        }
        break
      case 'log':
        state.logs.push(`[${msg.stream}] ${msg.message}`)
        if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES)
        break
      case 'done': {
        state.elapsedMs = msg.elapsedMs
        state.outputBytes = msg.data.byteLength
        if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
        state.outputUrl = URL.createObjectURL(
          new Blob([msg.data], { type: 'audio/ogg; codecs=opus' }),
        )
        state.ratio = 1
        state.status = 'done'
        stopTimers()
        recordRun('done')
        activeJobId = null
        break
      }
      case 'error':
        state.elapsedMs = performance.now() - t0
        state.error = msg.message
        state.status = 'error'
        stopTimers()
        recordRun('error', msg.message)
        activeJobId = null
        break
    }
  }

  function ensureWorker(): Worker {
    if (!worker) {
      worker = new Worker(
        new URL('../workers/ffmpeg.worker.ts', import.meta.url),
        { type: 'module' },
      )
      worker.onmessage = onMessage
    }
    return worker
  }

  function extract(file: File, options: ExtractOptions) {
    if (!import.meta.client || activeJobId) return
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
    Object.assign(state, {
      status: 'loading-core',
      fileName: file.name,
      fileBytes: file.size,
      durationSec: null,
      ratio: 0,
      outTimeSec: 0,
      progressSource: null,
      elapsedMs: 0,
      outputBytes: 0,
      outputUrl: null,
      error: null,
      logs: [],
      jsHeapPeakMB: null,
    } satisfies Partial<ExtractState>)

    activeJobId = crypto.randomUUID()
    activeOptions = options
    startedAtIso = new Date().toISOString()
    t0 = performance.now()
    ticker = setInterval(() => {
      state.elapsedMs = performance.now() - t0
    }, 250)
    sampleHeap() // immediate baseline; fast runs may finish before the interval fires
    heapSampler = setInterval(sampleHeap, 1000)

    const request: ExtractRequest = { type: 'extract', jobId: activeJobId, file, options }
    ensureWorker().postMessage(request)
  }

  function cancel() {
    if (!activeJobId) return
    ensureWorker().postMessage({ type: 'cancel' } satisfies ExtractRequest)
    state.elapsedMs = performance.now() - t0
    state.status = 'cancelled'
    stopTimers()
    recordRun('cancelled')
    activeJobId = null
  }

  onUnmounted(() => {
    stopTimers()
    worker?.terminate()
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
  })

  return { state, measurements, extract, cancel }
}
