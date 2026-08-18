# Chat Debug Visibility — Design Doc (Phase 1: chat_agent only)

Status: **Backend/logic implemented in source across all four repos (sdk-nodejs, fusion-5,
do-websocket/packages/api, SA-Analytics) — no migrations run, no deploys done yet.** UI wiring
is code-complete but paused pending a small follow-up (see §7) while backend correctness is
verified first.
Scope: chat_agent conversations only. Dashboard-agent (Pi) and report flows are explicitly deferred to a later phase.

## 1. Problem

When a chat_agent conversation produces a wrong or unexpected answer, there's currently no way
to inspect *why* without SSHing into logs. Specifically we can't see, per conversation:

- which semantic model nodes/tables were retrieved and considered relevant
- which knowledge-base nodes were pulled in (both the always-on global KB and the
  per-question semantic match)
- the actual program/script that was generated and executed (not just the prose analysis)

Debugging today means digging through `superatom-sdk.log`, which is **truncated at the start of
every new request** — so even that is only ever available for the *current* in-flight request,
never historically, and never centrally.

## 2. Key finding: most of this data already exists — it's just discarded

Traced the full chat_agent pipeline in `sdk-nodejs`. Every piece of data we want is already
computed in-memory during a normal request; nothing here requires new retrieval logic, only
capturing values that already exist at known call sites instead of letting them fall out of scope.

| Data we want | Already computed at | Currently discarded at |
|---|---|---|
| Global KB nodes (always-on context) | `getGlobalKnowledgeBase()` — `src/userResponse/knowledge-base.ts:112` | Flattened to text, list dropped |
| Query-matched KB nodes (semantic) | `getKnowledgeBase()` — `knowledge-base.ts:63-66`, matches logged at `:76-78` | Logged once (`logger.warn`), then only `.content` string survives |
| Schema nodes — cross-source routing prefilter (MainAgent scope, decides *which sources* get considered at all) | `agent-user-response.ts:933-965` via `collections['source-embeddings']['search']` | Used to filter tool list, scores dropped |
| Schema nodes — per-source table resolution (SourceAgent scope, decides *which tables within a source*) | `MainAgent.preResolveSchema()` — `main-agent.ts:862-921` via `collections['schema-embeddings']['search']` | Flattened into prompt text, structured `{description, similarity}[]` dropped |
| The actual generated script (contains the real SQL verbatim) | `write_script` tool call, persisted as `AgentWrittenScript` — `main-agent.ts:611-834` | Consumed for component generation, never attached to the saved conversation or analytics event |
| Whether a cached/matched script was reused instead of generated fresh, and why | `ScriptMatcher.match()` → `.reasoning`/`.gaps` — `scripts/script-matcher.ts` | Logged only (`logger.info`), never stored |

Everything below is instrumentation (thread a value through), not new capability.

## 3. Explicitly out of scope for Phase 1 (per discussion)

- **Raw SQL / query results / row data as a separate structure.** The script body already
  contains the real SQL as literal text, and `chat_analytics.sqlGenerated` already captures a
  summary. We are **not** duplicating `executedQueries[]` (full row samples, per-attempt timing)
  into the trace in v1. If we find the script body alone isn't enough for debugging, we can add
  this later.
- **Failed/retried SQL attempts per source-agent.** Same reasoning — adds real weight for
  marginal debug value in v1.
- **Dashboard-agent (Pi) and report flows.** Chat only, for now.
- **SourceAgent's own `search_schema` fallback tool** (used when `preResolveSchema` returns
  null/low-confidence). Same collection type as the two schema retrievals above, cheap to add
  later, but not in the v1 cut unless we decide it's needed.

## 4. What Phase 1 captures

Four things, matching exactly what was asked for:

1. **KB nodes retrieved** — split into `global` (always-on) and `query` (semantic match for this
   specific question), each `{kbId, title, similarity?}`.
2. **Semantic model nodes retrieved** — split into `routing` (MainAgent's cross-source prefilter:
   which sources were even considered) and `preResolve` (SourceAgent's per-source table
   resolution), each `{sourceId, sourceName, table/description, similarity}`.
