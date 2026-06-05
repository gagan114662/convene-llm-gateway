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

// Tiers are inferred from id signals — adaptive, not a hardcoded id list. Small =
// fast/cheap variants; strong = flagship suffixes/families; reasoners/coders are
// tagged explicitly. Everything else is a capable mid tier (clears the code bar).
const SMALL = /(flash|mini|nano|lite|haiku|small|air|8b|7b|3b|1\.5b|phi|gemma|ministral)/i;
const STRONG = /(max|pro|plus|ultra|opus|gpt-?4|sonnet|gemini.*pro|large|70b|72b|deepseek-(v\d|r1)|kimi|glm-[5-9]|grok|command-r-plus)/i;
const CODER = /(cod(e|er|ing)|codestral|starcoder)/i;
const REASONER = /(o1|o3|o4|r1|reason|think|qwq)/i;

// classifyModel: derive capability/cost/task-fit from a model id (+ optional
// provider-supplied pricing). Heuristic, so it adapts to ids we've never seen.
// Task-fit is CAPABILITY-DRIVEN: any model over the code/reasoning bar is a
// candidate for that work (cheapest wins), small models serve trivial tasks.
export function classifyModel(id: string, provider: string, pricing?: { inPer1k?: number; outPer1k?: number; context?: number }): ModelInfo {
  const reasoner = REASONER.test(id);
  const small = SMALL.test(id);
  const strong = !small && (reasoner || STRONG.test(id));
  const capability = strong || reasoner ? 0.95 : small ? 0.6 : 0.82; // mid default clears the code bar
  const inCostPer1k = pricing?.inPer1k ?? (strong ? 0.005 : small ? 0.0003 : 0.0015);
  const outCostPer1k = pricing?.outPer1k ?? (strong ? 0.015 : small ? 0.0006 : 0.006);
  const tasks: TaskType[] = ["chat", "summarization"];
  if (capability >= CAPABILITY_BAR.reasoning || reasoner) tasks.push("reasoning");
  if (capability >= CAPABILITY_BAR.code || CODER.test(id)) tasks.push("code");
  if (capability <= 0.65) tasks.push("classification");
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
