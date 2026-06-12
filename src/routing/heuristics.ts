// Stage A of the router: a fast, deterministic heuristic pre-filter.
//
// Goal: spend ZERO added latency or cost on the obvious cases. We profile every
// request from cheap signals (declared hints, token counts, regex/code detection)
// and, when one signal clearly dominates, mark it `obvious` so the request bypasses
// the Claude routing call entirely. Only genuinely ambiguous requests fall through
// to Stage B (the cheap Claude orchestrator) — see orchestrator.ts.

import { TASK_TYPES, type TaskType } from "../models.js";

// The richer spec taxonomy. We keep the internal TaskType (5 values, unchanged so
// the existing capability bar applies) but record the finer category for logs.
export type Category = "code" | "summarization" | "extraction" | "creative" | "chat" | "reasoning";

export interface RawRequest {
  prompt: string;
  tenant?: string;
  taskTypeHint?: TaskType;          // explicit caller hint (an obvious case)
  categoryHint?: Category;          // finer explicit hint
  expectedOutputTokens?: number;
  latencySensitive?: boolean;
  needsTools?: boolean;
  costCeilingCents?: number;        // per-call cost ceiling
  schema?: unknown;                 // a JSON schema ⇒ structured extraction
  maxTokens?: number;
}

export interface RequestProfile {
  taskType: TaskType;               // routing task type (drives the capability bar)
  category: Category;               // finer label for observability
  inputTokens: number;
  expectedOutputTokens: number;
  latencySensitive: boolean;
  needsTools: boolean;
  costCeilingCents?: number;
  hasCode: boolean;
  longContext: boolean;
  obvious: boolean;                 // Stage A is confident ⇒ skip the Claude call
  signals: string[];                // human-readable rationale for the profile
}

// ~4 chars/token, matching the rest of the gateway's estimate.
export function estTokens(s: string): number { return Math.ceil(s.length / 4); }

const CODE_FENCE = /```|\b(function|const|let|var|class|def|import|public\s+static|#include|=>|console\.log|System\.out)\b|[;{}]\s*$/m;
const CODE_ASK = /\b(refactor|debug|stack ?trace|compile|unit test|regex|sql query|implement|function|algorithm|bug)\b/i;
const SUMMARIZE_ASK = /\b(summar(y|ise|ize)|tl;?dr|condense|key points|abstract|recap)\b/i;
const EXTRACT_ASK = /\b(extract|parse|classif(y|ication)|label|categor(y|ise|ize)|return (json|as json)|to json|fields?)\b/i;
const CREATIVE_ASK = /\b(write (a|an|me)|poem|story|haiku|lyrics|slogan|tagline|brainstorm|imagine|fictional)\b/i;
const REASON_ASK = /\b(prove|derive|step by step|reason|chain of thought|logic puzzle|why does|explain why|analy(s|z)e)\b/i;

const LONG_CONTEXT_TOKENS = 6_000; // inputs this large are "long-context" work

function categoryToTaskType(c: Category): TaskType {
  switch (c) {
    case "code": return "code";
    case "reasoning": return "reasoning";
    case "summarization": return "summarization";
    case "extraction": return "classification"; // structured extraction ≈ low-bar, cheap-capable
    case "creative": return "chat";
    case "chat": return "chat";
  }
}

// classify: derive a RequestProfile from cheap, deterministic signals.
// Sets `obvious` when a single strong signal dominates (hint, schema, code fence,
// or clearly-long summarization) so the request can skip the Claude routing call.
export function classify(req: RawRequest): RequestProfile {
  const prompt = req.prompt ?? "";
  const inputTokens = estTokens(prompt);
  const longContext = inputTokens >= LONG_CONTEXT_TOKENS;
  const hasCode = CODE_FENCE.test(prompt);
  const signals: string[] = [];

  let category: Category;
  let obvious = false;

  if (req.categoryHint) {
    category = req.categoryHint;
    obvious = true;
    signals.push(`explicit categoryHint=${req.categoryHint}`);
  } else if (req.taskTypeHint && (TASK_TYPES as string[]).includes(req.taskTypeHint)) {
    category = req.taskTypeHint as Category;
    obvious = true;
    signals.push(`explicit taskTypeHint=${req.taskTypeHint}`);
  } else if (req.schema !== undefined) {
    category = "extraction";
    obvious = true;
    signals.push("schema present ⇒ structured extraction");
  } else if (hasCode || CODE_ASK.test(prompt)) {
    category = "code";
    obvious = hasCode; // a code fence is unambiguous; a keyword alone is not
    signals.push(hasCode ? "code fence detected" : "code keyword");
  } else if (SUMMARIZE_ASK.test(prompt) && longContext) {
    category = "summarization";
    obvious = true;
    signals.push("summarize verb + long input");
  } else if (SUMMARIZE_ASK.test(prompt)) {
    category = "summarization";
    signals.push("summarize verb (short input)");
  } else if (EXTRACT_ASK.test(prompt)) {
    category = "extraction";
    signals.push("extraction verb");
  } else if (REASON_ASK.test(prompt)) {
    category = "reasoning";
    signals.push("reasoning verb");
  } else if (CREATIVE_ASK.test(prompt)) {
    category = "creative";
    signals.push("creative verb");
  } else {
    category = "chat";
    signals.push("no dominant signal ⇒ default chat (ambiguous)");
  }

  if (longContext) signals.push(`long context (~${inputTokens} tok)`);

  return {
    taskType: categoryToTaskType(category),
    category,
    inputTokens,
    expectedOutputTokens: req.expectedOutputTokens ?? req.maxTokens ?? 512,
    latencySensitive: req.latencySensitive ?? false,
    needsTools: req.needsTools ?? false,
    costCeilingCents: req.costCeilingCents,
    hasCode,
    longContext,
    obvious,
    signals,
  };
}
