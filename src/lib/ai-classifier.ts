import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { Lang } from "./roots";
import { logger } from "./logger";

export interface AiClassification {
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  departments: string[];
  action: string;
  confidence: number;
  reasoning: string;
  suggestedReply: string;
  flags: string[];
  modelUsed: string;
  latencyMs: number;
}

const VALID_DEPARTMENTS = [
  "Finance",
  "Logistics",
  "Security",
  "Support",
  "Medical",
  "Legal",
  "Escalation",
] as const;

const SYSTEM_PROMPT = `You are LUMETRA's secondary triage classifier. You receive a customer
request that LUMETRA's deterministic parser could not classify with high
confidence. Your job is to return a strict JSON object so the routing engine
can dispatch the request.

You MUST return ONLY valid JSON matching this exact shape (no prose, no
markdown, no code fences):

{
  "priority": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "departments": string[],   // one or more of: Finance, Logistics, Security, Support, Medical, Legal, Escalation
  "action": string,          // a short imperative action label
  "confidence": number,      // 0-100
  "reasoning": string,       // 1-2 sentences, internal use only
  "suggested_reply": string, // a polite reply to the user IN THE USER'S LANGUAGE; must NEVER promise refunds, credits, legal outcomes, or medical advice
  "flags": string[]          // any of: legal_risk, medical_risk, refund_request, fraud_signal, contains_pii, low_confidence, ambiguous
}

Rules:
- Refunds, credits, settlements, legal outcomes and medical advice MUST NOT be promised in suggested_reply. Use neutral language like "we have routed your request to the relevant team".
- If the request involves legal threats (lawyer, lawsuit, regulator), set departments to include "Legal" and add flag "legal_risk".
- If the request involves bodily harm, medical symptoms, or mentions a hospital or ambulance, set departments to include "Medical" and add flag "medical_risk".
- If the request mentions hacking, phishing, account compromise, fraud or stolen funds, set departments to include "Security" and add flag "fraud_signal".
- If you are uncertain, set confidence below 70 and include flag "low_confidence".
- The suggested_reply MUST be in the same language as the user's request.`;

export async function classifyWithAi(
  text: string,
  language: Lang,
  weakHints: string[],
): Promise<AiClassification> {
  const started = Date.now();

  const userPrompt = [
    `Detected language: ${language}`,
    weakHints.length > 0
      ? `Weak parser hints (may be wrong): ${weakHints.join(", ")}`
      : "No strong parser hints were found.",
    "",
    "Customer request:",
    text,
  ].join("\n");

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";

  let parsed: any;
  try {
    const jsonText = extractJson(raw);
    parsed = JSON.parse(jsonText);
  } catch (err) {
    logger.warn({ err, raw }, "AI classifier returned non-JSON; falling back");
    throw new Error("AI_CLASSIFIER_INVALID_JSON");
  }

  const departments: string[] = Array.isArray(parsed.departments)
    ? parsed.departments.filter((d: unknown): d is string =>
        typeof d === "string" && (VALID_DEPARTMENTS as readonly string[]).includes(d),
      )
    : [];

  if (departments.length === 0) departments.push("Support");

  const priority = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(parsed.priority)
    ? parsed.priority
    : "MEDIUM";

  const flags = Array.isArray(parsed.flags)
    ? parsed.flags.filter((f: unknown): f is string => typeof f === "string")
    : [];

  return {
    priority,
    departments,
    action: typeof parsed.action === "string" ? parsed.action : "Triage + Reply",
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(100, parsed.confidence)) : 60,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    suggestedReply:
      typeof parsed.suggested_reply === "string" ? parsed.suggested_reply : "",
    flags,
    modelUsed: "claude-haiku-4-5",
    latencyMs: Date.now() - started,
  };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  // Strip ```json fences if the model added them
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  // Otherwise grab the first { ... } block
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}
