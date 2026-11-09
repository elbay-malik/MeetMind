/**
 * The first-visit guide on the public demo meeting. The only thing stored is whether the
 * visitor asked not to see it again: one key, versioned so changed steps show once more.
 * Nothing here throws, since blocked or full storage must not break the page; the guide
 * then just shows again on the next visit.
 */

export const DEMO_GUIDE_KEY = 'guide:meetmind:v1'
const DISMISSED = 'dismissed'

/** Set on <html> before the first paint when the guide was dismissed, so it never shows. */
export const DEMO_GUIDE_HIDDEN_CLASS = 'demo-guide-dismissed'

/** Runs in the head, before the page is painted. It must stay tiny and never throw. */
export const DEMO_GUIDE_HEAD_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(DEMO_GUIDE_KEY)})===${JSON.stringify(DISMISSED)})document.documentElement.classList.add(${JSON.stringify(DEMO_GUIDE_HIDDEN_CLASS)})}catch(e){}`

export type DemoGuideStorage = Pick<Storage, 'getItem' | 'setItem'>

export function guideDismissed(storage: DemoGuideStorage | null): boolean {
  try {
    return storage?.getItem(DEMO_GUIDE_KEY) === DISMISSED
  }
  catch {
    return false
  }
}

export function rememberGuideDismissed(storage: DemoGuideStorage | null): void {
  try {
    storage?.setItem(DEMO_GUIDE_KEY, DISMISSED)
  }
  catch {
    // Not remembered, so it shows again next time, which is all that is lost.
  }
}

/**
 * Questions the demo's transcript answers, a review of a booking outage. Choosing one only
 * fills the field: every visitor shares the demo's questions for the day.
 */
export const DEMO_SAMPLE_QUESTIONS = [
  'What caused the outage?',
  'Who approves configuration flag changes now?',
  'What are the action items for support?',
] as const

export const DEMO_QUESTION_PLACEHOLDER = 'e.g. What was decided about the status page?'
