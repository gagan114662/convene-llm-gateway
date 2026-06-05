import { classifyModel, type ModelInfo } from "./models.js";
import type { Provider } from "./provider.js";

// Model registry: the live set of models, fetched from the provider (NOT hardcoded
// ids) and refreshed periodically so deprecations don't break routing. Keeps the
// last-good list if a refresh fails, so a transient provider outage doesn't empty
// the catalogue.
export class ModelRegistry {
  private models: ModelInfo[] = [];
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  constructor(
    private readonly provider: Provider,
    private readonly ttlMs = 10 * 60_000, // refresh at most every 10 min
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(): ModelInfo[] { return this.models; }
  count(): number { return this.models.length; }
  lastRefreshedAt(): number { return this.lastRefresh; }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const raw = await this.provider.listModels();
        if (raw.length > 0) {
          this.models = raw.map((r) => classifyModel(r.id, this.provider.id, { inPer1k: r.inPer1k, outPer1k: r.outPer1k, context: r.context }));
          this.lastRefresh = this.now();
        }
      } catch {
        // keep last-good; caller observes staleness via lastRefreshedAt.
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  // ensureFresh: refresh if empty or older than the TTL.
  async ensureFresh(): Promise<void> {
    if (this.models.length === 0 || this.now() - this.lastRefresh > this.ttlMs) await this.refresh();
  }
}
