import { route, pick, blendedCost, type ModelInfo, type TaskType } from "./models.js";
import { ModelRegistry } from "./registry.js";
import { CircuitBreaker, classifyError } from "./breaker.js";
import { HttpError, type Provider } from "./provider.js";
import { Telemetry, costCents, type CallRecord } from "./telemetry.js";

export interface RouteDecision {
  taskType: TaskType;
  chosen: string | null;
  rationale: string;
  candidates: { id: string; capability: number; blendedCostPer1k: number; degraded: boolean }[];
}

export interface CompleteInput {
  taskType: TaskType;
  prompt: string;
  maxTokens?: number;
  forceModel?: string;
  budgetCents?: number; // pre-flight ceiling for this call
}
export interface CompleteResult extends CallRecord { text: string }

// LlmGateway: ties the registry + router + breaker + provider + telemetry into a
// single per-task entry point. Routes to the cheapest capable model, falls back on
// failure (breaker), enforces a per-call max_tokens + budget pre-flight, and logs
// every call.
export class LlmGateway {
  readonly registry: ModelRegistry;
  readonly breaker = new CircuitBreaker();
  readonly telemetry = new Telemetry();
  constructor(private readonly provider: Provider, opts?: { ttlMs?: number }) {
    this.registry = new ModelRegistry(provider, opts?.ttlMs);
  }

  configured(): boolean { return this.provider.configured(); }

  // routeDecision: which model WOULD be chosen for a task, and why (dry-run, no call).
  async routeDecision(taskType: TaskType, forceModel?: string): Promise<RouteDecision> {
    await this.registry.ensureFresh();
    const models = this.registry.list();
    const ranked = route(models, taskType, { forceModel, isDegraded: (id) => this.breaker.isDegraded(id) });
    const chosen = ranked[0];
    return {
      taskType,
      chosen: chosen?.id ?? null,
      rationale: chosen
        ? `cheapest model clearing the ${taskType} capability bar (cap ${chosen.capability}, ~$${blendedCost(chosen).toFixed(4)}/1k); ${ranked.length} candidate(s)`
        : `no model available for ${taskType} (registry ${models.length} models${this.configured() ? "" : ", gateway not configured"})`,
      candidates: ranked.slice(0, 6).map((m) => ({ id: m.id, capability: m.capability, blendedCostPer1k: Number(blendedCost(m).toFixed(5)), degraded: false })),
    };
  }

  // complete: route → preflight budget → call → fall back on failure → telemetry.
  async complete(input: CompleteInput): Promise<CompleteResult> {
    await this.registry.ensureFresh();
    const maxTokens = input.maxTokens ?? 1024;
    const candidates = route(this.registry.list(), input.taskType, {
      forceModel: input.forceModel,
      isDegraded: (id) => this.breaker.isDegraded(id),
    });
    if (candidates.length === 0) throw new Error(`no model available for ${input.taskType}`);

    const inEst = Math.ceil(input.prompt.length / 4);
    const fellBackFrom: string[] = [];
    let lastErr: unknown;

    for (const m of candidates) {
      // Pre-flight budget: skip a model whose worst-case cost exceeds the ceiling.
      const worstCents = costCents(m.inCostPer1k, m.outCostPer1k, inEst, maxTokens);
      if (input.budgetCents != null && worstCents > input.budgetCents) {
        lastErr = new Error(`over budget: ${m.id} ~${worstCents.toFixed(3)}¢ > ${input.budgetCents}¢`);
        continue;
      }
      const t0 = Date.now();
      try {
        const r = await this.provider.complete(m.id, input.prompt, maxTokens);
        const rec: CompleteResult = {
          text: r.text, at: Date.now(), taskType: input.taskType, model: m.id,
          rationale: `cheapest capable for ${input.taskType}${fellBackFrom.length ? ` (fell back from ${fellBackFrom.join(", ")})` : ""}`,
          tokensIn: r.tokensIn, tokensOut: r.tokensOut,
          latencyMs: Date.now() - t0,
          costCents: Number(costCents(m.inCostPer1k, m.outCostPer1k, r.tokensIn, r.tokensOut).toFixed(4)),
          ok: true, ...(fellBackFrom.length ? { fellBackFrom: [...fellBackFrom] } : {}),
        };
        this.telemetry.record(rec);
        return rec;
      } catch (e) {
        lastErr = e;
        const status = e instanceof HttpError ? e.status : undefined;
        this.breaker.trip(m.id, classifyError(status)); // degrade + fall back immediately
        this.telemetry.record({
          at: Date.now(), taskType: input.taskType, model: m.id, rationale: `failed (${status ?? "err"})`,
          tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - t0, costCents: 0, ok: false,
        });
        fellBackFrom.push(m.id);
      }
    }
    throw new Error(`all candidates failed for ${input.taskType}: ${(lastErr as Error)?.message ?? "unknown"}`);
  }
}

export { pick, type ModelInfo, type TaskType };
