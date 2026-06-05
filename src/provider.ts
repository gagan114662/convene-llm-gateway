// OpenCode provider (OpenAI-compatible "zen" gateway). The API key is read from
// the environment at call time and NEVER logged or returned in any payload.
// provider id: opencode-go · auth: api_key (Bearer) · base: OPENCODE_BASE_URL.

export class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); this.name = "HttpError"; }
}

export interface RawModel { id: string; inPer1k?: number; outPer1k?: number; context?: number }
export interface CompletionResult { text: string; tokensIn: number; tokensOut: number }

export interface Provider {
  id: string;
  configured(): boolean;
  listModels(): Promise<RawModel[]>;
  complete(modelId: string, prompt: string, maxTokens: number): Promise<CompletionResult>;
}

type FetchLike = typeof fetch;

export class OpenCodeProvider implements Provider {
  readonly id = "opencode-go";
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  private base(): string { return (this.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1").replace(/\/$/, ""); }
  private key(): string | undefined { return this.env.OPENCODE_API_KEY; }
  configured(): boolean { return !!this.key(); }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const key = this.key();
    if (!key) throw new HttpError(0, "gateway not configured: OPENCODE_API_KEY is unset");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.base()}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
      });
    } catch (e) {
      throw new HttpError(0, `network/timeout: ${(e as Error).message}`); // → transient
    } finally { clearTimeout(timer); }
  }

  async listModels(): Promise<RawModel[]> {
    const res = await this.req("/models");
    if (!res.ok) throw new HttpError(res.status, `listModels ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: number; completion?: number }; context_length?: number }> };
    return (body.data ?? []).map((m) => ({
      id: m.id,
      // Some gateways report $/token; normalize to $/1k when present.
      inPer1k: m.pricing?.prompt != null ? m.pricing.prompt * 1000 : undefined,
      outPer1k: m.pricing?.completion != null ? m.pricing.completion * 1000 : undefined,
      context: m.context_length,
    }));
  }

  async complete(modelId: string, prompt: string, maxTokens: number): Promise<CompletionResult> {
    const res = await this.req("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: modelId, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new HttpError(res.status, `complete ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      tokensIn: body.usage?.prompt_tokens ?? Math.ceil(prompt.length / 4),
      tokensOut: body.usage?.completion_tokens ?? 0,
    };
  }
}
