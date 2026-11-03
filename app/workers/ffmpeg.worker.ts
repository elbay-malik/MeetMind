import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { FFMPEG_CORE_WASM_URL } from '../../shared/utils/ffmpeg-core'
import type { ExtractRequest, ExtractResponse, ExtractOptions } from './ffmpeg.protocol'

// Worker global scope: the DOM lib types `postMessage` with a targetOrigin
// parameter, so route through a narrow cast for the transfer-list signature.
const post = (message: ExtractResponse, transfer: Transferable[] = []) => {
  (globalThis as unknown as {
    postMessage: (m: ExtractResponse, t?: Transferable[]) => void
  }).postMessage(message, transfer)
}

let current: { ffmpeg: FFmpeg, jobId: string } | null = null

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
const TIME_RE = /\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/
const toSeconds = (m: RegExpMatchArray) =>
  Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])

async function newInstance(jobId: string, options: ExtractOptions): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg()
  post({ type: 'loading', jobId, phase: 'fetch-core' })
  await ffmpeg.load({
    coreURL: new URL('/ffmpeg/ffmpeg-core.js', self.location.origin).href,
    wasmURL: new URL(FFMPEG_CORE_WASM_URL, self.location.origin).href,
    ...(options.selfHostedClassWorker
      ? { classWorkerURL: new URL('/ffmpeg/esm/worker.js', self.location.origin).href }
      : {}),
  })
  post({ type: 'loading', jobId, phase: 'ready' })
  return ffmpeg
}

async function extract(jobId: string, file: File, options: ExtractOptions) {
  // Fresh instance per job: the WASM heap grows during exec and is never
  // reclaimed, so reusing an instance eventually OOMs at the 2 GB ceiling.
  const ffmpeg = await newInstance(jobId, options)
  current = { ffmpeg, jobId }
  const t0 = performance.now()
  let durationSec = 0

  ffmpeg.on('log', ({ type, message }) => {
    post({ type: 'log', jobId, stream: type as 'stdout' | 'stderr', message })
    if (!durationSec) {
      const d = message.match(DURATION_RE)
      if (d) {
        durationSec = toSeconds(d)
        post({ type: 'meta', jobId, durationSec })
      }
    }
    // stderr stats lines ("... time=00:12:34.56 ...") are the reliable
    // progress source; the progress event is known to emit bogus values.
    const t = message.match(TIME_RE)
    if (t && durationSec) {
      const outTimeSec = toSeconds(t)
      post({
        type: 'progress',
        jobId,
        ratio: Math.min(outTimeSec / durationSec, 1),
        outTimeSec,
        source: 'log',
      })
    }
  })

  ffmpeg.on('progress', ({ progress, time }) => {
    // Guard against out-of-range values (ffmpeg.wasm issue #600).
    if (progress >= 0 && progress <= 1) {
      post({ type: 'progress', jobId, ratio: progress, outTimeSec: time / 1e6, source: 'event' })
    }
  })

  // Normalize the filename without copying bytes (File wraps the same blob).
  const ext = file.name.match(/\.\w+$/)?.[0] ?? '.mp4'
  const input = new File([file], `input${ext}`, { type: file.type })
  const inputPath = options.mountMode === 'workerfs' ? `/work/${input.name}` : input.name

  if (options.mountMode === 'workerfs') {
    // mount() does not create the mount point — createDir first is mandatory.
    await ffmpeg.createDir('/work')
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [input] }, '/work')
  }
  else {
    // Debug path: copies the whole file into the WASM heap. Fixtures only.
    await ffmpeg.writeFile(input.name, new Uint8Array(await input.arrayBuffer()))
  }

  const rc = await ffmpeg.exec([
    '-i', inputPath,
    '-vn', '-sn', '-dn',
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libopus',
    '-b:a', '16k',
    ...(options.voipTuning ? ['-application', 'voip'] : []),
    'output.ogg',
  ], 20 * 60 * 1000)
  if (rc !== 0) throw new Error(`ffmpeg exited with code ${rc}`)

  const data = await ffmpeg.readFile('output.ogg') as Uint8Array
  if (options.mountMode === 'workerfs') await ffmpeg.unmount('/work')
  ffmpeg.terminate()
  current = null

  const buffer = data.buffer as ArrayBuffer
  post({ type: 'done', jobId, data: buffer, elapsedMs: performance.now() - t0 }, [buffer])
}

self.onmessage = async (event: MessageEvent<ExtractRequest>) => {
  const msg = event.data
  if (msg.type === 'cancel') {
    current?.ffmpeg.terminate()
    current = null
    return
  }
  try {
    await extract(msg.jobId, msg.file, msg.options)
  }
  catch (err) {
    current?.ffmpeg.terminate()
    current = null
    post({
      type: 'error',
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
