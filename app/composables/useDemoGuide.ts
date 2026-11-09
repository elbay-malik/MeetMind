import { browserStorage } from '~/utils/local-meetings'
import { DEMO_GUIDE_HIDDEN_CLASS, guideDismissed, rememberGuideDismissed } from '~/utils/demo-guide'

/**
 * Whether the demo guide is open. It is rendered open, so it is in the page from the first
 * paint and shifts nothing; for a visitor who dismissed it, the head script in DemoGuide.vue
 * has hidden it by then, and `hideIfDismissed` takes it out once the page is up. Close hides
 * it for this visit, which outlasts leaving the page and coming back without a reload.
 */
export function useDemoGuide() {
  const closedThisVisit = useState('demo-guide-closed', () => false)
  const open = useState('demo-guide-open', () => !closedThisVisit.value)

  function hideIfDismissed() {
    if (guideDismissed(browserStorage())) open.value = false
  }
  function close() {
    open.value = false
    closedThisVisit.value = true
  }
  function dismiss() {
    rememberGuideDismissed(browserStorage())
    close()
  }
  function reopen() {
    document.documentElement.classList.remove(DEMO_GUIDE_HIDDEN_CLASS)
    open.value = true
  }
  return { open, hideIfDismissed, close, dismiss, reopen }
}
