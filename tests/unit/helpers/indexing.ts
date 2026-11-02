import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import type { Meeting, MeetingStatus, TranscriptSegment } from '../../../shared/types/meeting'
import { createLocalMeetingRepository } from '../../../server/utils/db/local'
import { createLocalPipelineRepository } from '../../../server/utils/db/pipeline-local'
import { createLocalSlotRepository } from '../../../server/utils/db/slots-local'
import { createLocalTranscriptRepository } from '../../../server/utils/db/transcripts-local'
import { createLocalTranscriptIndexRepository } from '../../../server/utils/db/windows-local'
import type { Embedder } from '../../../server/utils/qa/embedder'
import { advanceIndexing, type IndexingDeps, type IndexingOutcome } from '../../../server/utils/qa/steps'

/** The local drivers an indexing step runs on, over one data directory, with a clock a test can move. */
export function indexingHarness(dataDir: () => string) {
  const repos = () => ({
    meetings: createLocalMeetingRepository({ dataDir: dataDir() }),
    pipeline: createLocalPipelineRepository({ dataDir: dataDir() }),
    transcripts: createLocalTranscriptRepository({ dataDir: dataDir() }),
    index: createLocalTranscriptIndexRepository({ dataDir: dataDir() }),
    slots: createLocalSlotRepository({ dataDir: dataDir() }),
  })
  const db = () => createStorage({ driver: fsDriver({ base: join(dataDir(), 'db') }) })

  let offset = 0
  const now = () => Date.now() + offset
  const advanceClock = (ms: number) => {
    offset += ms
  }
  const resetClock = () => {
    offset = 0
  }

  async function meetingWith(id: string, segments: TranscriptSegment[], status: MeetingStatus = 'ready', patch: Partial<Meeting> = {}): Promise<Meeting> {
    const { meetings, transcripts } = repos()
    const meeting = await meetings.create({
      id,
      title: 'Planning',
      status,
      sourceFileName: 'planning.m4a',
      sourceBytes: 1000,
      sourceMime: 'audio/mp4',
      durationSec: 60,
      audioKey: `meetings/${id}/audio.ogg`,
      audioBytes: 500,
      audioMime: 'audio/ogg',
      uploadedAt: new Date().toISOString(),
      errorMessage: null,
      failedStage: null,
      ...patch,
    })
    await transcripts.replaceForMeeting(id, segments)
    return meeting
  }

  function depsWith(embedder: Embedder, overrides: Partial<IndexingDeps> = {}): IndexingDeps {
    return { ...repos(), embedder, embedIntervalMs: 0, now, ...overrides }
  }

  /** Call until the run is done or stops, as the progress page does. Returns every outcome. */
  async function drive(id: string, deps: IndexingDeps, maxSteps = 2_000): Promise<IndexingOutcome[]> {
    const outcomes: IndexingOutcome[] = []
    for (let i = 0; i < maxSteps; i++) {
      const outcome = await advanceIndexing(id, deps)
      outcomes.push(outcome)
      if (outcome.kind !== 'progress') return outcomes
      if (outcome.next === 'wait') await new Promise(resolve => setTimeout(resolve, 2))
    }
    throw new Error(`indexing of ${id} did not finish in ${maxSteps} steps`)
  }

  return { repos, db, now, advanceClock, resetClock, meetingWith, depsWith, drive }
}
