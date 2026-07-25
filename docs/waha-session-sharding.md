# WAHA Session Sharding — Implementation Prompt

> **Status:** Not implemented. This is a design brief / future-implementation prompt.
> Nothing here has been decided or coded yet — it captures the discussion, the
> tradeoffs, and the open questions so a future session can pick it up cold.
>
> **Locked context (do not re-litigate):** WAHA-forever, company-owned SIMs,
> multi-tenant, provider abstraction is insurance only (see `DOCUMENTO-EXECUTIVO.md`).
> Iron rules #6 (anti-ban in `channels.ratePolicy`/`numbers.dailyQuota`) and #7
> (no message content in logs) constrain everything below.

---

## 1. Trigger

WAHA Community announcement (<https://waha.devlike.pro/blog/waha-community/>): as of
**`2026.6.1`**, every previously Plus-only feature ships in the free public image.
Concretely, now free:

- **Unlimited sessions** (was the headline Plus gate).
- **Session storage backends: PostgreSQL, MongoDB, S3** (was Plus-only).
- **Security**: API key, Swagger auth.
- **Observability**: health-check and metrics endpoints.

**Original instinct being evaluated:** we assumed ~one WAHA container per clinic
(≈500 containers at scale). With unlimited free sessions we can instead **split
clinics across sessions inside a small number of shared containers.**

---

## 2. The reframe (read this before deciding anything)

**"Unlimited sessions" is a _licensing_ limit being lifted, not a _resource_ limit.**
It removes a billing constraint. It does **not** remove RAM, blast radius, or
egress-IP constraints. So "don't run 500 containers" is correct, but the
replacement is **not** "one big container" — it is **sharding**: a bounded number
of sessions per container, with a deliberate placement policy. The interesting
decisions are all about *where the shard boundaries go*.

---

## 3. Current state of the code (we already model sessions-first)

The ~500-container assumption was never baked into the schema/code. The design is
already session-first and shard-ready:

| Element | Location | Role |
|---|---|---|
| `channels.externalId` | `SPEC.md` schema, `waha.provider.ts` | **WAHA session name** — one per clinic/number |
| `channels.host` | schema; `waha-api.client.ts:19` | **Container base URL** hosting that session. Nullable → falls back to `WAHA_BASE_URL`. **This is the shard pointer.** |
| `channels.engine` | schema | Pins **`noweb`/`gows`** per channel |
| `WahaApiClient.post(path, body, host?)` | `apps/api/src/channels/providers/waha-api.client.ts` | Routes by host: `const base = host ?? this.defaultBaseUrl` — comment already says "for sharded containers" |
| `session-health.worker.ts` | `apps/api/src/channels/` | Restarts **individual sessions** (`/api/sessions/{name}/restart`), not whole containers; maps WAHA session state → `channel_status`; raises `session_failed` alerts |
| `WAHA_BASE_URL` / `WAHA_API_KEY` | `apps/api/src/config/env.ts` | Default container when `host` is null |
| Dev engine | `docker-compose.dev.yml` | NOWEB |

**Implication:** adopting the shard model is a *placement + ops* change around the
existing `host`/`externalId` columns, **not a rewrite.** Most of the plumbing exists.

---

## 4. The three constraints that set sessions-per-container

### 4.1 Engine memory — in our favor
We pin **NOWEB/GOWS** (websocket engines, no Chromium). That's ~tens of MB/session,
versus 300–700 MB/session if we were on **WEBJS** (full Chromium per session).
Packing dozens of sessions per container is feasible **only because** we're not on
WEBJS. → **Action:** measure real NOWEB/GOWS RSS per session under production-like
send volume before committing a cap. Don't guess the number.

### 4.2 Blast radius — the real tension
One container hosting N sessions = **N clinics offline** on any OOM / crash / image
upgrade, plus a reconnection storm when it returns. Sharding manages this:
- Cap sessions/container so a lost container is an acceptable slice.
- **Spread high-value clinics across shards** — never co-locate all the important
  tenants on one container.
- Stagger restarts/upgrades across shards.

### 4.3 Egress IP — the anti-ban landmine (most important, iron rule #6)
**WAHA connects to WhatsApp from the _container's_ IP (Hetzner datacenter), NOT
from the SIM's mobile network.** The SIM only supplies the number identity + initial
pairing. So every company SIM ends up talking to WhatsApp from the same Hetzner IP
range. **Many freshly-paired business-ish numbers behind one datacenter IP is
exactly the fingerprint WhatsApp bans for.**

Consolidating sessions makes this **worse** unless egress is deliberately
diversified. Mitigations:
- WAHA **per-session proxy** (residential/mobile) — strongest, adds cost + a
  dependency.
- At minimum, **spread shards across distinct egress IPs**.
- Keep humanized jitter / send windows (already in `ratePolicy`) — necessary but
  not sufficient; behavior isn't the only signal, IP reputation is.

---

## 5. Tradeoff summary

| Axis | 1 container / clinic (old) | 1 mega-container (naïve) | **Sharded (recommended)** |
|---|---|---|---|
| Infra cost / opex | Highest (≈500× base overhead, orchestration, monitoring) | Lowest | Low |
| Blast radius | Smallest (1 clinic) | Largest (all clinics) | Tunable (shard size) |
| Noisy-neighbor isolation | Best | Worst | Bounded per shard |
| Egress-IP diversity | Naturally spread if 1 IP/container | Single IP, worst fingerprint | Spread across shard IPs / per-session proxy |
| Rolling upgrades | Trivial | All-or-nothing | Per-shard, staggered |
| Operational complexity | High (many units) | Low but fragile | Moderate (needs placement policy) |

---

## 6. Recommended direction

1. **Shard, don't mono-container.** Bounded sessions/container; cap = f(measured
   NOWEB RSS, acceptable blast-radius slice). Start conservative, tune up.
