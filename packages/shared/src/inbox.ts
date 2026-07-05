// Real-time inbox event contract — SPEC §7 (SSE `GET /conversations/stream`).
// Shared between the api (publisher) and the web dashboard (EventSource
// consumer) so both sides type the same wire format.
//
// Events are ID POINTERS ONLY, never message content: they transit Redis
// pub/sub and an SSE socket, and the "content lives in Postgres + LangSmith
// only" rule (iron rule #7) is easiest to keep when the event bus physically
// cannot carry content. The dashboard reacts by refetching the pointed-at
// resource over the authenticated REST API.

/** What changed, for dashboard cache invalidation. */
export type InboxEvent =
  /** A message row was created or changed status (sent/failed/draft…). */
  | { type: 'message'; conversationId: string; messageId: string }
  /** Conversation-level change: pause/resume, status, last-activity. */
  | { type: 'conversation'; conversationId: string };
