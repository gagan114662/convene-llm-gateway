import { describe, it, expect } from "vitest";
import { classifyModel, route, pick, CAPABILITY_BAR } from "./models.js";
import { CircuitBreaker, classifyError } from "./breaker.js";
import { LlmGateway } from "./gateway.js";
import { HttpError, type Provider, type RawModel, type CompletionResult } from "./provider.js";

describe("classifyModel + route (#147)", () => {
  it("classifies small vs strong vs coder/reasoner", () => {
    expect(classifyModel("claude-haiku", "p").capability).toBeLessThan(0.7);
    expect(classifyModel("gpt-4o", "p").capability).toBeGreaterThan(0.9);
    expect(classifyModel("deepseek-coder", "p").tasks).toContain("code");
    expect(classifyModel("o1-preview", "p").tasks).toContain("reasoning");
    expect(classifyModel("claude-haiku", "p").tasks).toContain("classification");
  });

  it("routes trivial work to the cheapest small model, hard work to a strong one", () => {
    const models = [
      classifyModel("nano-mini", "p"),       // cheap, small
      classifyModel("mid-model", "p"),       // mid
      classifyModel("gpt-4o", "p"),          // strong
    ];
    // classification → the cheap small model wins (clears the low bar, cheapest)
    expect(pick(models, "classification")!.id).toBe("nano-mini");
    // code → small model excluded (below the bar); a strong one is chosen
    const coder = pick(models, "code")!;
    expect(coder.capability).toBeGreaterThanOrEqual(CAPABILITY_BAR.code);
    expect(coder.id).toBe("gpt-4o");
  });

  it("an override forces a specific model", () => {
    const models = [classifyModel("a-mini", "p"), classifyModel("gpt-4o", "p")];
    expect(pick(models, "chat", { forceModel: "gpt-4o" })!.id).toBe("gpt-4o");
  });
});

describe("CircuitBreaker (#147)", () => {
  it("degrades on failure and recovers after cooldown; 404/410 = deprecated", () => {
    let t = 0;
    const b = new CircuitBreaker(() => t, 1000, 100);
    expect(classifyError(404)).toBe("deprecated");
    expect(classifyError(503)).toBe("transient");
    b.trip("m1", "transient");
    expect(b.isDegraded("m1")).toBe(true);
    t = 150; // past the 100ms transient cooldown
    expect(b.isDegraded("m1")).toBe(false);
  });
});

// A fake provider: m-cheap (small) fails with 503, m-strong succeeds → tests fallback.
function fakeProvider(behaviour: Record<string, "ok" | number>): Provider {
  const models: RawModel[] = [{ id: "nano-mini" }, { id: "gpt-4o" }];
  return {
    id: "fake", configured: () => true,
    listModels: async () => models,
    complete: async (id): Promise<CompletionResult> => {
      const b = behaviour[id];
      if (b !== "ok") throw new HttpError(b as number, `boom ${b}`);
      return { text: `hello from ${id}`, tokensIn: 10, tokensOut: 5 };
    },
  };
}

describe("LlmGateway (#147)", () => {
  it("falls back to the next candidate when the first fails, and logs telemetry", async () => {
    // chat candidates ranked cheapest-first: nano-mini then gpt-4o. nano fails → fall back.
    const gw = new LlmGateway(fakeProvider({ "nano-mini": 503, "gpt-4o": "ok" }));
    const r = await gw.complete({ taskType: "chat", prompt: "hi" });
    expect(r.model).toBe("gpt-4o");
    expect(r.fellBackFrom).toEqual(["nano-mini"]);
    expect(r.ok).toBe(true);
    expect(gw.breaker.isDegraded("nano-mini")).toBe(true);
    // telemetry recorded both the failure and the success
    expect(gw.telemetry.summary().calls).toBe(2);
  });

  it("routeDecision is a dry-run that names the chosen model + rationale", async () => {
    const gw = new LlmGateway(fakeProvider({ "nano-mini": "ok", "gpt-4o": "ok" }));
    const d = await gw.routeDecision("classification");
    expect(d.chosen).toBe("nano-mini"); // cheapest clearing the (low) classification bar
    expect(d.rationale).toMatch(/cheapest/);
  });

  it("budget pre-flight: a generous ceiling allows the cheap model; an impossible one is refused", async () => {
    const gw = new LlmGateway(fakeProvider({ "nano-mini": "ok", "gpt-4o": "ok" }));
    // 0.5¢ fits the small model's worst case (~0.06¢) but not the flagship (~1.5¢)
    const r = await gw.complete({ taskType: "chat", prompt: "hi", maxTokens: 1000, budgetCents: 0.5 });
    expect(r.model).toBe("nano-mini");
    // a ceiling below even the cheapest model → every candidate skipped → refused
    await expect(gw.complete({ taskType: "chat", prompt: "hi", maxTokens: 1000, budgetCents: 0.0001 })).rejects.toThrow();
  });
});
