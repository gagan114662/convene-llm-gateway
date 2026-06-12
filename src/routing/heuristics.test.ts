import { describe, it, expect } from "vitest";
import { classify } from "./heuristics.js";
import { CAPABILITY_BAR } from "../models.js";
import {
  MODEL_POOL, workers, poolModel, isClaudeControl, blendedCostOf,
  ESCALATION_LADDER, TERMINAL_AUTHORITY, ORCHESTRATOR_MODEL,
} from "../models/registry.js";

describe("declarative model pool registry", () => {
  it("separates workers from the Claude control tier", () => {
    // Every worker is non-Claude; the orchestrator + escalation tier is Anthropic.
    for (const w of workers()) expect(w.role).toBe("worker");
    expect(isClaudeControl(ORCHESTRATOR_MODEL)).toBe(true);
    expect(poolModel(ORCHESTRATOR_MODEL)!.role).toBe("orchestrator");
    expect(workers().some((w) => w.provider === "anthropic")).toBe(false);
  });

  it("the escalation ladder is monotonic and terminates at claude-opus-4-8", () => {
    const caps = ESCALATION_LADDER.map((id) => poolModel(id)!.capability);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThan(caps[i - 1]);
    expect(ESCALATION_LADDER.at(-1)).toBe(TERMINAL_AUTHORITY);
    expect(TERMINAL_AUTHORITY).toBe("claude-opus-4-8");
    // The terminal authority is the strongest model in the entire pool.
    const maxCap = Math.max(...MODEL_POOL.map((m) => m.capability));
    expect(poolModel(TERMINAL_AUTHORITY)!.capability).toBe(maxCap);
  });

  it("has at least one worker clearing every capability bar", () => {
    for (const [task, bar] of Object.entries(CAPABILITY_BAR)) {
      const ok = workers().some((w) => w.tasks.includes(task as any) && w.capability >= bar);
      expect(ok, `a worker must clear the ${task} bar (${bar})`).toBe(true);
    }
  });

  it("blendedCost favours cheap input + output", () => {
    expect(blendedCostOf(poolModel("ministral-8b")!)).toBeLessThan(blendedCostOf(poolModel("gpt-4o")!));
  });
});

describe("Stage-A heuristic classification table", () => {
  it("a code fence is an obvious code request (heuristic bypass)", () => {
    const p = classify({ prompt: "```js\nconst x = 1\n```\nrefactor this please" });
    expect(p.category).toBe("code");
    expect(p.taskType).toBe("code");
    expect(p.hasCode).toBe(true);
    expect(p.obvious).toBe(true);
  });

  it("an explicit hint short-circuits to obvious", () => {
    expect(classify({ prompt: "anything", taskTypeHint: "reasoning" }).obvious).toBe(true);
    expect(classify({ prompt: "anything", categoryHint: "creative" }).category).toBe("creative");
  });

  it("a JSON schema means structured extraction", () => {
    const p = classify({ prompt: "the user is jane, age 30", schema: { type: "object" } });
    expect(p.category).toBe("extraction");
    expect(p.taskType).toBe("classification");
    expect(p.obvious).toBe(true);
  });

  it("summarize + long input is obvious; summarize alone is not", () => {
    const long = "word ".repeat(7000);
    expect(classify({ prompt: `summarize: ${long}` }).obvious).toBe(true);
    expect(classify({ prompt: `summarize: ${long}` }).longContext).toBe(true);
    expect(classify({ prompt: "summarize this short note" }).obvious).toBe(false);
  });

  it("a vague chat prompt is ambiguous (falls through to the orchestrator)", () => {
    const p = classify({ prompt: "tell me something interesting today" });
    expect(p.category).toBe("chat");
    expect(p.obvious).toBe(false);
  });

  it("estimates tokens and carries latency/tool/ceiling signals", () => {
    const p = classify({ prompt: "hello world", latencySensitive: true, needsTools: true, costCeilingCents: 2, expectedOutputTokens: 64 });
    expect(p.inputTokens).toBeGreaterThan(0);
    expect(p.latencySensitive).toBe(true);
    expect(p.needsTools).toBe(true);
    expect(p.costCeilingCents).toBe(2);
    expect(p.expectedOutputTokens).toBe(64);
  });
});
