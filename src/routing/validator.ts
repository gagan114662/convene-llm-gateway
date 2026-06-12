// Response validation used by the Claude orchestrator to decide whether a worker's
// answer is good enough to return, or whether to escalate. Deterministic and free
// (no model call): schema conformance, a safety screen, and a quality-confidence
// heuristic. The orchestrator may layer a Claude judgement on top, but this is the
// always-available floor.

import type { RequestProfile } from "./heuristics.js";

export type Verdict = "accept" | "escalate" | "reject";

export interface Validation {
  confidence: number;     // 0..1 quality confidence
  verdict: Verdict;
  reasons: string[];
}

// Obvious unsafe-content / refusal markers. A reject here means "do not return this
// and do not bother escalating to spend more" — the request itself is the problem.
const UNSAFE = /\b(how to (make|build|synthesize) (a )?(bomb|explosive|bioweapon|nerve agent)|child sexual)/i;
// Markers that the worker itself failed/declined — a quality miss worth escalating.
const LOW_QUALITY = /\b(i (can'?t|cannot|am unable to)|as an ai|i don'?t have (enough|the) (information|context)|error:)\b/i;

// validate: score a worker response against the request profile.
export function validate(profile: RequestProfile, text: string, schema?: unknown): Validation {
  const reasons: string[] = [];
  const trimmed = (text ?? "").trim();

  // Safety screen first — a hard reject regardless of quality.
  if (UNSAFE.test(trimmed)) {
    return { confidence: 0, verdict: "reject", reasons: ["unsafe content detected"] };
  }

  let confidence = 0.85; // optimistic prior; deduct for problems

  if (trimmed.length === 0) {
    confidence = 0;
    reasons.push("empty response");
  }

  // Schema / structured-extraction conformance.
  if (schema !== undefined || profile.category === "extraction") {
    if (!isLikelyJson(trimmed)) {
      confidence = Math.min(confidence, 0.3);
      reasons.push("expected structured JSON, got prose");
    } else {
      reasons.push("valid JSON shape");
    }
  }

  if (LOW_QUALITY.test(trimmed)) {
    confidence = Math.min(confidence, 0.4);
    reasons.push("model declined / hedged");
  }

  // Implausibly short answer for a non-trivial task.
  if (trimmed.length > 0 && trimmed.length < 16 && profile.category !== "extraction" && profile.taskType !== "classification") {
    confidence = Math.min(confidence, 0.5);
    reasons.push("answer suspiciously short");
  }

  if (reasons.length === 0) reasons.push("non-empty, no quality flags");

  const verdict: Verdict = confidence === 0 ? "reject" : confidence < 0.6 ? "escalate" : "accept";
  return { confidence: Number(confidence.toFixed(2)), verdict, reasons };
}

function isLikelyJson(s: string): boolean {
  const t = s.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}
