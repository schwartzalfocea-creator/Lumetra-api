import type { ParseResult } from "./parser";
import { ROOTS } from "./roots";
import { applyRules, type RuleContext } from "./rules-engine";
import { resolveDomainConflict, type DomainResolution } from "./domain-priority";

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RouteDecision {
  primaryDepartment: string;
  departments: string[];
  priority: Priority;
  routeUsed: "parser" | "rules" | "ai" | "human" | "clarify";
  confidence: number;
  action: string;
  escalationRisk: "LOW" | "MEDIUM" | "HIGH";
  sla: string;
  timeSavedMin: number;
  costSavedUsd: number;
  matchedRules: string[];
  /** Result from the domain-priority conflict resolution pass. */
  domainResolution: DomainResolution;
}

const DEPT_FOR_OBJECT: Record<string, string> = {};
for (const root of Object.keys(ROOTS.finance)) DEPT_FOR_OBJECT[root] = "Finance";
for (const root of Object.keys(ROOTS.contract)) DEPT_FOR_OBJECT[root] = "Logistics";
for (const root of Object.keys(ROOTS.logistics)) DEPT_FOR_OBJECT[root] = "Logistics";
for (const root of Object.keys(ROOTS.data)) DEPT_FOR_OBJECT[root] = "Support";
for (const root of Object.keys(ROOTS.security)) DEPT_FOR_OBJECT[root] = "Security";
for (const root of Object.keys(ROOTS.health)) DEPT_FOR_OBJECT[root] = "Medical";
// Legal roots must come last so they override any Logistics mapping for shared
// root codes (e.g. CONT which also carries "contract" as a keyword).
for (const root of Object.keys(ROOTS.legal)) DEPT_FOR_OBJECT[root] = "Legal";

const ACTION_FOR_DEPT: Record<string, string> = {
  Finance: "Account Review + Refund Processing",
  Logistics: "Shipment Trace",
  Security: "Account Lock + Fraud Containment",
  Support: "Triage + Reply",
  Medical: "Clinical Triage + Care Routing",
  Legal: "Legal Review + Compliance Hold",
  Escalation: "Immediate Human Review",
};

function slaForPriority(priority: Priority): string {
  switch (priority) {
    case "CRITICAL":
      return "15m";
    case "HIGH":
      return "1h";
    case "MEDIUM":
      return "4h";
    default:
      return "24h";
  }
}

export function routeRequest(parsed: ParseResult): RouteDecision {
  // ── 1. Build initial departments from mode + detected objects ──────────
  const departments: string[] = [];

  const modeDept = parsed.modeEntry.department;
  if (modeDept !== "Escalation") departments.push(modeDept);

  for (const obj of parsed.objects) {
    const dept = DEPT_FOR_OBJECT[obj];
    if (dept && !departments.includes(dept)) departments.push(dept);
  }

  if (departments.length === 0) departments.push("Support");

  // ── 2. Base priority from mode ─────────────────────────────────────────
  const basePriority: Priority = parsed.modeEntry.priority;

  // ── 3. Base route choice (before rules can override) ──────────────────
  let baseRoute: RouteDecision["routeUsed"] = "parser";
  if (parsed.rootsHit.length === 0) baseRoute = "ai";
  else if (parsed.rootsHit.length < 3) baseRoute = "rules";

  // ── 4. Base action from primary department ─────────────────────────────
  const baseAction = ACTION_FOR_DEPT[departments[0]!] ?? "Triage + Reply";

  // ── 5. Run the rules engine ────────────────────────────────────────────
  const initialCtx: RuleContext = {
    rootsHit: parsed.rootsHit,
    departments,
    priority: basePriority,
    modifiers: parsed.modifiers,
    states: parsed.states,
    modeCode: parsed.mode,
    escalationRisk: "LOW",
    action: baseAction,
    routeUsed: baseRoute,
  };

  const result = applyRules(initialCtx);

  // ── 6. Domain-priority conflict resolution ─────────────────────────────
  // Runs AFTER the rules engine so it can see any departments the rules
  // engine added (e.g. escalation upgrades, cross-domain injections).
  const domainResolution = resolveDomainConflict(
    result.departments,
    result.priority,
  );

  // Use the resolver's outputs for the definitive department list and
  // priority — the resolver never lowers priority.
  const resolvedDepts = domainResolution.departments;
  const resolvedPriority: Priority = domainResolution.priority;

  // Escalation triggered by domain conflict → promote escalation risk
  const resolvedEscalationRisk: RouteDecision["escalationRisk"] =
    domainResolution.escalated ? "HIGH" : result.escalationRisk;

  // Action reflects the resolved primary department
  const resolvedAction =
    ACTION_FOR_DEPT[domainResolution.primary] ?? result.action;

  // ── 7. Confidence: scales with distinct root hits + input length ───────
  const baseConfidence = 70 + parsed.rootsHit.length * 4;
  const confidence = Math.min(99.4, baseConfidence + (parsed.rawTokens.length % 8));

  // ── 8. Savings estimates ───────────────────────────────────────────────
  const timeSavedMin = Math.max(
    3,
    Math.round(
      4 +
        resolvedDepts.length * 2.5 +
        (resolvedPriority === "HIGH" || resolvedPriority === "CRITICAL" ? 4 : 0),
    ),
  );
  const costSavedUsd = +(0.42 + resolvedDepts.length * 1.8 + timeSavedMin * 0.31).toFixed(2);

  return {
    primaryDepartment: domainResolution.primary,
    departments: resolvedDepts,
    priority: resolvedPriority,
    routeUsed: result.routeUsed,
    confidence: +confidence.toFixed(1),
    action: resolvedAction,
    escalationRisk: resolvedEscalationRisk,
    sla: slaForPriority(resolvedPriority),
    timeSavedMin,
    costSavedUsd,
    matchedRules: result.matchedRules,
    domainResolution,
  };
}
