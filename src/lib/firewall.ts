import type { Lang } from "./roots";

export interface FirewallVerdict {
  safe: boolean;
  action: "send" | "rewrite" | "human_review";
  sanitizedReply: string;
  flags: string[];
  reasons: string[];
}

export interface FirewallInput {
  draftReply: string;
  language: Lang;
  departments: string[];
  priority: string;
  confidence: number;
  flags?: string[];
}

const PROMISE_PATTERNS: Array<{ pattern: RegExp; flag: string; reason: string }> = [
  {
    pattern: /\b(will (?:refund|reimburse|credit|return)|guaranteed refund|definitely refund|i (?:promise|guarantee))\b/i,
    flag: "false_promise_refund",
    reason: "Draft contained an unauthorized refund promise.",
  },
  {
    pattern: /\b(will compensate|compensation guaranteed|reimburs(?:e|ement) guaranteed)\b/i,
    flag: "false_promise_compensation",
    reason: "Draft contained an unauthorized compensation promise.",
  },
  {
    pattern: /\b(you (?:are|will be) (?:entitled to|awarded)|legal (?:victory|win|guarantee))\b/i,
    flag: "legal_promise",
    reason: "Draft contained an unauthorized legal outcome statement.",
  },
  {
    pattern: /\b(diagnos(?:e|is)|prescri(?:be|ption)|cure|treat(?:ment)? (?:for|of)|safe to take)\b/i,
    flag: "medical_advice",
    reason: "Draft contained medical advice.",
  },
];

const UNSAFE_PATTERNS: Array<{ pattern: RegExp; flag: string; reason: string }> = [
  {
    pattern: /\b(stupid|idiot|moron|dumb|shut up)\b/i,
    flag: "unsafe_language",
    reason: "Draft contained disrespectful language.",
  },
  {
    pattern: /\b(kill|hurt|attack|harm) (?:yourself|themselves)\b/i,
    flag: "unsafe_language",
    reason: "Draft contained harmful suggestions.",
  },
];

const SAFE_FALLBACKS: Record<Lang, string> = {
  en: "Thank you. Your request has been received and routed to the relevant team for review. A human specialist will follow up shortly.",
  es: "Gracias. Tu solicitud fue recibida y enviada al equipo correspondiente para revisión. Un especialista te contactará en breve.",
  pt: "Obrigado. Sua solicitação foi recebida e encaminhada à equipe responsável para revisão. Um especialista entrará em contato em breve.",
  fr: "Merci. Votre demande a été reçue et transmise à l'équipe compétente pour examen. Un spécialiste vous contactera sous peu.",
};

const HUMAN_REVIEW_NOTE: Record<Lang, string> = {
  en: " This case has been flagged for human review.",
  es: " Este caso fue marcado para revisión humana.",
  pt: " Este caso foi marcado para revisão humana.",
  fr: " Ce dossier a été signalé pour examen humain.",
};

function softenPromises(text: string): string {
  let out = text;
  out = out.replace(/\bwill refund\b/gi, "will review your case for a possible refund");
  out = out.replace(/\bguaranteed refund\b/gi, "case under review");
  out = out.replace(/\bdefinitely refund\b/gi, "review for refund");
  out = out.replace(/\bI (?:promise|guarantee)\b/gi, "we will do our best");
  out = out.replace(/\bwill compensate\b/gi, "will review for possible compensation");
  return out;
}

export function applyFirewall(input: FirewallInput): FirewallVerdict {
  const flags = new Set<string>(input.flags ?? []);
  const reasons: string[] = [];
  let action: FirewallVerdict["action"] = "send";
  let working = (input.draftReply ?? "").trim();

  if (!working) {
    flags.add("empty_draft");
    reasons.push("Draft was empty.");
    return {
      safe: true,
      action: "rewrite",
      sanitizedReply: SAFE_FALLBACKS[input.language] ?? SAFE_FALLBACKS.en,
      flags: Array.from(flags),
      reasons,
    };
  }

  // 1. Unsafe language → always block & rewrite to safe fallback
  for (const { pattern, flag, reason } of UNSAFE_PATTERNS) {
    if (pattern.test(working)) {
      flags.add(flag);
      reasons.push(reason);
      working = SAFE_FALLBACKS[input.language] ?? SAFE_FALLBACKS.en;
      action = "rewrite";
    }
  }

  // 2. False promises → soften
  for (const { pattern, flag, reason } of PROMISE_PATTERNS) {
    if (pattern.test(working)) {
      flags.add(flag);
      reasons.push(reason);
      working = softenPromises(working);
      if (action === "send") action = "rewrite";
    }
  }

  // 3. Low confidence answers → human review
  if (input.confidence < 65) {
    flags.add("low_confidence");
    reasons.push(`Confidence ${input.confidence.toFixed(1)}% below threshold (65%).`);
    action = "human_review";
  }

  // 4. Legal or medical risk → always human review
  if (input.departments.includes("Legal")) {
    flags.add("legal_risk");
    reasons.push("Legal department involvement requires human review.");
    action = "human_review";
  }
  if (input.departments.includes("Medical")) {
    flags.add("medical_risk");
    reasons.push("Medical department involvement requires human review.");
    action = "human_review";
  }

  // 5. Critical priority always escalates
  if (input.priority === "CRITICAL") {
    flags.add("critical_priority");
    reasons.push("CRITICAL priority forces human review.");
    action = "human_review";
  }

  // 6. Contradictions: e.g. promising help but priority CRITICAL with security flags
  if (
    input.departments.includes("Security") &&
    /\b(no problem|no issue|all (?:good|fine))\b/i.test(working)
  ) {
    flags.add("contradiction");
    reasons.push("Reassuring language is contradictory with active security incident.");
    working = SAFE_FALLBACKS[input.language] ?? SAFE_FALLBACKS.en;
    action = "rewrite";
  }

  if (action === "human_review") {
    working += HUMAN_REVIEW_NOTE[input.language] ?? HUMAN_REVIEW_NOTE.en;
  }

  return {
    safe: action !== "human_review",
    action,
    sanitizedReply: working.trim(),
    flags: Array.from(flags),
    reasons,
  };
}
