import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LlmGateway } from "./gateway.js";
import { OpenCodeProvider } from "./provider.js";
import { TASK_TYPES, type TaskType } from "./models.js";

// Convene LLM gateway HTTP service. Endpoints:
//   GET  /healthz             liveness + whether the provider key is configured
//   GET  /models              the live model catalogue (classified)
//   POST /route   {taskType}  which model WOULD be chosen + rationale (dry-run)
//   POST /complete {taskType, prompt, maxTokens?, forceModel?, budgetCents?}
//   GET  /telemetry           recent per-call records + cost summary
// Optional shared-secret auth: if GATEWAY_TOKEN is set, requests must send
//   Authorization: Bearer <GATEWAY_TOKEN>. The OpenCode key is never exposed.

const gateway = new LlmGateway(new OpenCodeProvider());
const PORT = Number(process.env.PORT ?? 8095);
const TOKEN = process.env.GATEWAY_TOKEN;

function send(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}
function authed(req: IncomingMessage): boolean {
  if (!TOKEN) return true; // open on a private network when no token configured
  return req.headers.authorization === `Bearer ${TOKEN}`;
}
function isTaskType(x: unknown): x is TaskType { return typeof x === "string" && (TASK_TYPES as string[]).includes(x); }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return send(res, 200, {
        service: "convene-llm-gateway",
        description: "Route each task to the cheapest model that clears its capability bar (across the OpenCode provider).",
        configured: gateway.configured(),
        models: gateway.registry.count(),
        repo: "https://github.com/gagan114662/convene-llm-gateway",
        endpoints: {
          "GET /healthz": "liveness + whether the provider key is configured",
          "GET /models": "live, classified model catalogue",
          "POST /route": "{ taskType, forceModel? } → which model would be chosen + rationale (dry-run)",
          "POST /complete": "{ taskType, prompt, maxTokens?, forceModel?, budgetCents? } → route + call + fallback",
          "GET /telemetry": "recent per-call records (model/rationale/tokens/latency/cost) + summary",
        },
        taskTypes: TASK_TYPES,
      });
    }
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { ok: true, configured: gateway.configured(), models: gateway.registry.count() });
    }
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && path === "/models") {
      await gateway.registry.ensureFresh();
      return send(res, 200, { models: gateway.registry.list(), refreshedAt: gateway.registry.lastRefreshedAt() });
    }
    if (req.method === "POST" && path === "/route") {
      const b = await readJson(req);
      if (!isTaskType(b.taskType)) return send(res, 400, { error: `taskType must be one of ${TASK_TYPES.join(", ")}` });
      return send(res, 200, await gateway.routeDecision(b.taskType, b.forceModel));
    }
    if (req.method === "POST" && path === "/complete") {
      const b = await readJson(req);
      if (!isTaskType(b.taskType)) return send(res, 400, { error: `taskType must be one of ${TASK_TYPES.join(", ")}` });
      if (typeof b.prompt !== "string" || !b.prompt) return send(res, 400, { error: "prompt required" });
      try {
        const r = await gateway.complete({ taskType: b.taskType, prompt: b.prompt, maxTokens: b.maxTokens, forceModel: b.forceModel, budgetCents: b.budgetCents });
        return send(res, 200, r);
      } catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }
    if (req.method === "GET" && path === "/telemetry") {
      return send(res, 200, { summary: gateway.telemetry.summary(), recent: gateway.telemetry.recent(100) });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: (e as Error).message });
  }
});

// Refresh the registry at boot (best-effort) so /route works immediately.
gateway.registry.refresh().catch(() => {});
server.listen(PORT, () => console.log(`[gateway] listening on :${PORT} (configured=${gateway.configured()})`));
