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

## Model auto-selection (Claude as orchestrator)
When `AUTO_ROUTING_ENABLED=true`, callers can skip declaring a `taskType` and let the
gateway pick the model. **Claude is the line of control**; non-Claude models are workers.

- **Stage A — heuristic pre-filter** (`src/routing/heuristics.ts`): a zero-cost,
  zero-latency deterministic classifier (declared hints, token counts, code/regex
  detection) profiles the request. **Obvious cases bypass the Claude call entirely.**
- **Stage B — Claude orchestrator** (`src/routing/orchestrator.ts`): for *ambiguous*
  requests a cheap fast Claude (`claude-haiku-4-5`) makes the routing decision. The
  orchestrator then **supervises execution, validates the worker's response**
  (schema/safety/quality confidence), and **escalates up the ladder** on low
  confidence or provider failure — `claude-sonnet-4-6 → claude-opus-4-8`. The ladder
  **terminates at `claude-opus-4-8`: Claude is the final authority.**
- **Declarative pool** (`src/models/registry.ts`): per-model cost/latency/capability
  metadata + the worker/orchestrator/escalation org chart.
- **Observability**: every decision is logged with full rationale (chosen model,
  stage, candidates, est-vs-actual cost & latency, validation verdict, escalations).

Default **OFF** — when off, the explicit-model API below is unchanged.

## Config (operator-supplied — never commit)
```
OPENCODE_API_KEY=sk-...            # set via `fly secrets set` / your secret store
OPENCODE_BASE_URL=https://opencode.ai/zen/go/v1
PORT=8095
GATEWAY_TOKEN=...                  # optional shared-secret for callers

# --- model auto-selection (default off) ---
AUTO_ROUTING_ENABLED=true          # feature flag; off ⇒ explicit-model API unchanged
DEFAULT_COST_CEILING_CENTS=5       # per-call cost ceiling (per-tenant override below)
DEFAULT_MAX_ESCALATIONS=2          # ladder climbs allowed before giving up
DEFAULT_CONFIDENCE_THRESHOLD=0.6   # validation confidence below which we escalate
TENANT_<ID>_COST_CEILING_CENTS=... # per-tenant overrides (policy in src/routing/policy.ts)
<PROVIDER>_API_KEY=...             # e.g. OPENAI_API_KEY — gates which providers a tenant may use
```
Keys are read from env at call time and never logged, returned, or committed.

## API
- `GET  /healthz` — `{ ok, configured, models }`
- `GET  /models` — the live classified catalogue
- `POST /route   { taskType, forceModel? }` — which model would be chosen + why (dry-run)
- `POST /complete { taskType, prompt, maxTokens?, forceModel?, budgetCents? }` — route + call + fallback
- `GET  /telemetry` — recent per-call records + cost summary
- `POST /auto/complete { prompt, tenant?, taskTypeHint?, schema?, costCeilingCents?, ... }` — Claude-orchestrated auto-selection *(flag-gated)*
- `GET  /routing/stats` — aggregate auto-routing decisions (stage, models, escalations, cost accuracy) *(flag-gated)*

`taskType` ∈ `code | reasoning | classification | summarization | chat`.

## Develop
```
npm install
npm test
npm run dev      # needs OPENCODE_API_KEY in env for live /models + /complete
```
