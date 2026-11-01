import type { CreateMeetingInput, CreateMeetingResponse, Meeting } from '#shared/types/meeting'

export type UploadStatus
  = 'idle' | 'registering' | 'uploading' | 'confirming' | 'done' | 'cancelled' | 'error'

export interface UploadState {
  status: UploadStatus
  /** Bytes sent so far over bytes total, 0..1. */
  ratio: number
  sentBytes: number
  totalBytes: number
  meeting: Meeting | null
  error: string | null
}

/** Thrown when the user aborts the transfer — an outcome, not a fault. */
class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelled'
  }
}

export interface UploadJob {
  audio: Blob
  meta: Omit<CreateMeetingInput, 'audioBytes'>
}

/**
 * Sends browser-compressed audio to storage in three steps: register the
 * meeting (server mints a one-shot upload URL), PUT the blob straight to that
 * URL with progress, then ask the server to confirm what landed.
 */
export function useMeetingUpload() {
  const state = reactive<UploadState>({
    status: 'idle',
    ratio: 0,
    sentBytes: 0,
    totalBytes: 0,
    meeting: null,
    error: null,
  })

  const notRemembered = useNotRememberedMeetings()

  let xhr: XMLHttpRequest | null = null

  const busy = computed(() => ['registering', 'uploading', 'confirming'].includes(state.status))

  function putWithProgress(url: string, headers: Record<string, string>, body: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest()
      xhr = request
      // Listeners go on before open(), otherwise progress events may not fire.
      request.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        state.sentBytes = e.loaded
        state.totalBytes = e.total
        state.ratio = e.total ? e.loaded / e.total : 0
      }
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          state.ratio = 1
          resolve()
        }
        else {
          reject(new Error(`Storage rejected the upload (HTTP ${request.status})`))
        }
      }
      request.onerror = () => reject(new Error('Network error while uploading audio'))
      request.onabort = () => reject(new UploadCancelled())
      request.open('PUT', new URL(url, window.location.origin).href)
      // Set explicitly so the stored media type is exactly what the server granted.
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
      request.send(body)
    })
  }

  async function upload(job: UploadJob): Promise<Meeting | null> {
    if (busy.value) return null
    Object.assign(state, {
      status: 'registering',
      ratio: 0,
      sentBytes: 0,
      totalBytes: job.audio.size,
      meeting: null,
      error: null,
    } satisfies Partial<UploadState>)

    try {
      const created = await $fetch<CreateMeetingResponse>('/api/meetings', {
        method: 'POST',
        body: { ...job.meta, audioBytes: job.audio.size } satisfies CreateMeetingInput,
      })
      state.meeting = created.meeting
      // Now, not on success: the row exists from here on, and this browser's list
      // is the only place that will ever remember its link (ADR-0013).
      if (!rememberLocalMeeting(browserStorage(), created.meeting)) {
        notRemembered.value = [...notRemembered.value, created.meeting.id]
      }

      state.status = 'uploading'
      await putWithProgress(created.upload.url, created.upload.headers, job.audio)

      state.status = 'confirming'
      const confirmed = await $fetch<{ meeting: Meeting }>(
        `/api/meetings/${created.meeting.id}/complete`,
        { method: 'POST' },
      )
      state.meeting = confirmed.meeting
      state.status = 'done'
      return confirmed.meeting
    }
    catch (err) {
      if (err instanceof UploadCancelled) {
        // The user asked for this; show it as a stopped upload, not a failure.
        state.status = 'cancelled'
        state.error = null
      }
      else {
        state.error = describeError(err)
        state.status = 'error'
      }
      return null
    }
    finally {
      xhr = null
    }
  }

  function cancel() {
    xhr?.abort()
  }

  /** Clear the outcome of a previous attempt. Refuses to discard a live one. */
  function reset() {
    if (busy.value) return
    Object.assign(state, {
      status: 'idle',
      ratio: 0,
      sentBytes: 0,
      totalBytes: 0,
      meeting: null,
      error: null,
    } satisfies Partial<UploadState>)
  }

  onUnmounted(cancel)

  return { state, busy, upload, cancel, reset }
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: { message?: string, statusMessage?: string } }).data
    if (data?.message) return data.message
    if (data?.statusMessage) return data.statusMessage
  }
  return err instanceof Error ? err.message : String(err)
}
