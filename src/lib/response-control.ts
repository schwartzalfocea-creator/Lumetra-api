/**
 * Response Control Layer
 *
 * Deterministically decides what kind of response to send based on
 * Lumetra roots, routing signals, and confidence scores — without AI.
 *
 * Three output modes:
 *   "auto"    → enough signal; respond immediately with the drafted reply
 *   "clarify" → intent is ambiguous; ask the sender a targeted question
 *   "human"   → risk or complexity is too high; hand off to a human agent
 *
 * Decision order:
 *   1. Hard gates (CRITICAL, Legal, Medical, Security+HIGH, low confidence,
 *      firewall-forced) → always "human"
 *   2. Auto gate (confidence ≥ AUTO_CONFIDENCE and roots ≥ AUTO_MIN_ROOTS
 *      and token count ≥ MIN_TOKENS) → "auto"
 *   3. First matching ClarifyTemplate → "clarify"
 *   4. Generic low-signal fallback → "clarify"
 *
 * To add a new clarification template:
 *   1. Add an entry to CLARIFY_TEMPLATES with a unique `id`, a `when`
 *      predicate, and translations for all four languages.
 *   2. Position it before the generic "low_signal" catch-all.
 *   3. Done — no other file needs to change.
 */

import type { Lang } from "./roots";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResponseMode = "auto" | "clarify" | "human";

export interface ResponseDecision {
  /** Whether to auto-respond, ask for clarification, or escalate. */
  mode: ResponseMode;
  /** The text to be passed to the firewall / returned as final_response. */
  text: string;
  /** Human-readable reasons for the decision (for API traceability). */
  reasons: string[];
  /** Identifier of the ClarifyTemplate that matched, or null. */
  clarificationType: string | null;
}