2. **Adopt DB/S3-backed session storage (now free).** Today session auth state
   lives on container-local volumes, which **pins a container to a host**. Moving
   session state to Postgres/S3 makes containers ~stateless → rolling upgrades and
   re-placement **without re-pairing**. This is the biggest concrete win in the
   announcement beyond licensing, and it's the enabler that makes shards fungible.
3. **Egress-diversity policy** tied to anti-ban (§4.3). Decide per-session proxy vs
   per-shard IP. Do not hand-wave — iron rule #6.
4. **Placement service (later).** New clinic → least-loaded shard with capacity →
   writes `channels.host`. Manual assignment is fine until clinic count justifies
   automation.

---

## 7. Open decisions (must be answered before implementing)

1. **Egress strategy:** proxies in front (cost + dependency, strongest anti-ban) —
   or accept datacenter-IP risk and just spread shards across IPs? Drives the whole
   anti-ban story.
2. **Blast-radius appetite:** max number of clinics acceptable to lose when one
   container dies? That number × measured RAM → the shard cap.
3. **Session storage backend:** confirm move to Postgres or S3 (assumed **yes**).
   If Postgres — same instance as app DB or isolated? (LGPD/PII: session auth state
   is not message content, but keep blast radius / backup story in mind.)
4. **WEBJS ever needed?** If any feature forces WEBJS on a channel, its shard math
   is completely different (Chromium RAM). Confirm we stay NOWEB/GOWS-only.
5. **Cap enforcement:** who counts sessions/host and refuses placement over cap?
   (Placement service vs manual runbook to start.)

---

## 8. Implementation sketch (once §7 is answered)

- **Config:** introduce a shard registry (host base URLs + per-host session cap +
  egress/proxy metadata). Likely a table or config, keyed to what `channels.host`
  points at. Keep `WAHA_BASE_URL` as the single-shard/dev default.
- **Placement:** service that, on channel provisioning, selects a shard with free
  capacity and writes `channels.host`. Start with least-loaded-by-count.
- **Session storage:** switch WAHA deployment to Postgres/S3 session store; verify
  a container restart reconnects sessions without QR re-pair; add to
  `DEPLOYMENT.md` / `ops/`.
- **Egress:** per §7.1 — wire WAHA per-session proxy config, or provision shards on
  distinct IPs.
- **Ops/observability:** per-shard health (WAHA metrics endpoint, now free);
  extend `session-health.worker` alerts with shard/host dimension so a *container*
  outage is distinguishable from a single dropped session; staggered rolling-restart
  runbook.
- **Anti-ban wiring:** ensure `numbers.dailyQuota` / `channels.ratePolicy` accounting
  is unaffected by co-tenancy; confirm a ban signal on one session does not cascade
  scheduling to siblings on the same host.
- **Tests:** storm tests remain the merge gate for `channels`/`conversations`
  pipeline (iron rule #3). Add cases for: routing to the correct `host`, a shard
  going down (N sessions FAILED at once) without cross-tenant leakage, and
  reconnection after container restart with DB-backed session store.
- **Docs:** update `SPEC.md` (§ around channels schema — document shard model on the
  existing `host`/`externalId`/`engine` columns + session-storage + egress policy)
  and `TASKS.md` (new phase).

---

## 9. What this does NOT change

- Locked decisions: WAHA-forever, company SIMs, multi-tenant, provider abstraction.
- Tenant scoping (iron rule #1) — sharding is an infra concern; every table still
  carries `clinic_id`, all access still tenant-scoped.
- The `OutboundIntent` contract, `canContact()` gate, pipeline invariants — untouched.
- Contact identity = E.164 per clinic — untouched.
