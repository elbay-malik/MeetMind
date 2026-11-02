/**
 * What a visitor is told about the invite code (ADR-0015), shared because the page
 * refuses some codes itself and must not give a different answer from the server's:
 * the words are the same for a missing code, a wrong one and a nearly right one.
 */
export const INVITE_REFUSED_MESSAGE = 'Uploading needs a valid invite code.'

export const UPLOADS_CLOSED_MESSAGE = 'Uploading is closed at the moment, whatever code is entered.'
