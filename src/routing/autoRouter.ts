// Auto-router: the public entry point for model auto-selection. Ties Stage A
// (heuristics) + the Claude orchestrator + supervised execution together, records a
// full decision per request, and exposes aggregate stats.
//
// Worker execution is delegated to the EXISTING LlmGateway via forceModel, so the
// gateway's circuit-breaker and per-call telemetry stay centralized and unchanged.
// This module adds a layer ON TOP — it does not alter the gateway's explicit-model API.

import { LlmGateway } from "../gateway.js";
import { ORCHESTRATOR_MODEL } from "../models/registry.js";
import { classify, type RawRequest } from "./heuristics.js";
import { autoRoutingEnabled, resolveTenant } from "./policy.js";
import { RoutingLog, type RoutingStats, type RoutingRecord } from "./decisionLog.js";
import {
  Orchestrator, DefaultClaudeBrain,
  type ClaudeBrain, type RunModel, type ValidateFn, type HandleResult,
} from "./orchestrator.js";

export interface AutoRouterOpts {
  brain?: ClaudeBrain;        // override the Stage-B Claude brain (tests / custom)
  validateFn?: ValidateFn;    // override response validation (tests / custom)
  env?: NodeJS.ProcessEnv;
}

export class AutoRouter {
  readonly log = new RoutingLog();
  private readonly orchestrator: Orchestrator;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly gateway: LlmGateway, opts: AutoRouterOpts = {}) {
    this.env = opts.env ?? process.env;
    // Run a model through the existing gateway (forceModel ⇒ telemetry + breaker).
    const run: RunModel = async (modelId, prompt, o) => {
      const r = await this.gateway.complete({
        taskType: o.taskType, prompt, maxTokens: o.maxTokens, forceModel: modelId, budgetCents: o.budgetCents,
      });
      return { model: r.model, text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costCents: r.costCents, latencyMs: r.latencyMs };
    };
    const brain = opts.brain ?? new DefaultClaudeBrain(run, ORCHESTRATOR_MODEL);
    this.orchestrator = new Orchestrator(brain, run, opts.validateFn);
  }

  enabled(): boolean { return autoRoutingEnabled(this.env); }

  // complete: auto-select a model and produce an answer. Throws if the feature flag
  // is OFF — callers fall back to the explicit-model API, leaving it unchanged.
  async complete(req: RawRequest): Promise<HandleResult> {
    if (!this.enabled()) throw new Error("auto routing disabled (AUTO_ROUTING_ENABLED is off)");
    const policy = resolveTenant(req.tenant, this.env);
    const profile = classify({ ...req, latencySensitive: req.latencySensitive ?? policy.defaultLatencySensitive });
    const res = await this.orchestrator.handle(profile, req.prompt, policy, req.schema);
    this.log.record(res.record);
    return res;
  }

  stats(): RoutingStats { return this.log.stats(); }
  recent(n = 100): RoutingRecord[] { return this.log.recent(n); }
}
