/**
 * For a page's own reads. A 429 here is the rate rule's block, which lasts ten seconds, so
 * repeating the read at once only counts against it again. Other failures keep the default retry.
 */
export const PAGE_READ = { retryStatusCodes: [408, 409, 425, 500, 502, 503, 504] }