3. **The script that was used** — body text of the authored/executed script, plus whether it was
   freshly generated or reused from a cached recipe (and the matcher's reasoning if reused).
4. **The full response object** — the exact same `{id, component, analysis, user_prompt, error?,
   scriptBinding?}` object already written to `user_conversations.response`, mirrored centrally
   on `chat_analytics.response` (jsonb, not just the analysis text). Mirrors how
   `answer_feedback.answerSnapshot` already snapshots the answer at feedback time — an
   established, already-accepted pattern for mirroring answer content centrally. Populated for
   aborted/error turns too, not just success — `conversation-saver.ts` already builds this object
   for every status, so the caller reuses the identical value rather than recomputing a
   text-only summary.

## 5. Data residency & lifecycle principle

Two separate concerns decide where each piece lands:

**a) Sensitivity — central vs. per-deployment.** `chat_analytics` (sa-api/Neon) is a shared,
multi-tenant database. `user_conversations` (fusion-5) is the customer's own per-deployment
database, already holding the rest of their conversation content. `trace` contains schema/table
names, KB article titles, and full generated script bodies with literal SQL embedded — structural
detail about a specific customer's data model and business logic. That should never leave their
own deployment's database, so **`trace` is stored in fusion-5, not sa-api.** The saved response
object (analysis prose + component metadata + any error) is lower sensitivity and already has
direct precedent in `answer_feedback.answerSnapshot`'s central-mirror pattern, so it stays on
`chat_analytics` as planned — as `response` (jsonb), mirroring `user_conversations.response`
verbatim rather than just its `analysis` text.

**b) Lifecycle — trace must outlive the conversation it describes.** `user_conversations` rows are
user-deletable (`delete`/`deleteByUiBlockId`/`deleteByUserPrompt`/`deleteThread` all exist today).
If `trace` were a column on that same row, a customer deleting their own conversation would
silently destroy the one debugging record the team might need — often *for exactly the
conversations someone was unhappy enough with to delete*. So **`trace` gets its own table**,
`conversation_traces`, in fusion-5's Postgres, with a **soft** reference to `conversationId` (no FK,
no cascade) — the same soft-pointer pattern this architecture already uses for
`chat_analytics.conversationId`. Deleting a conversation does not delete its trace.

## 6. Data shape (proposed)

New column on `chat_analytics` (do-websocket/packages/api, `src/db/schema.ts`):

```ts
response: jsonb("response"),     // same shape as user_conversations.response, nullable
```

New table in fusion-5 (`database/postgres/drizzle/schema.ts`):

```ts
export const conversationTraces = pgTable("conversation_traces", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),  // soft pointer to user_conversations.id — NO FK, survives conversation deletion
  userId: varchar("user_id", { length: 255 }).notNull(),  // copied, so it's still filterable/attributable if the conversation row is gone
  threadId: varchar("thread_id", { length: 255 }),        // copied, same reason
  trace: jsonb("trace").notNull(),
  createdAt: timestamptz("created_at").defaultNow(),
}, (t) => ({
  conversationIdIdx: index().on(t.conversationId),
  userIdIdx: index().on(t.userId),
}));
```

`trace` jsonb shape (expanded after discussion — see §10):

```jsonc
{
  "version": 1,
  "kbNodes": {
    // `content` is the node's full text AS IT WAS at retrieval time — captured so a
    // later edit/delete of the KB node doesn't erase what the LLM actually saw.
    "global": [ { "kbId": "...", "title": "...", "content": "..." } ],
    "query":  [ { "kbId": "...", "title": "...", "similarity": 0.81, "content": "..." } ]
  },
  "schemaNodes": {
    "routing":    [ { "sourceId": "...", "sourceName": "...", "similarity": 0.77 } ],
    "preResolve": [ { "sourceId": "...", "table": "...", "description": "...", "similarity": 0.62 } ],
    // The exact {{SOURCE_SUMMARIES}} text injected into MainAgent's system prompt —
    // every registered source's catalog entry, captured once per turn.
    "mainAgentCatalog": "1. **Orders DB** (tool: postgres-abc_query, type: postgres)...",
    // One entry per SourceAgent dispatch (a source called twice in one turn gets two
    // entries) — the exact {{FULL_SCHEMA}} text that SourceAgent's own system prompt
    // actually contained, plus any search_schema follow-ups it made mid-conversation.
    "sourceAgentSchemas": [
      {
        "sourceId": "postgres-abc",
        "sourceName": "Orders DB",
        "method": "preresolved-embedding",  // | "tool-full-schema" | "tool-description" | "none"
        "schemaText": "[Pre-resolved via embedding search — 12 most relevant tables...]",
        "searchSchemaLookups": [ { "keywords": ["customer", "region"], "result": "..." } ]
      }
    ]
  },
  "script": {
    "reused": false,
    "recipeId": null,          // set if reused/matched from an existing script_recipe
    "body": "export async function getData(ctx, params) { ... }",
    "reasoning": null          // set if reused — why the matcher picked it
  }
}
```

