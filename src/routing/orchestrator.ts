// THE LINE OF CONTROL.
//
// The orchestrator owns the request lifecycle. Non-Claude models are workers; this
// module is the Claude supervisor that:
//   1. makes (obvious cases) or RATIFIES (ambiguous → cheap Claude) the routing choice,
//   2. supervises worker execution,
//   3. validates the worker's response (schema / safety / quality confidence),
//   4. retries / escalates up the ladder on low confidence or provider failure,
//   5. is the FINAL AUTHORITY on what gets returned — the ladder ends at claude-opus-4-8.
//
// Claude-specific judgement (Stage-B routing) goes through a `ClaudeBrain` so it is
// injectable/testable and degrades gracefully when the provider is unconfigured.

import { CAPABILITY_BAR, type TaskType } from "../models.js";
import { costCents } from "../telemetry.js";
import {
  workers, poolModel, blendedCostOf, ESCALATION_LADDER, TERMINAL_AUTHORITY,
  type PoolModel,
} from "../models/registry.js";
import type { RequestProfile } from "./heuristics.js";
import type { TenantPolicy } from "./policy.js";
import { validate as defaultValidate, type Validation } from "./validator.js";
import type {
  RoutingRecord, CandidateView, DecisionStage,
} from "./decisionLog.js";

// What it takes to actually run a model. The auto-router wires this to the existing
// LlmGateway (forceModel) so telemetry + circuit-breaker stay centralized.
export interface RunModelResult {
  model: string;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  latencyMs: number;
}
export type RunModel = (
  modelId: string,
  prompt: string,
  opts: { taskType: TaskType; maxTokens: number; budgetCents?: number },
) => Promise<RunModelResult>;

// The cheap fast Claude that decides ambiguous routes. Injectable.
export interface ClaudeBrain {
  decideRoute(
    profile: RequestProfile,
    candidates: PoolModel[],
  ): Promise<{ model: string; confidence: number; rationale: string }>;
}

export type ValidateFn = (profile: RequestProfile, text: string, schema?: unknown) => Validation;

export interface HandleResult {
  ok: boolean;
  text: string | null;
  record: RoutingRecord;
}

function candidateView(m: PoolModel): CandidateView {
  return { id: m.id, capability: m.capability, blendedCostPer1k: Number(blendedCostOf(m).toFixed(5)), p50LatencyMs: m.p50LatencyMs };
}

// climb the escalation ladder: worker → first rung (sonnet) → opus → null (terminal).
function climb(current: string): string | null {
  const idx = ESCALATION_LADDER.indexOf(current);
  if (idx === -1) return ESCALATION_LADDER[0] ?? null; // a worker escalates to the first Claude rung
  return ESCALATION_LADDER[idx + 1] ?? null;            // ...then up, ending at the terminal authority
}

export class Orchestrator {
  constructor(
    private readonly brain: ClaudeBrain,
    private readonly run: RunModel,
    private readonly validateFn: ValidateFn = defaultValidate,
  ) {}

  // candidatesFor: the worker models eligible for this request — clear the capability
  // bar, allowed by the tenant, satisfy tool needs, and fit the cost ceiling. Ranked
  // cheapest-first (or fastest-first when the request is latency-sensitive).
  candidatesFor(profile: RequestProfile, policy: TenantPolicy): PoolModel[] {
    const bar = CAPABILITY_BAR[profile.taskType];
    const allow = policy.enabledProviders.length > 0 ? new Set(policy.enabledProviders) : null;
    const ceiling = profile.costCeilingCents ?? policy.costCeilingCents;
    return workers()
      .filter((m) => m.tasks.includes(profile.taskType) && m.capability >= bar)
      .filter((m) => (allow ? allow.has(m.provider) : true))
      .filter((m) => (profile.needsTools ? m.supportsTools : true))
      .filter((m) => this.estCost(m, profile) <= ceiling)
      .sort((a, b) =>
        profile.latencySensitive
          ? a.p50LatencyMs - b.p50LatencyMs || blendedCostOf(a) - blendedCostOf(b)
          : blendedCostOf(a) - blendedCostOf(b) || b.capability - a.capability,
      );
  }

  private estCost(m: PoolModel, profile: RequestProfile): number {
    return costCents(m.inCostPer1k, m.outCostPer1k, profile.inputTokens, profile.expectedOutputTokens);
  }

