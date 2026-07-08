// Copies the self-hosted ffmpeg.wasm assets into public/ffmpeg/ (gitignored).
// Runs on postinstall so dev, build and CI all serve the core same-origin —
// loading it from a CDN is not an option once cross-origin rules get involved.
import { cp, mkdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const dest = new URL('public/ffmpeg/', root)
await mkdir(dest, { recursive: true })

// Single-thread core (ESM build — the wrapper's module worker imports it).
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp(new URL(`node_modules/@ffmpeg/core/dist/esm/${f}`, root), new URL(f, dest))
}

// @ffmpeg/ffmpeg's own ESM worker + sibling modules it imports (const.js,
// errors.js). Served as the classWorkerURL escape hatch if the bundler
// mishandles the wrapper's nested worker in production builds.
await cp(
  new URL('node_modules/@ffmpeg/ffmpeg/dist/esm/', root),
  new URL('esm/', dest),
  { recursive: true },
)

console.log('[copy-ffmpeg-core] assets copied to public/ffmpeg/')