`response` is sent on the existing `POST /analytics/chat` call (fire-and-forget, after the
conversation is saved) — it's the exact `DBUIBlock` object `conversation-saver.ts` already built
for the `user_conversations.create` call, handed back to the caller instead of recomputed.
`trace` is written via a **new** collection call,
`collections['user-conversations']['saveTrace']({conversationId, userId, threadId, trace})`,
made right after `create` succeeds (so it has the real `conversationId` to point at) — one extra
insert, still no extra round trip to the client, still fire-and-forget/best-effort like everything
else in this pipeline.

## 7. Changes required, by repo

Status: backend/logic changes below are **implemented** (source only — no migrations run yet, no
deploys). UI (SA-Analytics Debug tab) is implemented in code but not the current priority to wire
up/verify — backend correctness comes first.

### `sdk-nodejs` — done
- `RunTrace` accumulator (`src/userResponse/agents/types.ts`), created at the top of
  `get_agent_user_response()` (`src/userResponse/agent-user-response.ts`), threaded into:
  - the source-embeddings prefilter (`agent-user-response.ts`) → `trace.schemaNodes.routing`
  - `getGlobalKnowledgeBase` / `getKnowledgeBase` (`knowledge-base.ts`) → `trace.kbNodes.global` / `.query`
  - `MainAgent.preResolveSchema` (`main-agent.ts`) → `trace.schemaNodes.preResolve`
  - script authoring/reuse (`agent-user-response.ts`, `ScriptMatcher.match`) → `trace.script`
- `trace` rides on `T_RESPONSE.data.trace` (not a new field on `AgentResponse` — see the
  implementing agent's note on why that wasn't necessary) into `user-prompt-request.ts`.
- `src/utils/conversation-saver.ts`: after `collections['user-conversations']['create'](...)`
  succeeds, best-effort calls `collections['user-conversations']['saveTrace']({conversationId,
  userId, threadId, trace})`. Also now returns `response: dbUIBlock` on
  `SaveConversationResult` — the exact object just written to `user_conversations.response`.
- `src/utils/analytics-client.ts`: `ChatAnalyticsEvent`/`buildEvent()` carry `response?:
  DBUIBlock | null` (not `analysis` — full object, not just the text) — **not** `trace`, which
  never touches analyticsClient at all, per §5.
- `src/handlers/user-prompt-request.ts`: all three branches (aborted/error/success) capture
  `savedResponse = saveResult.response` and pass `response: savedResponse` into
  `analyticsClient.buildEvent(...)` — so aborted/error events now carry whatever partial
  analysis/error was captured, not just success events.
- All capture points wrapped in their own try/catch, independent of each retrieval call's
  existing try/catch — a trace-capture failure can never affect the actual answer.

### `fusion-5` — done
- New `conversation_traces` table (`database/postgres/drizzle/schema.ts`), per §6.
- `saveConversationTrace`/`getConversationTrace` in `project-data-db/user-conversations.ts`,
  registered as `saveTrace`/`getTrace` ops in `backend/src/collections/user-conversations.ts`.

### `do-websocket/packages/api` — done
- Nullable `response` (jsonb) column on `chat_analytics` (`src/db/schema.ts`) — same shape as
  `user_conversations.response`, not just analysis text.
- `POST /analytics/chat` (`src/routes/analytics.ts`): accepts and stores `response`.
- `GET /analytics/chat/:id`: added, admin-only, org-scoped, registered after `/summary`/`/trends`
  so it doesn't shadow them — `trace` is deliberately *not* served from here; it comes from the
  fusion-5 WS fetch.

