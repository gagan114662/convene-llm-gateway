// Per-tenant config + the auto-routing feature flag.
//
// Secrets rule (hard): API keys are read from the environment at resolve time and
// NEVER hardcoded, NEVER returned in any payload, NEVER logged. `enabledProviders`
// is derived from which provider keys are actually present in the env, so a tenant
// can only route to providers it is configured for.

export interface TenantPolicy {
  tenant: string;
  enabledProviders: string[];     // providers whose API key is present in env
  costCeilingCents: number;       // default per-call cost ceiling
  maxEscalations: number;         // how far up the ladder the orchestrator may climb
  confidenceThreshold: number;    // < this ⇒ orchestrator escalates
  defaultLatencySensitive: boolean;
}

// Env var name holding a provider's API key. Keys live ONLY in the environment.
// (Per-tenant overrides use TENANT_<TENANT>_<PROVIDER>_API_KEY.)
function providerKeyVar(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

// Default policy knobs (env-overridable, non-secret).
function numEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const KNOWN_PROVIDERS = ["openai", "google", "mistral", "deepseek", "anthropic", "opencode"];

// AUTO_ROUTING_ENABLED gates the whole feature. Default OFF: when off, the gateway's
// existing explicit-model API behavior is unchanged.
export function autoRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.AUTO_ROUTING_ENABLED ?? "");
}

// resolveTenant: build a tenant's policy from env. enabledProviders is whichever
// providers have a key present (tenant-scoped key wins over the shared key). The
// key VALUES are never stored on the policy — only the provider names.
export function resolveTenant(tenant = "default", env: NodeJS.ProcessEnv = process.env): TenantPolicy {
  const T = tenant.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const enabledProviders = KNOWN_PROVIDERS.filter((p) => {
    const tenantKey = env[`TENANT_${T}_${providerKeyVar(p)}`];
    const sharedKey = env[providerKeyVar(p)];
    // OpenCode is the existing built-in provider; treat its existing var as a key.
    const openCodeKey = p === "opencode" ? env.OPENCODE_API_KEY : undefined;
    return !!(tenantKey || sharedKey || openCodeKey);
  });
  return {
    tenant,
    enabledProviders,
    costCeilingCents: numEnv(env, `TENANT_${T}_COST_CEILING_CENTS`, numEnv(env, "DEFAULT_COST_CEILING_CENTS", 5)),
    maxEscalations: numEnv(env, `TENANT_${T}_MAX_ESCALATIONS`, numEnv(env, "DEFAULT_MAX_ESCALATIONS", 2)),
    confidenceThreshold: numEnv(env, `TENANT_${T}_CONFIDENCE_THRESHOLD`, numEnv(env, "DEFAULT_CONFIDENCE_THRESHOLD", 0.6)),
    defaultLatencySensitive: /^(1|true|yes|on)$/i.test(env[`TENANT_${T}_LATENCY_SENSITIVE`] ?? env.DEFAULT_LATENCY_SENSITIVE ?? ""),
  };
}
