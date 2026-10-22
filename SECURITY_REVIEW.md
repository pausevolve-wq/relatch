# Security changes for review - 22 October 2026

Local branch: security/ocr-atomic-quotas-20261022
Base: 4e238250c89ee0157d1ed382db8f63bcb436f7b6

Not deployed. No production data or provider API calls used in tests.

## Changes
- Atomic Redis Lua reservations before generation, instead of Clerk read/write counters.
- Existing Clerk period usage seeds the first reservation to avoid resetting used quota.
- UTC daily/ISO-week periods; 5 daily / 35 weekly sessions, up to 5 attempts per 10-minute batch.
- OCR independently limited: 5 calls per anonymous token, 25 per signed-in user per UTC day.
- Datalab limited to 3 reserved attempts per signed-in user per UTC day, before job submission.
- Quota storage missing/failure/timeout denies provider work; Datalab-only quota failure skips that tier.
- Removed generated description debug text from backend console logging.

## Behavior changes requiring review
Failed/in-flight generation and Datalab attempts remain counted. This is intentionally conservative: a timed-out job can still incur provider cost. No automatic refunds are implemented. Requests rejected as insufficient generation input do not reserve quota. Existing output/response format is preserved apart from quota failures.

Signed-in provider work now depends on Redis as well as Clerk. A Redis outage therefore pauses signed-in generation/OCR instead of allowing potentially unbounded provider work. Existing frontend fallback behavior has not been redesigned. The 25/day OCR limit is a new policy choice derived from the existing 5 sessions x 5 requests allowance; review before deployment.

Redis is authoritative after reservation. Clerk private metadata is no longer updated by generation. Any dashboard reading Clerk usage directly must be changed to read the authoritative counters before rollout. The current frontend located in this review reads quota response fields, not a usage endpoint.

Switching back to old code mid-period would use stale Clerk counters. A rollback must retain the atomic quota module or pause provider calls until the daily and weekly windows reset. Do not treat an old deployment rollback as preserving hard spend accounting.

Redis retention/eviction or manual deletion resets newly reserved counts to the old Clerk baseline; do not clear these keys during a quota window. Multi-region Redis deployments must route to the same authoritative primary. Owner-token rate limits do not guarantee one trial per human or prevent distributed-IP abuse.

## Verification
Run a local Redis executable, then REDIS_SERVER=/path/to/redis-server npm run test:security. Tests launch an isolated Unix-socket server with no persistence and no TCP port. Lua concurrency tests use real Redis. Handler tests stub Clerk, provider responses and quota failures. No production credentials are needed.

Not tested: real Clerk/Upstash integration, production routing, actual AI/OCR output quality, billing dashboards, or browser fallback behavior under every error. These must be checked in an isolated preview before any production release.

## Review-only deployment guard
This branch sets git.deploymentEnabled to false in the Vercel project configuration. This suppresses automatic Git deployments for code-only review, including previews. It does not prevent manual deployments or promotion and is not a substitute for deployment permissions. Do not merge this review-only guard into main. Remove it only in a separately reviewed release change after staging resources and rollout authority are confirmed.

Official configuration semantics: https://vercel.com/docs/project-configuration/git-configuration
