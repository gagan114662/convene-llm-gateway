// Model classification + router. The gateway should not run everything on one
// model: each task is routed to the cheapest model that clears the capability bar
// for its type. Model IDs are NOT hardcoded — the registry fetches whatever the
// provider currently lists (so a deprecation can't break us) and this module
// CLASSIFIES each id heuristically into capability/cost/task-fit.

export type TaskType = "code" | "reasoning" | "classification" | "summarization" | "chat";
export const TASK_TYPES: TaskType[] = ["code", "reasoning", "classification", "summarization", "chat"];

export interface ModelInfo {
  id: string;
  provider: string;
  tasks: TaskType[];      // task types this model is suited to
  capability: number;     // 0..1 rough quality tier
  inCostPer1k: number;    // $ per 1k input tokens
  outCostPer1k: number;   // $ per 1k output tokens
  context: number;        // context window (tokens)
}

// The capability bar a model must clear to be a candidate for a task type. Trivial
// work (classification/summary) accepts cheap small models; hard work (code/
// reasoning) demands a strong one — so we never pay a flagship to label a message,
// nor route hard coding to a nano model.
export const CAPABILITY_BAR: Record<TaskType, number> = {
  classification: 0.35,
  summarization: 0.45,
  chat: 0.5,
  reasoning: 0.78,
  code: 0.8,
};

const STRONG = /(opus|gpt-?4|sonnet|gemini-?1\.5-pro|gemini-?2.*pro|large|70b|72b|deepseek-(v3|r1)|qwen2?.*72|llama-?3\.[13]-70|mistral-large|command-r-plus|grok-2)/i;
const SMALL = /(mini|nano|small|haiku|flash|lite|8b|7b|3b|1\.5b|phi|gemma|ministral|command-r7)/i;
const CODER = /(cod(e|er|ing)|deepseek-?cod|qwen.*cod|starcoder|codestral)/i;
const REASONER = /(o1|o3|o4|r1|reason|think|qwq)/i;

// classifyModel: derive capability/cost/task-fit from a model id (+ optional
// provider-supplied pricing). Heuristic, so it adapts to ids we've never seen.
export function classifyModel(id: string, provider: string, pricing?: { inPer1k?: number; outPer1k?: number; context?: number }): ModelInfo {
  const strong = STRONG.test(id);
  const small = SMALL.test(id) && !strong;
  const capability = strong ? 0.95 : small ? 0.55 : 0.8;
  const inCostPer1k = pricing?.inPer1k ?? (strong ? 0.005 : small ? 0.0003 : 0.0015);
  const outCostPer1k = pricing?.outPer1k ?? (strong ? 0.015 : small ? 0.0006 : 0.006);
  const tasks: TaskType[] = ["chat", "summarization"];
  if (small) tasks.push("classification");
  if (CODER.test(id) || strong) tasks.push("code");
  if (REASONER.test(id) || strong) tasks.push("reasoning");
  return { id, provider, tasks, capability, inCostPer1k, outCostPer1k, context: pricing?.context ?? 128_000 };
}

// A blended per-1k cost used to rank candidates (favours cheap input + output).
export function blendedCost(m: ModelInfo): number { return m.inCostPer1k * 0.7 + m.outCostPer1k * 0.3; }

export interface RouteOpts { forceModel?: string; isDegraded?: (id: string) => boolean; }

// route: rank the models that can serve `taskType` (clear the bar, not degraded),
// cheapest first. An override forces a specific model (per-agent/workspace).
export function route(models: ModelInfo[], taskType: TaskType, opts: RouteOpts = {}): ModelInfo[] {
  if (opts.forceModel) {
    const forced = models.find((m) => m.id === opts.forceModel);
    if (forced) return [forced];
  }
  const bar = CAPABILITY_BAR[taskType];
  return models
    .filter((m) => m.tasks.includes(taskType) && m.capability >= bar)
    .filter((m) => !(opts.isDegraded?.(m.id)))
    .sort((a, b) => blendedCost(a) - blendedCost(b) || b.capability - a.capability);
}

// pick: the single best (cheapest capable) model for a task, or undefined.
export function pick(models: ModelInfo[], taskType: TaskType, opts: RouteOpts = {}): ModelInfo | undefined {
  return route(models, taskType, opts)[0];
}
