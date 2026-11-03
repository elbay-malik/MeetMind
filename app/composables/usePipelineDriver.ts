import type { PipelineResponse } from '#shared/types/meeting'
import {
  createPipelineDriver,
  initialDriverState,
  type DriverFetch,
  type DriverLocks,
  type DriverState,
  type PipelineDriver,
} from '~/utils/pipeline-driver'
import { softLocks } from '~/utils/soft-locks'

const setTimer = (fire: () => void, ms: number): unknown => setTimeout(fire, ms)
const clearTimer = (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)

/** Refused storage throws on merely touching `window.localStorage`. */
function browserStorageOrNull(): Storage | null {
  try {
    return window.localStorage
  }
  catch {
    return null
  }
}

/**
 * The real lock where there is one. Undefined over plain http and in old browsers, and there a
 * lease in storage stands in, so tabs do not each ask about the same steps (ADR-0012's step 10
 * addendum). `navigator.locks.request` needs `navigator.locks` as its `this`.
 */
function browserLocks(): DriverLocks {
  const real = (navigator as { locks?: DriverLocks }).locks
  return real ?? softLocks({ storage: browserStorageOrNull(), now: Date.now, setTimer, clearTimer, random: Math.random })
}

/** `$fetch` for what the app's requests share, told to retry nothing and throw nothing: retrying is the driver's. */
const browserFetch: DriverFetch = async (url, { method, signal }) => {
  const res = await $fetch.raw(url, { method, signal, retry: false, ignoreResponseError: true })
  return { status: res.status, headers: res.headers, json: async () => res._data }
}

/**
 * Drive one meeting from the page it is open on (ADR-0012 §1): the logic is in
 * `utils/pipeline-driver.ts`, and this gives it a browser and gives Vue its state.
 *
 * Nothing starts until the component mounts. The server's render and the first client render
 * therefore see the same state and hold no time, and no lock or timer code ever runs on the
 * server. `now` stays 0 until then, for anything that has to say how long is left.
 */
export function usePipelineDriver(meetingId: string, options: { initial: PipelineResponse | null, readOnly: boolean }) {
  const state = shallowRef<DriverState>(initialDriverState(options.initial, options.readOnly))
  const now = ref(0)

  let driver: PipelineDriver | null = null
  let ticking: ReturnType<typeof setInterval> | null = null

  /** Only while something on the page is counting: a finished page wakes nothing. */
  function setTicking() {
    const { nextRequestAt, retryFrom } = state.value
    const needed = driver !== null && (nextRequestAt !== null || (retryFrom !== null && retryFrom > Date.now()))
    if (needed && !ticking) {
      ticking = setInterval(() => {
        now.value = Date.now()
        setTicking()
      }, 1000)
    }
    else if (!needed && ticking) {
      clearInterval(ticking)
      ticking = null
    }
  }

  function onPageHide() {
    // A page holding a lock cannot go in the back-forward cache, and a page that is in it
    // should not be holding up another tab or asking for anything.
    driver?.stop()
  }
  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted) driver?.start()
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') driver?.wake('visible')
  }
  function onOnline() {
    driver?.wake('online')
  }

  onMounted(() => {
    now.value = Date.now()
    driver = createPipelineDriver({
      meetingId,
      initial: options.initial,
      readOnly: options.readOnly,
      fetch: browserFetch,
      locks: browserLocks(),
      now: Date.now,
      setTimer,
      clearTimer,
      random: Math.random,
      onChange(next) {
        now.value = Date.now()
        state.value = next
        setTicking()
      },
    })
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibilityChange)
    driver.start()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    driver?.stop()
    driver = null
    setTicking()
  })

  return {
    state,
    now,
    retry: () => driver?.retry(),
    rebuildIndex: () => driver?.rebuildIndex(),
  }
}
