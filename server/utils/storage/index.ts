import type { H3Event } from 'h3'
import { selectDriver } from '../drivers'
import { createLocalAudioStore, type LocalAudioStore } from './local'
import { createR2AudioStore, type R2AudioStore } from './r2'

// Random per process when no secret is configured: fine for dev (grants only
// need to outlive one upload) and keeps forged URLs impossible by default. Only
// the local store asks for it, so R2 never reaches it, and a deployment has no
// local store (ADR-0016).
let ephemeralSecret: string | null = null
function localSecret(configured: string): string {
  if (configured) return configured
  ephemeralSecret ??= crypto.randomUUID() + crypto.randomUUID()
  return ephemeralSecret
}

/**
 * Pick the audio store: Cloudflare R2 when all four of its settings are present,
 * or the local filesystem where ADR-0016 allows that.
 * Callers needing local-only members (the upload route) narrow on `kind`.
 */
export function useAudioStore(event: H3Event): R2AudioStore | LocalAudioStore {
  return selectDriver<R2AudioStore | LocalAudioStore>(event, 'r2', {
    real: config => createR2AudioStore({
      accountId: config.r2AccountId,
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
      bucket: config.r2Bucket,
    }),
    local: config => createLocalAudioStore({
      dataDir: config.dataDir,
      secret: localSecret(config.uploadTokenSecret),
    }),
  })
}