### `SA-Analytics` UI — implemented, deferred for now
- `ConversationDetailModal` Debug tab, `TraceDebugPanel.tsx`, `fetchConversationTrace()` in
  `superatomWs.ts`, `getAnalyticsEvent()` in `saApi.ts` — code exists from the earlier pass, but
  still reads the event's `analysis` field, which no longer exists (`response` replaced it). Needs
  a follow-up pass once we're back on the UI to render the `response` object's `.analysis`/
  `.component`/`.error` instead. Not being fixed now — backend first, per your steer.

## 8. Open items to confirm before implementation starts

1. **Trace shape above** — confirm the fields are right, or add/trim before we write code.
2. **Ingest auth gap** — `POST /analytics/chat` currently has *no* authentication at all (not
   even the `X-SA-Service-Token` that `answer-feedback` checks). We're about to send the full
   `response` object (answer content) through it too. Worth deciding whether to close that gap as
   part of this work or as a fast-follow.
3. **Storage size** — with raw SQL/row data excluded, `trace` should stay small (a handful of
   KB/schema node entries + one script body, typically a few KB) — fine as a plain jsonb column.
   Flag if that assumption is wrong once we see real payloads.
4. **Retention for `conversation_traces`** — now that it's decoupled from the conversation's own
   lifecycle, does it need an explicit retention/TTL policy (e.g. purge after N days) independent
   of conversation deletion, or keep indefinitely for now?
5. **Migration timing** — additive migrations on both sides, no coordination needed between
   fusion-5 and do-websocket deploys, and old sdk-nodejs clients simply won't send the new fields.

## 10. Full-fidelity capture — content, not just ids (implemented)

Follow-up after reviewing the first cut: KB/schema entries only carried `title`/`id`/`similarity`
— enough to *identify* a node, but not what it actually said. Two problems with that:

- A KB node's `content` can be edited or the node deleted later — at that point the trace can no
  longer tell you what the LLM actually read for that conversation, only what node it read *from*.
- The schema side only captured the embedding-search's structured match list
  (`schemaNodes.preResolve`), not the literal text block that ended up in each agent's system
  prompt — which isn't always the same thing (e.g. small-schema sources skip embedding search
  entirely and get the raw full schema instead; a `search_schema` follow-up mid-conversation was
  invisible entirely).

Fixes, both implemented:

- **KB nodes now carry `content`** (the exact matched/full text), for both `global` and `query`
  nodes. Global was a one-line fix (fusion-5 already returns full node rows, just wasn't being
  read). Query-matched required a small fusion-5 change too — `knowledge-base.ts`'s `query`
  collection handler had the matched chunk (`document`) in scope but only folded it into one
  combined string; now it's also attached per-node on `sources[].content`.
- **Schema side now captures the literal prompt text, not just retrieval results**:
  - `schemaNodes.mainAgentCatalog` — the exact `{{SOURCE_SUMMARIES}}` string MainAgent's system
    prompt actually contained (captured once per turn in `MainAgent.buildSystemPrompt`).
  - `schemaNodes.sourceAgentSchemas[]` — one entry **per SourceAgent dispatch** (so multiple
    source agents in one turn, or the same source called twice, each get their own entry),
    capturing the exact `{{FULL_SCHEMA}}` text that SourceAgent's own prompt contained
    (`SourceAgent.buildPrompt`), tagged with `method` so you can tell whether it came from the
    embedding pre-resolve, a full/raw schema (small-schema sources skip pre-resolve entirely), the
    tool's plain description, or nothing — plus `searchSchemaLookups[]`, the exact result text of
    any `search_schema` follow-up tool calls that SourceAgent made mid-conversation when the
    schema it started with wasn't enough.

Net effect: `trace` now reflects exactly what each LLM call in the pipeline actually saw for
schema/KB context, not a reconstruction that could drift from reality as the underlying data
changes. `hasTraceContent()` (`conversation-saver.ts`) updated to also treat these new fields as
"worth saving a row for."

## 11. Entity resolution capture (implemented)

