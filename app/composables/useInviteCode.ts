/** What the page can check without asking: a header cannot carry anything else, and fetch throws on it. */
const SENDABLE = /^[\x20-\x7E]+$/

/**
 * The invite code (ADR-0015), kept in this page's memory and nowhere else: not in the
 * URL, storage or a log, so it goes when the page does. Checked before the recording
 * is touched, since a wrong code should fail at once rather than after minutes of
 * extraction.
 */
export function useInviteCode() {
  const code = ref('')
  const status = ref<'needed' | 'checking' | 'accepted'>('needed')
  const error = ref<string | null>(null)

  async function check() {
    const candidate = code.value.trim()
    if (!candidate || status.value !== 'needed') return
    error.value = null
    if (!SENDABLE.test(candidate)) {
      error.value = INVITE_REFUSED_MESSAGE
      return
    }
    status.value = 'checking'
    try {
      await $fetch('/api/invite-check', { method: 'POST', headers: inviteAuthorization(candidate) })
      code.value = candidate
      status.value = 'accepted'
    }
    catch (err) {
      const data = (err as { data?: { message?: string } }).data
      error.value = data?.message ?? 'Could not check the code. Check your connection and try again.'
      status.value = 'needed'
    }
  }

  /** The server stopped accepting the code after this page checked it: it was rotated. */
  function forget() {
    code.value = ''
    status.value = 'needed'
    error.value = INVITE_REFUSED_MESSAGE
  }

  return { code, status, error, check, forget }
}
