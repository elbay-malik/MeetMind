import type { H3Event } from 'h3'
import type { AudioStore } from './audio-store'
import { createLocalAudioStore, type LocalAudioStore } from './local'
import { createR2AudioStore, type R2AudioStore } from './r2'

// Random per process when no secret is configured: fine for dev (grants only
// need to outlive one upload) and keeps forged URLs impossible by default.
let ephemeralSecret: string | null = null
function localSecret(configured: string): string {
  if (configured) return configured
  ephemeralSecret ??= crypto.randomUUID() + crypto.randomUUID()
  return ephemeralSecret
}

let announced = false
function announce(kind: AudioStore['kind']) {
  if (announced) return
  announced = true
  if (kind === 'local') {
    console.info('[meetmind] audio store: local filesystem (set NUXT_R2_* to use Cloudflare R2)')
  }
}

/**
 * Pick the audio store from runtime config: Cloudflare R2 when all four R2
 * settings are present, otherwise the local filesystem driver (dev/tests).
 * Callers needing local-only members (the upload route) narrow on `kind`.
 */
export function useAudioStore(event: H3Event): R2AudioStore | LocalAudioStore {
  const config = useRuntimeConfig(event)
  const r2Ready = config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket
  const store = r2Ready
    ? createR2AudioStore({
        accountId: config.r2AccountId,
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
        bucket: config.r2Bucket,
      })
    : createLocalAudioStore({
        dataDir: config.dataDir,
        secret: localSecret(config.uploadTokenSecret),
      })
  announce(store.kind)
  return store
}
