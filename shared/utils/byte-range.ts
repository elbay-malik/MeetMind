/**
 * A single HTTP byte range, resolved against a known object size.
 * `end` is inclusive, as it is on the wire.
 */
export interface ByteRange {
  start: number
  end: number
}

export type ByteRangeResult
  /** No usable range: answer 200 with the whole body. */
  = | { kind: 'full' }
    /** Answer 206 with exactly these bytes. */
    | { kind: 'partial', range: ByteRange }
    /** Answer 416 with `Content-Range: bytes ~/<size>`. */
    | { kind: 'unsatisfiable' }

/**
 * Parse a `Range` request header for a resource of `size` bytes.
 *
 * Only `bytes` ranges are recognised, and only a single one. RFC 9110 allows a
 * server to ignore a Range header it does not want to honour, and no media
 * element sends a multi-range request, so anything unusual degrades to a plain
 * 200 rather than an error.
 *
 * Getting this wrong is quiet rather than loud: without a correct 206 the
 * browser reports no seekable ranges, and seeking silently snaps to the start
 * instead of failing.
 */
export function parseByteRange(header: string | undefined | null, size: number): ByteRangeResult {
  if (!header) return { kind: 'full' }
  if (!Number.isInteger(size) || size < 0) return { kind: 'full' }

  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (!match) return { kind: 'full' }

  const specs = match[1]!.split(',')
  // Multi-range would need a multipart/byteranges body for no practical gain.
  if (specs.length !== 1) return { kind: 'full' }

  const spec = specs[0]!.trim()
  const suffix = /^-(\d+)$/.exec(spec)
  if (suffix) {
    // `-N` means the last N bytes.
    const wanted = Number(suffix[1])
    if (wanted === 0) return { kind: 'unsatisfiable' }
    if (size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', range: { start: Math.max(0, size - wanted), end: size - 1 } }
  }

  const explicit = /^(\d+)-(\d*)$/.exec(spec)
  if (!explicit) return { kind: 'full' }

  const start = Number(explicit[1])
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' }

  // An open-ended `N-` runs to the end; browsers send this form almost always.
  const end = explicit[2] === '' ? size - 1 : Math.min(Number(explicit[2]), size - 1)
  if (end < start) return { kind: 'unsatisfiable' }

  return { kind: 'partial', range: { start, end } }
}

/** Length in bytes of an inclusive range. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1
}

/** The `Content-Range` value for a 206 response. */
export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}
