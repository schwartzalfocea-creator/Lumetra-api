import { parseInput } from "./parser";
import { routeRequest, type RouteDecision, type Priority } from "./router";
import { generateResponse } from "./responder";
import { persistRequest } from "./repository";
import { enqueueForDepartments } from "./queue-repository";
import { classifyWithAi, type AiClassification } from "./ai-classifier";
import { applyFirewall, type FirewallVerdict } from "./firewall";
import { applyRules, type RuleContext } from "./rules-engine";
import {
  applyResponseControl,
  type ResponseDecision,
  type ResponseMode,
} from "./response-control";
import { resolveDomainConflict } from "./domain-priority";
import { executeActions, type ActionResult } from "./action-executor";
import { routeToChannels, type ChannelDispatch } from "./channel-router";
import { logger } from "./logger";

export interface IntakeInput {
  text: string;
  source?: string;
  /** Recipient phone number (E.164 format, e.g. +14155551234) for WhatsApp dispatch. */
  toPhone?: string;
  /** Recipient email address for email dispatch. */
  toEmail?: string;
  /** Sender display name — used in email salutation. */
  fromName?: string;
}

export interface IntakeResult {
  id: number;
  language: string;
  lumetra_code: string;
  final_response: string;
  department: string;
  departments: string[];
  priority: string;
  confidence: number;
  route_used: string;
  action: string;
  escalation_risk: string;
  sla: string;
  time_saved_min: number;
  cost_saved_usd: number;
  latency_ms: number;
  roots_hit: string[];
  hits: Array<{
    root: string;
    category: string;
    meaning: string;
    matched: string;
  }>;
  semantic_code: string;
  timestamp: string;
  matched_rules: string[];
  ai: {
    used: boolean;
    model: string | null;
    reasoning: string | null;
    flags: string[];
  };
  firewall: {
    action: "send" | "rewrite" | "human_review";
    flags: string[];
    reasons: string[];
  };
  /** Deterministic response control decision. */
  response_control: {
    mode: ResponseMode;
    clarification_type: string | null;
    reasons: string[];
  };
  /** Domain-priority conflict resolution result. */
  domain_resolution: {
    primary: string;
    escalated: boolean;
    rules_applied: string[];
    reasons: string[];
  };
  /** Deterministic business actions executed after final decision. */
  business_actions: ActionResult[];
  /** Channel dispatch results (WhatsApp / Email) ordered by source preference. */
  channel_dispatch: ChannelDispatch[];
}

// ---------------------------------------------------------------------------
// AI invocation gate
//
// AI is only invoked when the deterministic parser + rules engine cannot
// produce a reliable routing decision.  The thresholds are intentionally
// strict: requests that fall in the 65–80 % confidence band are handled by
// the response-control layer's clarification mode, not by AI.
// ---------------------------------------------------------------------------

/** Confidence (%) below which the AI classifier is invoked. */
const AI_CONFIDENCE_THRESHOLD = 65;

/**
 * Minimum root hits required to skip the AI.
 * Fewer than this → AI is invoked regardless of confidence.
 */
const AI_ROOT_HITS_THRESHOLD = 2;

function shouldInvokeAi(
  parsedRootsCount: number,
  decisionConfidence: number,
): boolean {
  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) return false;
  if (parsedRootsCount < AI_ROOT_HITS_THRESHOLD) return true;
  if (decisionConfidence < AI_CONFIDENCE_THRESHOLD) return true;
  return false;
}

/**
 * Merge the AI classification into the current parser-derived decision,
 * then re-run the rules engine so that any newly surfaced departments or
 * context gets the full benefit of the rule set.
 */
