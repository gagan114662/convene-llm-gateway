# Convene LLM Gateway

Route each task to the **cheapest model that clears the capability bar** for its
type — across providers, not Claude-for-everything. A standalone service Convene
(agent-chat-platform) calls over HTTP.

## Why
Trivial classification/summary → a cheap small model; hard coding/reasoning → a
strong one. Model IDs are **not hardcoded** — the registry fetches whatever the
provider lists (so deprecations don't break us) and classifies each by capability,
cost, and task-fit.

## Features
- **Refreshable model registry** (fetched at boot + on a TTL; keeps last-good).
- **Capability/cost router** — task type → ranked candidates → cheapest over the bar; per-request overrides.
- **Circuit breaker + graceful fallback** — 404/410 (deprecated) → long cooldown; 5xx/timeout → short; fall back immediately, no retry storms.
- **Budget pre-flight** + per-request `max_tokens`.
- **Per-call telemetry** — chosen model + rationale, tokens in/out, latency, cost.

## Config (operator-supplied — never commit)
```
OPENCODE_API_KEY=sk-...            # set via `fly secrets set` / your secret store
OPENCODE_BASE_URL=https://opencode.ai/zen/go/v1
PORT=8095
GATEWAY_TOKEN=...                  # optional shared-secret for callers
```
The key is read from env at call time and never logged, returned, or committed.

## API
- `GET  /healthz` — `{ ok, configured, models }`
- `GET  /models` — the live classified catalogue
- `POST /route   { taskType, forceModel? }` — which model would be chosen + why (dry-run)
- `POST /complete { taskType, prompt, maxTokens?, forceModel?, budgetCents? }` — route + call + fallback
- `GET  /telemetry` — recent per-call records + cost summary

`taskType` ∈ `code | reasoning | classification | summarization | chat`.

## Develop
```
npm install
npm test
npm run dev      # needs OPENCODE_API_KEY in env for live /models + /complete
```