`sdk-nodejs`'s `dev` branch added a `resolve_entities` tool (pinned to iteration 1 of every
MainAgent turn) that turns named things the user mentioned ("FDC limited") into database ids
*before* any SQL is written — backed by a new `entity-search` collection on `fusion-5/backend`
(`total-group-script` branch). MainAgent only keeps a trimmed `{mention, entityType, instanceId,
displayName}` copy for itself (to append to each SourceAgent dispatch); the richer response detail
— match score, whether it was ambiguous, other close candidates — was being discarded. Captured
into the trace instead, same pattern as everything else in this doc:

- `entityResolution.catalogText` — the entity-type catalog text injected into MainAgent's system
  prompt (`loadEntityCatalog`'s output), captured once per turn.
- `entityResolution.calls[]` — one entry per `resolve_entities` tool call this turn, with the
  **full** raw response from the entity-search collection: `resolved[]` (mention → entityType id,
  plus `score`/`ambiguous`/`alternatives`, none of which exist anywhere else), `unresolved[]`,
  `entityMap` (business-concept resolutions), `unmatchedEntityTypes[]`, and `error` when the
  collection call itself failed (fails open server-side, so the outage is still worth seeing).

No DB/API change on `do-websocket`'s side — `conversation_traces.trace` is already a generic jsonb
blob, this rides along inside it like everything else. `hasTraceContent()` updated accordingly.

## 12. Fixed: `conversationId` alone is ambiguous across event types (implemented)

`conversation_traces` had no `type` column — just `conversationId`/`userId`/`threadId`/`trace`. But
`conversationId` is only unique *within* its own source table
(`user_conversations`/`dashboard_agent_conversations`/`reports_conversations` each have their own
independent id sequence), and dashboard/report trace capture (§11 above, §"Entity resolution
capture") means all three tables can now have a saved trace. So a chat conversation #50 and a
dashboard conversation #50 can both exist and both have a `conversation_traces` row — and
`getConversationTrace(conversationId)` filtered on `conversationId` alone, `ORDER BY createdAt DESC
LIMIT 1`. Whichever type's trace was saved more recently for that id would silently win, handed back
regardless of which one was actually requested.

Fix: `conversation_traces` gets a `type` column (`'chat_agent' | 'dashboard' | 'report'` — same
values as `chat_analytics.type` / sdk-nodejs's `AnalyticsEventType`), defaulted to `'chat_agent'` for
existing rows (correct backfill — chat was the only flow that wrote a trace before this session).
`saveConversationTrace`/`getConversationTrace` and the `saveTrace`/`getTrace` collection ops now
require `type` and filter/store on `(conversationId, type)` together, never `conversationId` alone.
All three `sdk-nodejs` call sites (chat/dashboard/report) and SA-Analytics' `fetchConversationTrace`
updated to pass it through. Migration generation/apply is manual (project-setup-mds/backend's
`database/postgres` package), not run by this pass.

## 13. Conversation history capture (implemented)

`trace.conversationHistory` — the prior-turn context (if any) each flow already builds for itself
and injects into its own prompt as `CONVERSATION_HISTORY`, captured as-is, no new fetch:

- Chat — `thread.getConversationContext(...)` (`handlers/user-prompt-request.ts`), captured in
  `MainAgent.buildSystemPrompt`.
- Report — its own `conversationHistory` param, captured in `generate-report.ts`.
- Dashboard-agent (Pi) — `previousResponseText` (last 2 prior runs on that dashboard, `freshSession`
  mode only), captured in `dashboardAgent/collection.ts`.

Absent/undefined when there was no prior context for that turn (new thread, or trimmed to nothing) —
not distinguished from "not captured," same as every other optional field here. No DB/API change —
rides inside the same generic `trace` jsonb blob.

## 14. Explicitly deferred (future phases, not designed yet)

- Dashboard-agent (Pi) trace — Pi runs as an opaque third-party coding-agent loop; its internal
  tool calls aren't currently observable from sdk-nodejs, and its session transcript is deleted
  after each run. Needs a spike into whether `@earendil-works/pi-coding-agent` exposes a
  tool-call hook before a real design is possible.
- Report flow trace — structurally similar to chat (reuses KB retrieval, has an `executedTools[]`
  equivalent), smaller lift than Pi, but out of scope until chat ships.
