# Dalio

Multi-tenant WhatsApp SaaS for Brazilian beauty clinics: AI agent answers leads in seconds 24/7 and books appointments; scheduled messaging fights no-shows and reactivates lapsed clients. Channel is WAHA (unofficial WhatsApp) permanently, on company-owned SIMs — anti-ban is a first-class subsystem.

## Documents — read before major work

- `DOCUMENTO-EXECUTIVO.md` — business context and **locked decisions** (do not re-litigate: multi-tenant, WAHA-forever, company SIMs, provider abstraction as insurance only).
- `SPEC.md` — technical spec: schema, pipeline contracts, module boundaries, API surface. Update it when reality diverges.
- `TASKS.md` — phased backlog and current status. Update statuses as work completes.

## Structure

pnpm monorepo: `apps/api` (NestJS + BullMQ + Drizzle + LangGraph), `apps/web` (Next.js + shadcn), `packages/shared` (canonical types: events, intents, enums).

## Iron rules (violations are bugs, not style)

1. **Tenant scoping:** every domain table has `clinic_id`; all data access goes through tenant-scoped repositories. Never raw Drizzle queries in services/controllers.
2. **Outbound only via `OutboundIntent`** (`packages/shared`). Never hardcode strings like "responda 1 para confirmar" in flows or prompts — use `choice` intents; the adapter renders them. Campaigns/reminders reference `templateKey`, never raw copy.
3. **Pipeline invariants** (SPEC §4.4): webhook handler ≤50ms, enqueue-only, no Postgres; two-layer dedupe (`SET NX` + deterministic BullMQ `jobId`); sliding debounce buffer; per-conversation lock with drain-loop. Any change to `channels`/`conversations` pipeline code must keep the storm tests green — and add cases for new behavior.
4. **Every outbound send passes the `canContact()` gate** (opt-out, consent, per-contact frequency). Opt-out detection writes `contacts.optOutAt` immediately, in any flow.
5. **The agent never gives medical/clinical advice** — such messages route to handoff. Non-negotiable guardrail in the router.
6. **Rate limits and anti-ban policy live in `channels.ratePolicy` / `numbers.dailyQuota`** — never global constants. Humanized jitter and send windows on all proactive outbound.
7. **No message content in application logs.** Content lives in Postgres and self-hosted Langfuse only (LGPD — conversations contain sensitive health data).
8. **Contact identity is the E.164 phone per clinic**, never provider IDs. `providerMessageId` is stored alongside our IDs, never used as one.

## Conventions

- User-facing copy (messages, dashboard) in pt-BR; code, comments, commits in English.
- Money in integer cents; timestamps `timestamptz`; clinic timezone `America/Sao_Paulo` default — reminders/campaigns compute in clinic-local time.
- Ignore WhatsApp group messages (`@g.us`) at the webhook door.
- LLM tiering: cheap model for routing/FAQ, strong model only for booking. Token usage recorded to `usage_counters` per clinic.
- Workflow: plan before each phase; small reviewable increments; tests alongside code; update `TASKS.md` and `SPEC.md` before committing a phase.

## Commands

(placeholder — fill in as tooling lands in Phase 0: `pnpm dev`, `pnpm test`, `pnpm db:migrate`, `docker compose -f docker-compose.dev.yml up`)
