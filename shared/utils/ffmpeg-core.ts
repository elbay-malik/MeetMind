/**
 * The ffmpeg core the browser runs, and where a Worker finds its wasm (ADR-0018).
 *
 * The version names both the object in R2 and the URL the browser asks for, and that URL is
 * cached as immutable, so each has to change with the installed package.
 * tests/unit/ffmpeg-core.spec.ts holds this to `@ffmpeg/core`, and the upload script refuses a
 * difference: the script glue ships with a deploy and the wasm does not, so a stale wasm would
 * otherwise be served silently under the new glue.
 */
export const FFMPEG_CORE_VERSION = '0.12.10'

/** The one object the route serves. Outside `meetings/`, so the lifecycle rule leaves it alone. */
export const FFMPEG_CORE_WASM_KEY = `assets/ffmpeg/${FFMPEG_CORE_VERSION}/ffmpeg-core.wasm`

/** Over the 25 MiB asset limit, so a Worker build leaves it out and a route answers here instead. */
export const FFMPEG_CORE_WASM_PATH = '/ffmpeg/ffmpeg-core.wasm'

/** What the browser asks for. The query is what a new version's URL differs by. */
export const FFMPEG_CORE_WASM_URL = `${FFMPEG_CORE_WASM_PATH}?v=${FFMPEG_CORE_VERSION}`

/**
 * What the upload page and the README say of it. The licence is the one the package declares, which
 * tests/unit/ffmpeg-core.spec.ts holds to it. The source is the commit that released this version
 * of the core: the repo's tag of the same number is a release of its wrapper, with an older core.
 */
export const FFMPEG_CORE_PACKAGE = '@ffmpeg/core'
export const FFMPEG_CORE_LICENSE = 'GPL-2.0-or-later'
export const FFMPEG_CORE_SOURCE_URL = 'https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1'
