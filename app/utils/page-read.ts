/**
 * For a page's own reads. A 429 here is the rate rule's block, which lasts ten seconds, so
 * repeating the read at once only counts against it again. Other failures keep the default retry.
 */
export const PAGE_READ = { retryStatusCodes: [408, 409, 425, 500, 502, 503, 504] }

/** Past the rate rule's 10-second block, so that what is tried again by itself can work. */
export const PAGE_RETRY_MS = 11_000

/** So an outage does not read for as long as the tab stays open. */
export const PAGE_MAX_RETRIES = 3
