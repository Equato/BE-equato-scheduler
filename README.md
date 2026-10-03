# equato-scheduler — scheduler

Cron, scheduled work and queue workers for Equato.

Separate from the API on purpose. Cron inside a horizontally-scaled API means
every replica runs every job, jobs die mid-flight on deploy, and a heavy rollup
starves request handlers of event-loop time. Splitting them lets the two scale
on different signals and deploy independently.

Part of **Equato** — know the price before you go. Six repositories:
`equato-api` · `equato-scheduler` · `equato-webhooks` · `equato-user` ·
`equato-business` · `equato-admin`. Architecture and the full implementation
plan live in **equato-api**.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Postgres and Redis come from the **equato-api** repository:

```bash
cd ../equato-api && pnpm infra:up
```

## Health endpoints

Three, because they answer three different questions:

- `/live` — is the process running? Never touches a dependency, so a database
  blip cannot restart-loop every replica.
- `/ready` — can it work? Checks Postgres and Redis.
- `/health` — human-readable roll-up.

## Shared code

`src/shared/` and `src/db/` are **vendored from equato-api** and must not be
edited here. Change them there, then run in that repository:

```bash
./scripts/sync-shared.sh ../equato-scheduler
```

Every vendored file carries a header saying so.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Queues

Seven, all Redis-backed via BullMQ:

| Queue | Work |
|---|---|
| `analytics-rollup` | nightly `business_daily_metrics` from raw events |
| `search-reindex` | refresh the business search document |
| `notifications` | fan-out for the three inboxes |
| `price-alerts` | price drops on saved comparisons |
| `menu-scan` | vision-model extraction from menu photos |
| `media-variants` | thumbnail / card / hero derivatives |
| `maintenance` | partition creation, old-partition drops, orphan sweeps |

## Rules for every job

BullMQ guarantees **at-least-once** delivery, not exactly-once. So:

- **Idempotent** — running twice must equal running once
- **Retry-safe** — exponential backoff, five attempts
- **Locked** — a Redis lock stops concurrent workers double-running
- **Observable** — every run writes a `job_runs` row

Never rely on in-memory cron state: a restart would lose it.

## Health

`/health` reports queue depth per queue. That is the number worth alerting on —
a backlog that only grows means workers are wedged even though the process
looks perfectly healthy.

```bash
curl localhost:4100/health
```

## Status and documentation

Implemented through Phase 20. The queues, guarantees, retries, retention and
schedules this service runs are documented in **equato-api/QUEUE.md**.
Deployment, configuration and measured failure behaviour are in
**equato-api/DEPLOYMENT.md**. Open items are in
**equato-api/FUTURE_IMPROVEMENTS.md**.
