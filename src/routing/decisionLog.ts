// Observability for auto-routing: one record per request capturing the full
// rationale — chosen model, which stage decided, candidates considered, estimated
// vs actual cost & latency, the validation verdict, and every escalation hop.
// A bounded in-memory ring buffer (like Telemetry); GET /routing/stats aggregates it.
// No prompt content or keys are ever stored.

export type DecisionStage = "heuristic" | "orchestrator";

export interface CandidateView {
  id: string;
  capability: number;
  blendedCostPer1k: number;
  p50LatencyMs: number;
}

export interface EscalationHop {
  from: string;
  to: string;
  reason: string;          // "low confidence (0.40)" | "provider failure (503)"
  confidenceBefore?: number;
}

export interface RoutingRecord {
  at: number;
  tenant: string;
  taskType: string;
  category: string;
  stage: DecisionStage;            // heuristic bypass vs Claude orchestrator
  chosen: string | null;          // final model that produced the returned answer
  initialChoice: string | null;   // model first selected before any escalation
  rationale: string;
  candidates: CandidateView[];
  estCostCents: number;
  actualCostCents: number;
  estLatencyMs: number;
  actualLatencyMs: number;
  validationVerdict: string;      // accept | escalate | reject | failed
  confidence: number;
  escalations: EscalationHop[];
  ok: boolean;
  error?: string;
}

export interface RoutingStats {
  decisions: number;
  byStage: Record<string, number>;
  byChosenModel: Record<string, number>;
  byCategory: Record<string, number>;
  escalations: number;
  escalationRate: number;
  failures: number;
  totalEstCostCents: number;
  totalActualCostCents: number;
  costEstimateErrorCents: number;     // actual − est (positive ⇒ underestimated)
  avgLatencyMs: number;
}

export class RoutingLog {
  private buf: RoutingRecord[] = [];
  constructor(private readonly cap = 500) {}

  record(r: RoutingRecord): void {
    this.buf.push(r);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  recent(n = 100): RoutingRecord[] { return this.buf.slice(-n).reverse(); }

  stats(): RoutingStats {
    const byStage: Record<string, number> = {};
    const byChosenModel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let escalations = 0, failures = 0, totalEst = 0, totalActual = 0, totalLatency = 0;

    for (const r of this.buf) {
      byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
      if (r.chosen) byChosenModel[r.chosen] = (byChosenModel[r.chosen] ?? 0) + 1;
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      escalations += r.escalations.length;
      if (!r.ok) failures += 1;
      totalEst += r.estCostCents;
      totalActual += r.actualCostCents;
      totalLatency += r.actualLatencyMs;
    }
    const n = this.buf.length;
    return {
      decisions: n,
      byStage,
      byChosenModel,
      byCategory,
      escalations,
      escalationRate: n ? Number((escalations / n).toFixed(3)) : 0,
      failures,
      totalEstCostCents: Number(totalEst.toFixed(4)),
      totalActualCostCents: Number(totalActual.toFixed(4)),
      costEstimateErrorCents: Number((totalActual - totalEst).toFixed(4)),
      avgLatencyMs: n ? Math.round(totalLatency / n) : 0,
    };
  }
}
