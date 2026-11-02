/**
 * The code every e2e server runs with, unless a spec is about a missing one. Long
 * enough for the gate (ADR-0015), which takes it from the environment like any
 * deployment does: nothing in the server knows it is under test.
 */
export const INVITE_CODE = 'e2e-invite-code-0123456789abcdefghij'

/** How a request presents the code, for every spec that registers a meeting. */
export const inviteHeaders = { authorization: `Bearer ${INVITE_CODE}` }