function mergeAiIntoDecision(
  decision: RouteDecision,
  ai: AiClassification,
  originalCtx: {
    rootsHit: string[];
    modifiers: string[];
    states: string[];
    modeCode: string;
  },
): RouteDecision {
  // Merge departments (union)
  const merged: string[] = [...decision.departments];
  for (const dept of ai.departments) {
    if (!merged.includes(dept)) merged.push(dept);
  }

  // Take the higher of the two priorities
  const order: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const ruleIdx = order.indexOf(decision.priority);
  const aiIdx = order.indexOf(ai.priority);
  const mergedPriority: Priority =
    order[Math.max(ruleIdx, aiIdx)] ?? decision.priority;

  // Blend confidence 55 / 45 (parser vs AI)
  const blendedConfidence = +(
    decision.confidence * 0.55 +
    ai.confidence * 0.45
  ).toFixed(1);

  // Prefer the AI action when available; the rules engine may override it
  const mergedAction = ai.action || decision.action;

  // Re-run the rules engine with the now-combined context so all
  // department-combination rules and escalation rules fire correctly.
  const ctx: RuleContext = {
    rootsHit: originalCtx.rootsHit,
    departments: merged,
    priority: mergedPriority,
    modifiers: originalCtx.modifiers,
    states: originalCtx.states,
    modeCode: originalCtx.modeCode,
    escalationRisk: decision.escalationRisk,
    action: mergedAction,
    routeUsed: "ai",
  };

  const result = applyRules(ctx);

  // Re-run domain conflict resolution on the post-AI, post-rules departments.
  const domainResolution = resolveDomainConflict(
    result.departments,
    result.priority,
  );

  const sla =
    domainResolution.priority === "CRITICAL"
      ? "15m"
      : domainResolution.priority === "HIGH"
        ? "1h"
        : domainResolution.priority === "MEDIUM"
          ? "4h"
          : "24h";

  // Merge the rule names from both passes (parser pass + AI pass)
  const combinedRules = [
    ...decision.matchedRules,
    ...result.matchedRules.filter((r) => !decision.matchedRules.includes(r)),
  ];

  return {
    ...decision,
    departments: domainResolution.departments,
    primaryDepartment: domainResolution.primary,
    priority: domainResolution.priority,
    confidence: blendedConfidence,
    action: result.action,
    routeUsed: result.routeUsed,
    escalationRisk: domainResolution.escalated ? "HIGH" : result.escalationRisk,
    sla,
    matchedRules: combinedRules,
    domainResolution,
  };
}

