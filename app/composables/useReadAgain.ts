/**
 * Read something that failed again by itself once the block has passed, a few times at most.
 * Only in the browser: a timer started while rendering on the server would outlive the request.
 */
export function useReadAgain(failed: () => boolean, read: () => Promise<unknown>) {
  let tries = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule() {
    if (tries >= PAGE_MAX_RETRIES) return
    timer = setTimeout(async () => {
      tries++
      await read()
      if (failed()) schedule()
    }, PAGE_RETRY_MS)
  }

  onMounted(() => {
    watch(failed, (now) => {
      clearTimeout(timer)
      if (now) schedule()
      else tries = 0
    }, { immediate: true })
  })
  onBeforeUnmount(() => clearTimeout(timer))
}
