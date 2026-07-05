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
7. **No message content in application logs.** Content lives in Postgres and LangSmith traces only — LangSmith is the sole authorized external trace destination (EU-region workspace + DPA + PII masking; conversations contain LGPD-sensitive health data).
8. **Contact identity is the E.164 phone per clinic**, never provider IDs. `providerMessageId` is stored alongside our IDs, never used as one.

## Code documentation (required per feature — SPEC §6.1)

Every feature ships with comprehensive comments, in English, at three levels: (1) a file/module header stating purpose, architectural role, and the SPEC/executive-doc section it implements; (2) JSDoc on all public APIs (services, repositories, controllers, shared types) covering what it does and *why it exists* — the business rule or risk it serves; (3) inline comments in dense logic (pipeline, locks, state machines, agent graph, anti-ban) explaining the invariant being protected and what breaks without it. Comments state intent and constraints — never narrate the obvious line below. A stale comment is a bug: update it in the same commit as the code. A feature without this standard is not done.

## Conventions

- User-facing copy (messages, dashboard) in pt-BR; code, comments, commits in English.
- Money in integer cents; timestamps `timestamptz`; clinic timezone `America/Sao_Paulo` default — reminders/campaigns compute in clinic-local time.
- Ignore WhatsApp group messages (`@g.us`) at the webhook door.
- LLM tiering: cheap model for routing/FAQ, strong model only for booking. Token usage recorded to `usage_counters` per clinic.
- Workflow: plan before each phase; small reviewable increments; tests alongside code; update `TASKS.md` and `SPEC.md` before committing a phase.

## Commands

Node via nvm (`nvm use` — .nvmrc pins v24). Copy `.env.example` → `.env` once.

- `docker compose -f docker-compose.dev.yml up -d` — Postgres (host port **5433** — 5432 is taken by an unrelated container), Redis. Add `--profile waha` for WAHA.
- `pnpm install` · `pnpm -r build` (shared must be built before running the api)
- `pnpm dev` — containers + api (:3000) + web (:3100)
- `pnpm lint` · `pnpm typecheck` · `pnpm test` (includes storm integration tests — they spin their own Postgres/Redis via testcontainers, so Docker must be running; ~30s)
- `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:seed` (idempotent; login owner@dalio.dev / dalio-dev-123)

Gotchas:

- eslint's `consistent-type-imports` is off in `apps/api` on purpose (Nest DI needs value imports for decorator metadata — `import type` on injected classes breaks DI silently).
- Auth integration is `@thallesp/nestjs-better-auth` with `disableGlobalAuthGuard: true`: AuthGuard and TenantGuard are registered explicitly in AppModule's providers array because APP_GUARD ordering across imported dynamic modules is not deterministic, and TenantGuard reads the `request.session` AuthGuard attaches. Routes are authenticated by default — opt out with `@AllowAnonymous()`.
- Tenant ALS pattern: TenantContextMiddleware opens an empty store (`runEmpty`), TenantGuard fills it (`set`). A guard cannot `enterWith()` its own store — it dies when the guard's async frame returns. Workers use `run()` with the job's clinicId.
- The auth module re-adds body parsers with `req.rawBody` enabled — the Phase 1 webhook HMAC must use `req.rawBody`, and `NestFactory.create` must keep `bodyParser: false`.
- Vitest transforms with SWC (`unplugin-swc`), not esbuild: esbuild drops decorator metadata, so any test that boots the Nest container fails DI resolution without it.
- DI tokens shared between a module and its own providers live in a separate file (see `queues/redis.token.ts`) — a circular import leaves the Symbol undefined at decoration time with a cryptic "can't resolve dependencies (?)" error.
- BullMQ `removeOnComplete` retention keeps finished jobs (and their jobIds) as tombstones: any fixed-jobId scheduling pattern must remove completed/failed jobs before re-adding, or later adds are silent no-ops (see `BufferService.scheduleFlush` — found by the wave storm test).
- `express` must stay a direct api dependency (pnpm strict layout; no phantom imports).
- Never forward `TenantScopedRepository` constructor args with rest params (`...args: ConstructorParameters<...>`): rest params emit no decorator metadata and the base's `@Inject(DB)` leaks via the prototype chain — Nest resolves wrong tokens. Write an explicit constructor with `@Inject(DB) db, tenant, ...own deps` and call `super(db, tenant)`. The storm suite boots the full DI graph and is what catches this class of bug.
- Module-cycle pattern: when a higher module needs a lower module's provider and importing would form a cycle, extract the shared providers into a `*-DataModule` (no controllers/workers, just repositories+services) that both sides import — see `MessagingDataModule` (Phase 1) and `SchedulingDataModule` (Phase 4: reminders↔scheduling). Don't reach for `forwardRef` — it hides the layering problem.