export async function processIntake(input: IntakeInput): Promise<IntakeResult> {
  const startedAt = Date.now();
  const text = input.text.trim();
  const source = input.source ?? "web";

  // ── 1. Parse & route (deterministic) ─────────────────────────────────────

  const parsed = parseInput(text);
  let decision = routeRequest(parsed);
  let draftResponse = generateResponse(parsed.language, decision);

  // ── 2. Optional AI classification (strict confidence gate) ───────────────

  let aiResult: AiClassification | null = null;
  const aiFlags: string[] = [];

  if (shouldInvokeAi(parsed.rootsHit.length, decision.confidence)) {
    try {
      aiResult = await classifyWithAi(text, parsed.language, parsed.rootsHit);
      decision = mergeAiIntoDecision(decision, aiResult, {
        rootsHit: parsed.rootsHit,
        modifiers: parsed.modifiers,
        states: parsed.states,
        modeCode: parsed.mode,
      });

      if (aiResult.suggestedReply.trim().length > 0) {
        draftResponse = aiResult.suggestedReply;
      } else {
        draftResponse = generateResponse(parsed.language, decision);
      }

      aiFlags.push(...aiResult.flags);
    } catch (err) {
      logger.warn(
        { err },
        "AI classifier failed; continuing with parser+rules result",
      );
      aiFlags.push("ai_unavailable");
    }
  }

  // ── 3. Firewall — sanitize the draft text ────────────────────────────────

  const firewall: FirewallVerdict = applyFirewall({
    draftReply: draftResponse,
    language: parsed.language,
    departments: decision.departments,
    priority: decision.priority,
    confidence: decision.confidence,
    flags: aiFlags,
  });

  // ── 4. Response Control — deterministic mode decision ────────────────────
  //
  // Runs AFTER the firewall so it can use the sanitized text and the
  // firewall's human_review verdict as hard-gate inputs.

  const responseControl: ResponseDecision = applyResponseControl({
    rootsHit: parsed.rootsHit,
    rootCategories: parsed.hits.map((h) => h.category),
    departments: decision.departments,
    priority: decision.priority,
    confidence: decision.confidence,
    modifiers: parsed.modifiers,
    states: parsed.states,
    modeCode: parsed.mode,
    tokenCount: parsed.rawTokens?.length ?? text.split(/\s+/).length,
    language: parsed.language,
    aiWasUsed: aiResult !== null,
    firewallForcedHuman: firewall.action === "human_review",
    draftResponse: firewall.sanitizedReply,
  });

  const finalResponse = responseControl.text;

  // Reflect the response-control mode in route_used when it escalates
  if (responseControl.mode === "human") {
    decision = { ...decision, routeUsed: "human" };
  } else if (responseControl.mode === "clarify") {
    decision = { ...decision, routeUsed: "clarify" };
  }

  // ── 5. Persist & enqueue ─────────────────────────────────────────────────

  const latency = Date.now() - startedAt;

  let row = {
    id: 0,
    timestamp: new Date(),
  };

  try {
    row = await persistRequest({
      originalText: text,
      detectedLanguage: parsed.language,
      lumetraCode: parsed.semanticCode,
      finalResponse,
      routeUsed: decision.routeUsed,
      department: decision.primaryDepartment,
      departments: decision.departments,
      priority: decision.priority,
      confidence: decision.confidence,
      source,
      rootsHit: parsed.rootsHit,
      timeSavedMin: decision.timeSavedMin,
      costSavedUsd: decision.costSavedUsd,
      latencyMs: latency,
      aiUsed: aiResult !== null,
      aiModel: aiResult?.modelUsed ?? null,
      aiReasoning: aiResult?.reasoning ?? null,
      firewallAction: firewall.action,
      firewallFlags: firewall.flags,
      matchedRules: decision.matchedRules,
    });

    await enqueueForDepartments(row.id, decision.departments, decision.priority);
  } catch (err) {
    logger.warn("DB failed, continuing without persistence");
  }

  // ── 6. Business action execution (deterministic) ─────────────────────────

  const businessActions = executeActions({
    requestId: row.id,
    department: decision.primaryDepartment,
    departments: decision.departments,
    priority: decision.priority,
    sla: decision.sla,
    responseControlMode: responseControl.mode,
    firewallAction: firewall.action,
    domainEscalated: decision.domainResolution.escalated,
    domainRulesApplied: decision.domainResolution.rulesApplied,
    source,
  });

  // ── 7. Channel dispatch (source-based, no AI) ────────────────────────────

  let channelDispatch: ChannelDispatch[] = [];
  try {
    channelDispatch = await routeToChannels({
      source,
      toPhone: input.toPhone,
      toEmail: input.toEmail,
      fromName: input.fromName,
      message: finalResponse,
      department: decision.primaryDepartment,
      priority: decision.priority,
      sla: decision.sla,
      requestId: row.id,
    });
  } catch (err) {
    logger.warn({ err }, "Channel dispatch failed; continuing without delivery");
  }

  // ── 8. Return full result ─────────────────────────────────────────────────

  return {
    id: row.id,
    language: parsed.language,
    lumetra_code: parsed.semanticCode,
    semantic_code: parsed.semanticCode,
    final_response: finalResponse,
    department: decision.primaryDepartment,
    departments: decision.departments,
    priority: decision.priority,
    confidence: decision.confidence,
    route_used: decision.routeUsed,
    action: decision.action,
    escalation_risk: decision.escalationRisk,
    sla: decision.sla,
    time_saved_min: decision.timeSavedMin,
    cost_saved_usd: decision.costSavedUsd,
    latency_ms: latency,
    roots_hit: parsed.rootsHit,
    hits: parsed.hits,
    timestamp: row.timestamp.toISOString(),
    matched_rules: decision.matchedRules,
    ai: {
      used: aiResult !== null,
      model: aiResult?.modelUsed ?? null,
      reasoning: aiResult?.reasoning ?? null,
      flags: aiFlags,
    },
    firewall: {
      action: firewall.action,
      flags: firewall.flags,
      reasons: firewall.reasons,
    },
    response_control: {
      mode: responseControl.mode,
      clarification_type: responseControl.clarificationType,
      reasons: responseControl.reasons,
    },
    domain_resolution: {
      primary: decision.domainResolution.primary,
      escalated: decision.domainResolution.escalated,
      rules_applied: decision.domainResolution.rulesApplied,
      reasons: decision.domainResolution.reasons,
    },
    business_actions: businessActions,
    channel_dispatch: channelDispatch,
  };
}