export interface ResponseControlInput {
  /** Root codes that were detected by the parser. */
  rootsHit: string[];
  /** Category for each entry in rootsHit (parallel array from parser hits). */
  rootCategories: string[];
  departments: string[];
  priority: string;
  confidence: number;
  modifiers: string[];
  states: string[];
  modeCode: string;
  /** Number of raw tokens in the original input. */
  tokenCount: number;
  language: Lang;
  /** True when the AI classifier was invoked for this request. */
  aiWasUsed: boolean;
  /** True when the firewall already decided this needs human review. */
  firewallForcedHuman: boolean;
  /** The sanitized reply text produced by the firewall. */
  draftResponse: string;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const RESPONSE_THRESHOLDS = {
  /** Confidence (%) at or above which the system may auto-respond. */
  AUTO_CONFIDENCE: 82,
  /** Minimum root hits required to auto-respond. */
  AUTO_MIN_ROOTS: 3,
  /** Confidence below which we always escalate to a human agent. */
  ESCALATE_CONFIDENCE: 65,
  /** Token count below which we always ask for clarification. */
  MIN_TOKENS_TO_ACT: 4,
} as const;

// ---------------------------------------------------------------------------
// Clarification templates
// ---------------------------------------------------------------------------

interface ClarifyTemplate {
  /** Unique identifier returned in the API response for tracing. */
  id: string;
  /** One-line description used in the decision reasons array. */
  description: string;
  /** Returns true when this template should fire. */
  when: (ctx: ResponseControlInput) => boolean;
  /** The question to ask in each supported language. */
  question: Record<Lang, string>;
}

const CLARIFY_TEMPLATES: ClarifyTemplate[] = [
  // ── Structural / input quality ──────────────────────────────────────────
  {
    id: "too_short",
    description: "Input is too short to determine intent",
    when: (ctx) =>
      ctx.tokenCount < RESPONSE_THRESHOLDS.MIN_TOKENS_TO_ACT &&
      ctx.rootsHit.length < 2,
    question: {
      en: "We received your message but need a bit more to work with.\nCould you describe your issue in a bit more detail? We want to make sure we route you to the right team.\nEven one extra sentence helps us get you to the right place faster.",
      es: "Recibimos tu mensaje, pero necesitamos un poco más de información.\n¿Podrías describir tu problema con un poco más de detalle? Queremos asegurarnos de derivarte al equipo correcto.\nIncluso una oración extra nos ayuda a encontrarte el lugar indicado más rápido.",
      pt: "Recebemos sua mensagem, mas precisamos de um pouco mais de informação.\nVocê poderia descrever seu problema com um pouco mais de detalhes? Queremos garantir que você seja encaminhado ao time certo.\nAté uma frase a mais já nos ajuda a agilizar o direcionamento.",
      fr: "Nous avons bien reçu votre message, mais nous avons besoin d'un peu plus d'informations.\nPourriez-vous décrire votre problème plus en détail ? Nous souhaitons vous orienter vers la bonne équipe.\nMême une phrase supplémentaire nous aide à vous orienter plus vite.",
    },
  },

  // ── Finance specific ────────────────────────────────────────────────────
  {
    id: "finance_needs_reference",
    description: "Finance detected but no order or invoice reference found",
    when: (ctx) =>
      ctx.departments.includes("Finance") &&
      !ctx.departments.includes("Logistics") &&
      ctx.rootsHit.filter((_, i) => ctx.rootCategories[i] === "finance").length <= 1,
    question: {
      en: "Got it — looks like a billing question.\nCould you share your order number, invoice reference, or the amount in question? This will help us locate your account faster.\nNo reference handy? Just describe what happened and we'll look into it.",
      es: "Entendido — parece una consulta de facturación.\n¿Podrías compartir tu número de pedido, referencia de factura o el monto en cuestión? Eso nos ayudará a localizar tu cuenta más rápido.\n¿No tienes una referencia a mano? Describe lo que ocurrió y lo revisaremos igual.",
      pt: "Entendido — parece uma questão de cobrança.\nPoderia compartilhar o número do pedido, referência da fatura ou o valor em questão? Isso nos ajudará a localizar sua conta mais rápido.\nSem referência? Descreva o que aconteceu e verificamos do mesmo jeito.",
      fr: "Compris — il semble s'agir d'une question de facturation.\nPourriez-vous indiquer votre numéro de commande, la référence de facture ou le montant concerné ? Cela nous aidera à retrouver votre compte plus rapidement.\nPas de référence sous la main ? Décrivez ce qui s'est passé et nous examinerons quand même.",
    },
  },

  // ── Logistics specific ──────────────────────────────────────────────────
  {
    id: "logistics_needs_reference",
    description: "Logistics detected but no tracking or order context found",
    when: (ctx) =>
      ctx.departments.includes("Logistics") &&
      !ctx.departments.includes("Finance") &&
      ctx.rootsHit.filter((_, i) => ctx.rootCategories[i] === "logistics").length <= 1,
    question: {
      en: "We received your delivery concern.\nDo you have a tracking number or order ID for the shipment? This will let us check the status right away.\nNo tracking number? A rough date or destination helps too.",
      es: "Recibimos tu consulta sobre la entrega.\n¿Tienes un número de seguimiento o ID de pedido para el envío? Con eso podemos consultar el estado de inmediato.\n¿Sin número de rastreo? Una fecha aproximada o el destino también ayudan.",
      pt: "Recebemos sua questão sobre a entrega.\nVocê tem um número de rastreamento ou ID do pedido para a remessa? Com isso podemos verificar o status imediatamente.\nSem número de rastreamento? Uma data aproximada ou destino também ajudam.",
      fr: "Nous avons reçu votre signalement de livraison.\nAvez-vous un numéro de suivi ou un identifiant de commande pour l'envoi ? Cela nous permettra de vérifier le statut immédiatement.\nPas de numéro de suivi ? Une date approximative ou une destination aident aussi.",
    },
  },

  // ── Security specific (non-critical) ───────────────────────────────────
  {
    id: "security_needs_detail",
    description: "Security signal present but insufficient specificity for automated action",
    when: (ctx) =>
      ctx.departments.includes("Security") &&
      ctx.priority !== "CRITICAL" &&
      ctx.priority !== "HIGH" &&
      ctx.rootsHit.filter((_, i) => ctx.rootCategories[i] === "security").length === 1,
    question: {
      en: "We received your security report.\nWhich account or service was affected? Any additional details about what happened will help our Security team respond quickly.\nIf your account is still accessible, consider securing it now while we investigate.",
      es: "Recibimos tu reporte de seguridad.\n¿Cuál cuenta o servicio fue afectado? Cualquier detalle adicional sobre lo ocurrido ayudará a nuestro equipo de Seguridad a responder rápido.\nSi tu cuenta aún es accesible, considera asegurarla ahora mientras investigamos.",
      pt: "Recebemos seu relatório de segurança.\nQual conta ou serviço foi afetado? Qualquer detalhe adicional sobre o ocorrido ajudará nossa equipe de Segurança a responder rapidamente.\nSe sua conta ainda está acessível, considere protegê-la agora enquanto investigamos.",
      fr: "Nous avons reçu votre signalement de sécurité.\nQuel compte ou service a été affecté ? Tout détail supplémentaire sur ce qui s'est passé aidera notre équipe Sécurité à répondre rapidement.\nSi votre compte est encore accessible, envisagez de le sécuriser pendant notre enquête.",
    },
  },

  // ── Scope / breadth ──────────────────────────────────────────────────────
  {
    id: "too_many_departments",
    description: "Three or more departments detected — intent is too broad to act on",
    when: (ctx) => ctx.departments.length >= 3,
    question: {
      en: "Your message covers a lot of ground and we want to help with all of it.\nTo connect you with the right team first, could you tell us which is your main concern right now?\nWe'll address the others right after — nothing gets dropped.",
      es: "Tu mensaje abarca varios temas y queremos ayudarte con todos.\nPara derivarte al equipo correcto primero, ¿podrías decirnos cuál es tu principal preocupación en este momento?\nAbordaremos los demás justo después — nada se pierde.",
      pt: "Sua mensagem cobre muitos assuntos e queremos ajudar com todos.\nPara encaminhá-lo ao time certo primeiro, poderia nos dizer qual é a sua principal preocupação no momento?\nVamos tratar os outros logo depois — nada fica sem resposta.",
      fr: "Votre message couvre beaucoup de sujets et nous voulons vous aider pour tous.\nPour vous orienter vers la bonne équipe en priorité, pourriez-vous nous indiquer votre principale préoccupation en ce moment ?\nNous traiterons les autres juste après — rien n'est oublié.",
    },
  },

  // ── Intent ambiguity ─────────────────────────────────────────────────────
  {
    id: "intent_ambiguous",
    description: "Only one content root detected — intent is unclear",
    when: (ctx) =>
      ctx.rootsHit.filter((r) => !["MI", "KA", "YU:", "KO?", "SO:", "MAI!"].includes(r)).length <= 1 &&
      ctx.tokenCount >= RESPONSE_THRESHOLDS.MIN_TOKENS_TO_ACT,
    question: {
      en: "We received your message and want to make sure we help you correctly.\nAre you looking to get a refund, report a problem, ask a question, or something else?\nA quick one-liner is all we need to get things moving.",
      es: "Recibimos tu mensaje y queremos asegurarnos de ayudarte de la manera correcta.\n¿Estás buscando obtener un reembolso, reportar un problema, hacer una pregunta o algo más?\nUna sola frase es todo lo que necesitamos para ponernos en marcha.",
      pt: "Recebemos sua mensagem e queremos ter certeza de que vamos ajudar da forma certa.\nVocê está buscando um reembolso, reportar um problema, fazer uma pergunta ou outra coisa?\nUma frase curta é tudo que precisamos para começar.",
      fr: "Nous avons bien reçu votre message et souhaitons vous aider correctement.\nCherchez-vous un remboursement, à signaler un problème, à poser une question ou autre chose ?\nUne simple phrase suffit pour que nous puissions agir.",
    },
  },

  // ── Generic low-signal catch-all — must stay last ─────────────────────
  {
    id: "low_signal",
    description: "Confidence or root coverage below auto threshold — generic clarification",
    when: (ctx) =>
      ctx.confidence < RESPONSE_THRESHOLDS.AUTO_CONFIDENCE ||
      ctx.rootsHit.length < RESPONSE_THRESHOLDS.AUTO_MIN_ROOTS,
    question: {
      en: "We want to make sure we handle your request correctly.\nCould you share a bit more context about what happened and what outcome you're looking for?\nNo need for full detail — just a few more words help us act faster.",
      es: "Queremos asegurarnos de manejar tu solicitud correctamente.\n¿Podrías darnos un poco más de contexto sobre lo que ocurrió y qué resultado estás buscando?\nNo hace falta mucho detalle — unas pocas palabras más nos ayudan a actuar más rápido.",
      pt: "Queremos garantir que sua solicitação seja tratada corretamente.\nPoderia nos dar um pouco mais de contexto sobre o que aconteceu e o que você espera como resultado?\nNão precisa de muito detalhe — só mais algumas palavras já nos ajudam a agir mais rápido.",
      fr: "Nous souhaitons traiter votre demande correctement.\nPourriez-vous nous donner un peu plus de contexte sur ce qui s'est passé et ce que vous attendez comme résultat ?\nPas besoin de tout détailler — quelques mots supplémentaires suffisent pour agir plus vite.",
    },
  },
];

// ---------------------------------------------------------------------------
// Human escalation messages (safe, constructed strings — no firewall needed)
// ---------------------------------------------------------------------------

const HUMAN_MESSAGES: Record<Lang, string> = {
  en: [
    "Your request requires direct attention from one of our specialists.",
    "A team member will reach out to you as soon as possible.",
    "In the meantime, keep any receipts, screenshots, or documents related to your issue — they may come in handy.",
  ].join("\n"),
  es: [
    "Tu solicitud requiere la atención directa de uno de nuestros especialistas.",
    "Un miembro del equipo se pondrá en contacto contigo lo antes posible.",
    "Mientras tanto, conserva cualquier recibo, captura de pantalla o documento relacionado — podría ser útil.",
  ].join("\n"),
  pt: [
    "Sua solicitação requer atenção direta de um de nossos especialistas.",
    "Um membro da equipe entrará em contato com você o mais breve possível.",
    "Enquanto isso, guarde recibos, prints ou documentos relacionados — podem ser úteis.",
  ].join("\n"),
  fr: [
    "Votre demande nécessite l'attention directe d'un de nos spécialistes.",
    "Un membre de notre équipe vous contactera dans les plus brefs délais.",
    "En attendant, conservez tout reçu, capture d'écran ou document lié à votre problème — ils pourraient être utiles.",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

export function applyResponseControl(
  input: ResponseControlInput,
): ResponseDecision {
  const reasons: string[] = [];

  // ── 1. Hard-gate: forced-human conditions ────────────────────────────────

  if (input.firewallForcedHuman) {
    reasons.push("Firewall flagged the draft reply for mandatory human review.");
    return human(input.language, reasons);
  }

  if (input.priority === "CRITICAL") {
    reasons.push("CRITICAL priority always requires human handling.");
    return human(input.language, reasons);
  }

  if (input.departments.includes("Legal")) {
    reasons.push("Legal department involvement mandates a human agent.");
    return human(input.language, reasons);
  }

  if (input.departments.includes("Medical")) {
    reasons.push("Medical department involvement mandates a human agent.");
    return human(input.language, reasons);
  }

  if (
    input.departments.includes("Security") &&
    (input.priority === "HIGH" || input.priority === "CRITICAL")
  ) {
    reasons.push(
      `Active security incident at ${input.priority} priority requires human intervention.`,
    );
    return human(input.language, reasons);
  }

  if (input.confidence < RESPONSE_THRESHOLDS.ESCALATE_CONFIDENCE) {
    reasons.push(
      `Confidence ${input.confidence.toFixed(1)}% is below the escalation floor ` +
        `(${RESPONSE_THRESHOLDS.ESCALATE_CONFIDENCE}%) — cannot act or clarify reliably.`,
    );
    return human(input.language, reasons);
  }

  // ── 2. Auto gate ─────────────────────────────────────────────────────────

  const highEnoughConfidence =
    input.confidence >= RESPONSE_THRESHOLDS.AUTO_CONFIDENCE;
  const enoughRoots = input.rootsHit.length >= RESPONSE_THRESHOLDS.AUTO_MIN_ROOTS;
  const enoughTokens = input.tokenCount >= RESPONSE_THRESHOLDS.MIN_TOKENS_TO_ACT;

  if (highEnoughConfidence && enoughRoots && enoughTokens) {
    reasons.push(
      `Confidence ${input.confidence.toFixed(1)}% ≥ ${RESPONSE_THRESHOLDS.AUTO_CONFIDENCE}%, ` +
        `${input.rootsHit.length} roots ≥ ${RESPONSE_THRESHOLDS.AUTO_MIN_ROOTS}, ` +
        `${input.tokenCount} tokens ≥ ${RESPONSE_THRESHOLDS.MIN_TOKENS_TO_ACT}. Auto-responding.`,
    );
    return {
      mode: "auto",
      text: input.draftResponse,
      reasons,
      clarificationType: null,
    };
  }

  // ── 3. Clarify — first matching template wins ─────────────────────────────

  if (!highEnoughConfidence) {
    reasons.push(
      `Confidence ${input.confidence.toFixed(1)}% < ${RESPONSE_THRESHOLDS.AUTO_CONFIDENCE}%.`,
    );
  }
  if (!enoughRoots) {
    reasons.push(
      `Only ${input.rootsHit.length} roots detected (need ≥ ${RESPONSE_THRESHOLDS.AUTO_MIN_ROOTS}).`,
    );
  }
  if (!enoughTokens) {
    reasons.push(
      `Only ${input.tokenCount} tokens (need ≥ ${RESPONSE_THRESHOLDS.MIN_TOKENS_TO_ACT}).`,
    );
  }

  for (const tpl of CLARIFY_TEMPLATES) {
    if (tpl.when(input)) {
      reasons.push(`Clarification template matched: "${tpl.id}" — ${tpl.description}.`);
      return {
        mode: "clarify",
        text: tpl.question[input.language] ?? tpl.question.en,
        reasons,
        clarificationType: tpl.id,
      };
    }
  }

  // ── 4. Fallback (should not normally be reached) ─────────────────────────

  reasons.push("No template matched — using generic low-signal clarification.");
  const fallback = CLARIFY_TEMPLATES[CLARIFY_TEMPLATES.length - 1]!;
  return {
    mode: "clarify",
    text: fallback.question[input.language] ?? fallback.question.en,
    reasons,
    clarificationType: "low_signal",
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function human(lang: Lang, reasons: string[]): ResponseDecision {
  return {
    mode: "human",
    text: HUMAN_MESSAGES[lang],
    reasons,
    clarificationType: null,
  };
}