  async handle(profile: RequestProfile, prompt: string, policy: TenantPolicy, schema?: unknown): Promise<HandleResult> {
    const at = Date.now();
    const candidates = this.candidatesFor(profile, policy);
    const candidateViews = candidates.map(candidateView);
    const ceiling = profile.costCeilingCents ?? policy.costCeilingCents;
    const maxTokens = profile.expectedOutputTokens;

    const baseRecord = (): RoutingRecord => ({
      at,
      tenant: policy.tenant,
      taskType: profile.taskType,
      category: profile.category,
      stage: "heuristic",
      chosen: null,
      initialChoice: null,
      rationale: "",
      candidates: candidateViews,
      estCostCents: 0,
      actualCostCents: 0,
      estLatencyMs: 0,
      actualLatencyMs: 0,
      validationVerdict: "n/a",
      confidence: 0,
      escalations: [],
      ok: false,
    });

    // No worker can serve this within the cost ceiling / capability bar ⇒ refuse.
    if (candidates.length === 0) {
      const rec = baseRecord();
      rec.rationale = `no worker clears the ${profile.taskType} bar within the ${ceiling}¢ ceiling for tenant ${policy.tenant}`;
      rec.validationVerdict = "refused";
      rec.error = "no_eligible_model";
      return { ok: false, text: null, record: rec };
    }

    // ---- routing decision: heuristic bypass (obvious) vs Claude orchestrator (ambiguous) ----
    let stage: DecisionStage;
    let initial: PoolModel;
    let routeRationale: string;
    if (profile.obvious) {
      stage = "heuristic";
      initial = candidates[0];
      routeRationale = `Stage A (heuristic) bypass: ${profile.signals.join("; ")}; cheapest capable = ${initial.id}`;
    } else {
      stage = "orchestrator";
      let pick = candidates[0];
      let decideRationale = "orchestrator default (cheapest capable)";
      try {
        const d = await this.brain.decideRoute(profile, candidates);
        const chosen = candidates.find((c) => c.id === d.model);
        if (chosen) { pick = chosen; decideRationale = d.rationale || decideRationale; }
      } catch {
        // brain unavailable ⇒ degrade to deterministic cheapest-capable.
        decideRationale = "orchestrator unavailable; deterministic cheapest capable";
      }
      initial = pick;
      routeRationale = `Stage B (claude orchestrator) ratified ${initial.id}: ${decideRationale}`;
    }

    const rec = baseRecord();
    rec.stage = stage;
    rec.initialChoice = initial.id;
    rec.rationale = routeRationale;
    rec.estCostCents = Number(this.estCost(initial, profile).toFixed(4));
    rec.estLatencyMs = initial.p50LatencyMs;

    // ---- supervised execution with escalation ----
    let current = initial.id;
    let lastResult: RunModelResult | null = null;
    let lastValidation: Validation | null = null;
    let actualCost = 0;
    let actualLatency = 0;
    let escalationsUsed = 0;

    for (;;) {
      let result: RunModelResult | null = null;
      let failure: string | undefined;
      try {
        result = await this.run(current, prompt, { taskType: profile.taskType, maxTokens, budgetCents: ceiling });
        actualCost += result.costCents;
        actualLatency += result.latencyMs;
      } catch (e) {
        failure = (e as Error)?.message ?? "provider error";
      }

      if (result) {
        lastResult = result;
        lastValidation = this.validateFn(profile, result.text, schema);
        if (lastValidation.verdict === "accept") break;          // good enough — return it
        if (lastValidation.verdict === "reject") break;          // unsafe/unusable — stop, do not spend more
      }

      // Need to escalate (low confidence OR provider failure). Find the next rung.
      if (escalationsUsed >= policy.maxEscalations) break;
      const next = climb(current);
      if (!next) break;                                          // already at the terminal authority

      // Cost-ceiling guard: never climb to a rung we can't afford.
      const nextModel = poolModel(next);
      if (nextModel && this.estCost(nextModel, profile) > ceiling) {
        rec.escalations.push({ from: current, to: next, reason: `escalation to ${next} blocked by ${ceiling}¢ ceiling`, confidenceBefore: lastValidation?.confidence });
        break;
      }

      rec.escalations.push({
        from: current,
        to: next,
        reason: failure ? `provider failure (${failure})` : `low confidence (${lastValidation?.confidence ?? 0})`,
        confidenceBefore: lastValidation?.confidence,
      });
      current = next;
      escalationsUsed += 1;
    }

    rec.chosen = lastResult ? current : null;
    rec.actualCostCents = Number(actualCost.toFixed(4));
    rec.actualLatencyMs = actualLatency;
    rec.confidence = lastValidation?.confidence ?? 0;
    rec.validationVerdict = lastResult ? (lastValidation?.verdict ?? "n/a") : "failed";
    rec.ok = !!lastResult && lastValidation?.verdict !== "reject";
    if (!lastResult) rec.error = "all_models_failed";
    if (rec.chosen === TERMINAL_AUTHORITY) rec.rationale += "; reached terminal authority (claude-opus-4-8)";

    return { ok: rec.ok, text: rec.ok ? (lastResult?.text ?? null) : null, record: rec };
  }
}

// Default Claude brain: asks the cheap orchestrator model to choose among candidates,
// parsing a strict JSON reply. Any failure (unconfigured / parse / network) degrades
// to the deterministic cheapest-capable candidate — the gateway never hard-depends
// on the routing call succeeding.
export class DefaultClaudeBrain implements ClaudeBrain {
  constructor(private readonly run: RunModel, private readonly orchestratorModel: string) {}

  async decideRoute(profile: RequestProfile, candidates: PoolModel[]): Promise<{ model: string; confidence: number; rationale: string }> {
    const menu = candidates.map((c) => `${c.id} (cap ${c.capability}, ~$${blendedCostOf(c).toFixed(4)}/1k, ~${c.p50LatencyMs}ms${c.supportsTools ? ", tools" : ""})`).join("\n");
    const prompt =
      `You are the routing supervisor for an LLM gateway. Choose the single cheapest WORKER model that will produce a high-quality answer for this request.\n` +
      `Task category: ${profile.category} (routing type ${profile.taskType}).\n` +
      `Input ~${profile.inputTokens} tok, expected output ~${profile.expectedOutputTokens} tok. Latency-sensitive: ${profile.latencySensitive}. Needs tools: ${profile.needsTools}.\n` +
      `Candidates:\n${menu}\n` +
      `Reply with ONLY JSON: {"model": "<id from the list>", "confidence": <0..1>, "rationale": "<short>"}.`;
    const r = await this.run(this.orchestratorModel, prompt, { taskType: profile.taskType, maxTokens: 200 });
    const parsed = JSON.parse(extractJson(r.text)) as { model: string; confidence?: number; rationale?: string };
    return { model: parsed.model, confidence: parsed.confidence ?? 0.7, rationale: parsed.rationale ?? "orchestrator choice" };
  }
}

function extractJson(s: string): string {
  const t = s.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return start >= 0 && end >= start ? t.slice(start, end + 1) : t;
}
