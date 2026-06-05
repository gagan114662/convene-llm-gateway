// Circuit breaker: on a model failure, mark it degraded for a cooldown and fall
// back immediately — no blind retry storms. A "deprecated" signal (404/410) trips
// a long cooldown (the id is likely gone until the next registry refresh); a
// transient 5xx/timeout trips a short one.

export type FailureKind = "deprecated" | "transient";

export class CircuitBreaker {
  private until = new Map<string, number>(); // modelId → epoch ms degraded-until
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly deprecatedMs = 30 * 60_000, // 30 min
    private readonly transientMs = 60_000,       // 1 min
  ) {}

  trip(modelId: string, kind: FailureKind): void {
    const cooldown = kind === "deprecated" ? this.deprecatedMs : this.transientMs;
    this.until.set(modelId, this.now() + cooldown);
  }
  isDegraded(modelId: string): boolean {
    const t = this.until.get(modelId);
    if (t === undefined) return false;
    if (this.now() >= t) { this.until.delete(modelId); return false; }
    return true;
  }
  reset(modelId?: string): void {
    if (modelId) this.until.delete(modelId); else this.until.clear();
  }
  degradedIds(): string[] {
    return [...this.until.keys()].filter((id) => this.isDegraded(id));
  }
}

// Classify an HTTP error into a breaker FailureKind. 404/410 = deprecated/gone;
// everything else retryable (5xx/timeout/network) = transient.
export function classifyError(status: number | undefined): FailureKind {
  return status === 404 || status === 410 ? "deprecated" : "transient";
}
