import { describe, it, expect } from "vitest";
import { LlmGateway } from "../gateway.js";
import { HttpError, type Provider, type RawModel, type CompletionResult } from "../provider.js";
import { AutoRouter } from "./autoRouter.js";
import type { ClaudeBrain } from "./orchestrator.js";

// A mocked provider: lists exactly the pool ids under test and returns per-id
// behaviour — "ok" (good answer), "hedge" (a low-quality decline), or an HTTP
// status (provider failure). No secrets, no network.
type Behaviour = "ok" | "hedge" | number;
function fakeProvider(behaviour: Record<string, Behaviour>): Provider {
  const ids = Object.keys(behaviour);
  return {
    id: "fake",
    configured: () => true,
    listModels: async (): Promise<RawModel[]> => ids.map((id) => ({ id })),
    complete: async (id, _prompt, _max): Promise<CompletionResult> => {
      const b = behaviour[id];
      if (typeof b === "number") throw new HttpError(b, `boom ${b}`);
      const text = b === "hedge" ? "I cannot answer that." : `answer from ${id}`;
      return { text, tokensIn: 10, tokensOut: 5 };
    },
  };
}

const ON = { AUTO_ROUTING_ENABLED: "true" } as NodeJS.ProcessEnv;
// A brain that explodes if consulted — proves a request bypassed Stage B.
const explodingBrain: ClaudeBrain = { decideRoute: async () => { throw new Error("brain must not be called"); } };

describe("AutoRouter — obvious-case heuristic bypass", () => {
  it("routes obvious code straight to the cheapest capable worker WITHOUT the Claude call", async () => {
    const gw = new LlmGateway(fakeProvider({ "deepseek-coder": "ok", "gpt-4o": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    const r = await ar.complete({ prompt: "```js\nconst x=1\n```\nrefactor this" });
    expect(r.ok).toBe(true);
    expect(r.record.stage).toBe("heuristic");      // Stage A decided — no orchestrator call
    expect(r.record.chosen).toBe("deepseek-coder"); // cheapest clearing the code bar
    expect(r.record.escalations).toEqual([]);
    expect(r.text).toContain("deepseek-coder");
  });
});

describe("AutoRouter — ambiguous-case orchestrator routing", () => {
  it("consults the Claude orchestrator and uses its choice", async () => {
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": "ok", "gemini-2.0-flash": "ok" }));
    // Deterministic cheapest would be ministral-8b; the brain overrides to gemini.
    const brain: ClaudeBrain = { decideRoute: async () => ({ model: "gemini-2.0-flash", confidence: 0.8, rationale: "best chat value" }) };
    const ar = new AutoRouter(gw, { env: ON, brain });
    const r = await ar.complete({ prompt: "tell me something interesting today" });
    expect(r.record.stage).toBe("orchestrator");   // ambiguous ⇒ Stage B
    expect(r.record.chosen).toBe("gemini-2.0-flash");
    expect(r.ok).toBe(true);
  });
});

describe("AutoRouter — low-confidence escalation", () => {
  it("escalates up the ladder when a worker's answer is low confidence", async () => {
    // The cheap worker hedges (low confidence) → orchestrator climbs to claude-sonnet-4-6.
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": "hedge", "claude-sonnet-4-6": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    const r = await ar.complete({ prompt: "answer this", taskTypeHint: "chat" });
    expect(r.ok).toBe(true);
    expect(r.record.escalations.length).toBe(1);
    expect(r.record.escalations[0].from).toBe("ministral-8b");
    expect(r.record.escalations[0].to).toBe("claude-sonnet-4-6");
    expect(r.record.escalations[0].reason).toMatch(/low confidence/);
    expect(r.record.chosen).toBe("claude-sonnet-4-6"); // Claude is the final authority
  });

  it("climbs all the way to the terminal authority when needed", async () => {
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": "hedge", "claude-sonnet-4-6": "hedge", "claude-opus-4-8": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    const r = await ar.complete({ prompt: "answer this", taskTypeHint: "chat" });
    expect(r.ok).toBe(true);
    expect(r.record.chosen).toBe("claude-opus-4-8");
    expect(r.record.escalations.map((e) => e.to)).toEqual(["claude-sonnet-4-6", "claude-opus-4-8"]);
    expect(r.record.rationale).toMatch(/terminal authority/);
  });
});

describe("AutoRouter — provider-failure fallback", () => {
  it("treats a provider error as an escalation trigger and recovers", async () => {
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": 503, "claude-sonnet-4-6": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    const r = await ar.complete({ prompt: "answer this", taskTypeHint: "chat" });
    expect(r.ok).toBe(true);
    expect(r.record.escalations[0].reason).toMatch(/provider failure/);
    expect(r.record.chosen).toBe("claude-sonnet-4-6");
    // The failed worker was tripped on the gateway's breaker (centralized fallback).
    expect(gw.breaker.isDegraded("ministral-8b")).toBe(true);
  });
});

describe("AutoRouter — cost-ceiling enforcement", () => {
  it("refuses when no model fits the cost ceiling", async () => {
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    const r = await ar.complete({ prompt: "answer this", taskTypeHint: "chat", costCeilingCents: 0.00000001 });
    expect(r.ok).toBe(false);
    expect(r.text).toBeNull();
    expect(r.record.chosen).toBeNull();
    expect(r.record.error).toBe("no_eligible_model");
    expect(r.record.validationVerdict).toBe("refused");
  });

  it("does not escalate to a rung it cannot afford", async () => {
    // Ceiling fits the cheap worker but NOT claude-opus; a hedge can't climb past it.
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": "hedge", "claude-sonnet-4-6": "hedge", "claude-opus-4-8": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    const r = await ar.complete({ prompt: "answer this", taskTypeHint: "chat", costCeilingCents: 1.0 });
    // opus (~3.8¢ for 512 out) exceeds the 1¢ ceiling ⇒ escalation blocked there.
    const blocked = r.record.escalations.find((e) => e.reason.includes("blocked by"));
    expect(blocked?.to).toBe("claude-opus-4-8");
    expect(r.record.chosen).not.toBe("claude-opus-4-8");
  });
});

describe("AutoRouter — feature flag", () => {
  it("is OFF by default and refuses auto routing (explicit-model API untouched)", async () => {
    const gw = new LlmGateway(fakeProvider({ "ministral-8b": "ok" }));
    const ar = new AutoRouter(gw, { env: {} as NodeJS.ProcessEnv });
    expect(ar.enabled()).toBe(false);
    await expect(ar.complete({ prompt: "hi" })).rejects.toThrow(/disabled/);
    // The underlying gateway's explicit-model path still works unchanged.
    const direct = await gw.complete({ taskType: "chat", prompt: "hi", forceModel: "ministral-8b" });
    expect(direct.model).toBe("ministral-8b");
  });

  it("records every decision for GET /routing/stats", async () => {
    const gw = new LlmGateway(fakeProvider({ "deepseek-coder": "ok" }));
    const ar = new AutoRouter(gw, { env: ON, brain: explodingBrain });
    await ar.complete({ prompt: "```js\n1\n```\nfix" });
    const stats = ar.stats();
    expect(stats.decisions).toBe(1);
    expect(stats.byStage.heuristic).toBe(1);
    expect(stats.byChosenModel["deepseek-coder"]).toBe(1);
    expect(ar.recent(10).length).toBe(1);
  });
});
