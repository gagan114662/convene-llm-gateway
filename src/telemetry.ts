// Per-call telemetry: chosen model + rationale, tokens in/out, latency, cost, ok.
// A bounded in-memory ring buffer the consumer can poll (feeds billing/observability).
// Costs are derived; no prompt content or keys are ever stored.

export interface CallRecord {
  at: number;
  taskType: string;
  model: string;
  rationale: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costCents: number;
  ok: boolean;
  fellBackFrom?: string[];
}

export class Telemetry {
  private buf: CallRecord[] = [];
  constructor(private readonly cap = 500) {}
  record(r: CallRecord): void {
    this.buf.push(r);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  recent(n = 100): CallRecord[] { return this.buf.slice(-n).reverse(); }
  summary(): { calls: number; totalCostCents: number; byModel: Record<string, number> } {
    const byModel: Record<string, number> = {};
    let totalCostCents = 0;
    for (const r of this.buf) { byModel[r.model] = (byModel[r.model] ?? 0) + 1; totalCostCents += r.costCents; }
    return { calls: this.buf.length, totalCostCents, byModel };
  }
}

// costCents: blended token cost for a call, in cents.
export function costCents(inPer1k: number, outPer1k: number, tokensIn: number, tokensOut: number): number {
  return ((tokensIn / 1000) * inPer1k + (tokensOut / 1000) * outPer1k) * 100;
}
