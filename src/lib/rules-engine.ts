/**
 * Rule-based decision layer for the Lumetra intake pipeline.
 *
 * Each IntakeRule is a self-contained unit with:
 *   - name        → unique identifier, surfaced in the API response for tracing
 *   - description → human-readable explanation of the rule's purpose
 *   - when(ctx)   → predicate: returns true when this rule should fire
 *   - apply(ctx)  → returns a partial RuleContext that patches the current state
 *
 * Rules are evaluated in order. Each rule sees the *current* (already-patched)
 * context, so rules can cascade into each other naturally. Add new rules to
 * the RULES array — no other file needs to change.
 *
 * To add a new rule:
 *   1. Define it as an IntakeRule literal below.
 *   2. Insert it into RULES at the right position (earlier rules run first).
 *   3. Done. The engine picks it up automatically.
 */

import type { Priority } from "./router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleContext {
  rootsHit: string[];
  departments: string[];
  priority: Priority;
  modifiers: string[];
  states: string[];
  modeCode: string;
  escalationRisk: "LOW" | "MEDIUM" | "HIGH";
  action: string;
  routeUsed: "parser" | "rules" | "ai" | "human" | "clarify";
}

export interface IntakeRule {
  name: string;
  description: string;
  when: (ctx: RuleContext) => boolean;
  apply: (ctx: RuleContext) => Partial<RuleContext>;
}

export interface RulesResult extends RuleContext {
  matchedRules: string[];
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

export const RULES: IntakeRule[] = [
  // ── Department enrichment ──────────────────────────────────────────────
  {
    name: "security_objects_add_dept",
    description:
      "If a fraud, hack, or phishing root is detected, ensure Security is included in the department list.",
    when: (ctx) =>
      ctx.rootsHit.some((r) => ["HACK", "FRAU", "PHIS"].includes(r)),
    apply: (ctx) =>
      ctx.departments.includes("Security")
        ? {}
        : { departments: [...ctx.departments, "Security"] },
  },

  // ── Priority escalation ────────────────────────────────────────────────
  {
    name: "security_objects_min_high",
    description:
      "Fraud, hack, or phishing signals require at least HIGH priority to ensure fast containment.",
    when: (ctx) =>
      ctx.rootsHit.some((r) => ["HACK", "FRAU", "PHIS"].includes(r)) &&
      ctx.priority !== "CRITICAL",
    apply: () => ({ priority: "HIGH" }),
  },
  {
    name: "strong_modifier_bump",
    description:
      "The -SU (strong/urgent) modifier signals heightened urgency; MEDIUM priority is bumped to HIGH.",
    when: (ctx) =>
      ctx.modifiers.includes("-SU") && ctx.priority === "MEDIUM",
    apply: () => ({ priority: "HIGH" }),
  },
  {
    name: "multi_dept_nil_state_bump",
    description:
      "Two or more departments combined with a NIL state (nothing is working) indicates a systemic issue; MEDIUM bumps to HIGH.",
    when: (ctx) =>
      ctx.departments.length >= 2 &&
      ctx.states.includes("NIL") &&
      ctx.priority === "MEDIUM",
    apply: () => ({ priority: "HIGH" }),
  },
  {
    name: "critical_mode_security_root",
    description:
      "A CRITICAL-mode request that also mentions security roots is immediately CRITICAL regardless of other signals.",
    when: (ctx) =>
      ctx.modeCode === "MAI!" &&
      ctx.rootsHit.some((r) => ["HACK", "FRAU", "PHIS", "VIOL"].includes(r)),
    apply: () => ({ priority: "CRITICAL" }),
  },

  // ── Action composition ─────────────────────────────────────────────────
  {
    name: "finance_logistics_combined_action",
    description:
      "When Finance and Logistics are both involved, the action becomes a combined Refund + Shipment Trace.",
    when: (ctx) =>
      ctx.departments.includes("Finance") &&
      ctx.departments.includes("Logistics"),
    apply: () => ({ action: "Refund + Shipment Trace" }),
  },
  {
    name: "security_finance_combined_action",
    description:
      "Security + Finance together indicate potential fraud on an account; the action becomes Account Lock + Fraud Investigation.",
    when: (ctx) =>
      ctx.departments.includes("Security") &&
      ctx.departments.includes("Finance"),
    apply: () => ({ action: "Account Lock + Fraud Investigation" }),
  },
  {
    name: "escalation_mode_action",
    description:
      "CRITICAL-priority requests get the Immediate Human Review action to ensure no automated response is sent alone.",
    when: (ctx) => ctx.priority === "CRITICAL",
    apply: () => ({ action: "Immediate Human Review" }),
  },

  // ── Routing overrides ──────────────────────────────────────────────────
  {
    name: "legal_medical_force_human",
    description:
      "Legal and Medical cases carry liability risk and must always be routed to a human agent.",
    when: (ctx) =>
      ctx.departments.includes("Legal") ||
      ctx.departments.includes("Medical"),
    apply: () => ({ routeUsed: "human" }),
  },
  {
    name: "critical_priority_force_human",
    description:
      "CRITICAL-priority requests are too high-risk for automated responses and always require human handling.",
    when: (ctx) => ctx.priority === "CRITICAL",
    apply: () => ({ routeUsed: "human" }),
  },

  // ── Escalation risk ────────────────────────────────────────────────────
  {
    name: "critical_high_escalation_risk",
    description:
      "CRITICAL priority always signals HIGH escalation risk.",
    when: (ctx) => ctx.priority === "CRITICAL",
    apply: () => ({ escalationRisk: "HIGH" }),
  },
  {
    name: "security_legal_high_escalation_risk",
    description:
      "Security or Legal department involvement always means HIGH escalation risk.",
    when: (ctx) =>
      ctx.departments.includes("Security") ||
      ctx.departments.includes("Legal"),
    apply: () => ({ escalationRisk: "HIGH" }),
  },
  {
    name: "high_priority_elevate_escalation",
    description:
      "HIGH-priority requests with a LOW escalation risk are upgraded to MEDIUM escalation risk.",
    when: (ctx) =>
      ctx.priority === "HIGH" && ctx.escalationRisk === "LOW",
    apply: () => ({ escalationRisk: "MEDIUM" }),
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run all rules against the initial context and return the final state
 * together with a list of rule names that fired (for API traceability).
 *
 * Pass a custom `rules` array to override the built-in set — useful for
 * testing individual rules or adding domain-specific rules at runtime.
 */
export function applyRules(
  initial: RuleContext,
  rules: IntakeRule[] = RULES,
): RulesResult {
  let ctx: RuleContext = { ...initial };
  const matchedRules: string[] = [];

  for (const rule of rules) {
    if (rule.when(ctx)) {
      const patch = rule.apply(ctx);
      ctx = { ...ctx, ...patch };
      matchedRules.push(rule.name);
    }
  }

  return { ...ctx, matchedRules };
}
