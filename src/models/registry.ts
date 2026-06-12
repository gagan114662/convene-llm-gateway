// Declarative model-pool registry for auto-routing.
//
// The existing src/registry.ts is the LIVE catalogue fetched from the provider (so
// deprecations can't break routing). THIS file is the complementary *declarative*
// layer the auto-router reasons over: hand-curated cost / latency / capability
// metadata plus the org chart of control — who are workers and who is the Claude
// supervisor. Nothing here is a secret: no API keys, only public model ids and
// pricing/latency estimates used to rank candidates and to size the escalation ladder.
//
// CONTROL MODEL (encoded structurally, not just in prose):
//   role "worker"       — non-Claude (or cheap) models that DO the work. Disposable.
//   role "orchestrator" — the cheap fast Claude that makes/ratifies routing decisions.
//   role "escalation"   — stronger Claude models the orchestrator climbs to when a
//                         worker's answer is low-confidence or the provider fails.
// The ladder always terminates at claude-opus-4-8: Claude is the final authority.

import type { TaskType } from "../models.js";

export type ModelRole = "worker" | "orchestrator" | "escalation";

export interface PoolModel {
  id: string;
  provider: string;       // logical provider key; its API key lives in env, never here
  role: ModelRole;
  tasks: TaskType[];      // task types this model is suited to
  capability: number;     // 0..1 quality tier (used for the capability bar + ladder order)
  inCostPer1k: number;    // $ per 1k input tokens
  outCostPer1k: number;   // $ per 1k output tokens
  p50LatencyMs: number;   // rough median latency, for latency-sensitive ranking
  context: number;        // context window (tokens)
  supportsTools: boolean; // can satisfy tool-use requirements
}

// The declarative pool. Costs/latencies are public list estimates; tune freely.
// Worker tier spans providers so the cheapest capable model wins per task. The
// Claude control tier is intentionally NOT in the worker rotation — Claude supervises.
export const MODEL_POOL: PoolModel[] = [
  // ---- workers: cheap & small (trivial work: classification / extraction / chat) ----
  { id: "gpt-4o-mini",         provider: "openai",   role: "worker", tasks: ["chat", "summarization", "classification"], capability: 0.62, inCostPer1k: 0.00015, outCostPer1k: 0.0006,  p50LatencyMs: 700,  context: 128_000, supportsTools: true },
  { id: "gemini-2.0-flash",    provider: "google",   role: "worker", tasks: ["chat", "summarization", "classification"], capability: 0.64, inCostPer1k: 0.0001,  outCostPer1k: 0.0004,  p50LatencyMs: 600,  context: 1_000_000, supportsTools: true },
  { id: "ministral-8b",        provider: "mistral",  role: "worker", tasks: ["chat", "summarization", "classification"], capability: 0.55, inCostPer1k: 0.0001,  outCostPer1k: 0.0001,  p50LatencyMs: 500,  context: 128_000, supportsTools: false },

  // ---- workers: mid tier (clears the code bar; general-purpose) ----
  { id: "gpt-4o",              provider: "openai",   role: "worker", tasks: ["chat", "summarization", "code", "reasoning"], capability: 0.86, inCostPer1k: 0.005,   outCostPer1k: 0.015,   p50LatencyMs: 1300, context: 128_000, supportsTools: true },
  { id: "gemini-1.5-pro",      provider: "google",   role: "worker", tasks: ["chat", "summarization", "code", "reasoning"], capability: 0.84, inCostPer1k: 0.00125, outCostPer1k: 0.005,   p50LatencyMs: 1500, context: 2_000_000, supportsTools: true },

  // ---- workers: specialists ----
  { id: "deepseek-coder",      provider: "deepseek", role: "worker", tasks: ["code", "chat"],                             capability: 0.83, inCostPer1k: 0.00014, outCostPer1k: 0.00028, p50LatencyMs: 1100, context: 128_000, supportsTools: false },
  { id: "deepseek-r1",         provider: "deepseek", role: "worker", tasks: ["reasoning", "code"],                        capability: 0.9,  inCostPer1k: 0.00055, outCostPer1k: 0.00219, p50LatencyMs: 4000, context: 128_000, supportsTools: false },

  // ---- Claude control tier (supervisor — NOT a worker candidate) ----
  { id: "claude-haiku-4-5",    provider: "anthropic", role: "orchestrator", tasks: ["chat", "summarization", "classification", "code", "reasoning"], capability: 0.78, inCostPer1k: 0.001, outCostPer1k: 0.005,  p50LatencyMs: 800,  context: 200_000, supportsTools: true },
  { id: "claude-sonnet-4-6",   provider: "anthropic", role: "escalation",   tasks: ["chat", "summarization", "classification", "code", "reasoning"], capability: 0.92, inCostPer1k: 0.003, outCostPer1k: 0.015,  p50LatencyMs: 1600, context: 200_000, supportsTools: true },
  { id: "claude-opus-4-8",     provider: "anthropic", role: "escalation",   tasks: ["chat", "summarization", "classification", "code", "reasoning"], capability: 0.99, inCostPer1k: 0.015, outCostPer1k: 0.075,  p50LatencyMs: 2600, context: 200_000, supportsTools: true },
];

// The cheap, fast Claude that makes Stage-B routing decisions and supervises.
export const ORCHESTRATOR_MODEL = "claude-haiku-4-5";

// The escalation ladder, weakest → strongest, TERMINATING at claude-opus-4-8.
// The orchestrator climbs this when a worker answer is low-confidence or fails.
export const ESCALATION_LADDER: string[] = ["claude-sonnet-4-6", "claude-opus-4-8"];

// The final authority: nothing escalates past this.
export const TERMINAL_AUTHORITY = "claude-opus-4-8";

export function poolModel(id: string): PoolModel | undefined {
  return MODEL_POOL.find((m) => m.id === id);
}

export function workers(): PoolModel[] {
  return MODEL_POOL.filter((m) => m.role === "worker");
}

export function isClaudeControl(id: string): boolean {
  const m = poolModel(id);
  return !!m && m.provider === "anthropic" && (m.role === "orchestrator" || m.role === "escalation");
}

// A blended per-1k cost used to rank candidates (favours cheap input + output).
export function blendedCostOf(m: PoolModel): number {
  return m.inCostPer1k * 0.7 + m.outCostPer1k * 0.3;
}
