// ---------------------------------------------------------------------------
// Business Action Executor
//
// Deterministic action table that fires based on department, priority, and
// pipeline state — no AI involved.  Each rule runs in a fixed order so the
// resulting action list is always predictable and auditable.
// ---------------------------------------------------------------------------

export type BusinessActionType =
  | "ASSIGN_QUEUE"
  | "CREATE_URGENT_TICKET"
  | "ESCALATE_TO_HUMAN"
  | "FLAG_SECURITY_INCIDENT"
  | "FLAG_MEDICAL_TRIAGE"
  | "FLAG_LEGAL_HOLD"
  | "FLAG_FINANCE_ALERT"
  | "NOTIFY_COMPLIANCE"
  | "REQUEST_CALLBACK"
  | "AUTO_CLOSE_ELIGIBLE"
  | "SEND_VIA_CHANNEL";

export interface ActionResult {
  type: BusinessActionType;
  status: "executed" | "skipped";
  reason: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface ExecutionContext {
  requestId: number;
  department: string;
  departments: string[];
  priority: string;
  sla: string;
  responseControlMode: string;
  firewallAction: string;
  domainEscalated: boolean;
  domainRulesApplied: string[];
  source: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString();
}

function generateTicketId(requestId: number): string {
  const base = (requestId > 0 ? requestId : Date.now())
    .toString(36)
    .toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `TKT-${base}-${rand}`;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export function executeActions(ctx: ExecutionContext): ActionResult[] {
  const actions: ActionResult[] = [];

  // ── Rule 1: ASSIGN_QUEUE — always fires ─────────────────────────────────
  actions.push({
    type: "ASSIGN_QUEUE",
    status: "executed",
    reason: `Routed to ${ctx.department} department queue (SLA: ${ctx.sla})`,
    metadata: { department: ctx.department, sla: ctx.sla, priority: ctx.priority },
    timestamp: ts(),
  });

  // ── Rule 2: CREATE_URGENT_TICKET — HIGH or CRITICAL ──────────────────────
  if (ctx.priority === "HIGH" || ctx.priority === "CRITICAL") {
    actions.push({
      type: "CREATE_URGENT_TICKET",
      status: "executed",
      reason: `${ctx.priority} priority requires immediate ticket creation`,
      metadata: {
        ticketId: generateTicketId(ctx.requestId),
        priority: ctx.priority,
        department: ctx.department,
      },
      timestamp: ts(),
    });
  }

  // ── Rule 3: ESCALATE_TO_HUMAN ─────────────────────────────────────────────
  const triggers: string[] = [];
  if (ctx.priority === "CRITICAL") triggers.push("CRITICAL_PRIORITY");
  if (ctx.domainEscalated) triggers.push("DOMAIN_CONFLICT");
  if (ctx.responseControlMode === "human") triggers.push("RESPONSE_CONTROL");
  if (ctx.firewallAction === "human_review") triggers.push("FIREWALL_GATE");

  if (triggers.length > 0) {
    const primary =
      ctx.domainEscalated
        ? "Multi-domain conflict rule requires human review"
        : ctx.priority === "CRITICAL"
          ? "CRITICAL priority — human agent mandatory"
          : ctx.firewallAction === "human_review"
            ? "Firewall blocked auto-reply — human review required"
            : "Response control escalated to human";
    actions.push({
      type: "ESCALATE_TO_HUMAN",
      status: "executed",
      reason: primary,
      metadata: { triggers },
      timestamp: ts(),
    });
  }

  // ── Rule 4: FLAG_SECURITY_INCIDENT ────────────────────────────────────────
  if (ctx.departments.includes("Security")) {
    actions.push({
      type: "FLAG_SECURITY_INCIDENT",
      status: "executed",
      reason: "Security domain detected — logging to incident register",
      metadata: { severity: ctx.priority },
      timestamp: ts(),
    });
  }

  // ── Rule 5: FLAG_MEDICAL_TRIAGE ───────────────────────────────────────────
  if (ctx.departments.includes("Medical")) {
    actions.push({
      type: "FLAG_MEDICAL_TRIAGE",
      status: "executed",
      reason: "Medical domain detected — flagging for clinical triage queue",
      metadata: { priority: ctx.priority },
      timestamp: ts(),
    });
  }

  // ── Rule 6: FLAG_LEGAL_HOLD ───────────────────────────────────────────────
  if (ctx.departments.includes("Legal")) {
    actions.push({
      type: "FLAG_LEGAL_HOLD",
      status: "executed",
      reason: "Legal domain detected — case placed on legal hold, blocking auto-close",
      timestamp: ts(),
    });
  }

  // ── Rule 7: FLAG_FINANCE_ALERT — Finance + HIGH/CRITICAL ─────────────────
  if (
    ctx.departments.includes("Finance") &&
    (ctx.priority === "HIGH" || ctx.priority === "CRITICAL")
  ) {
    actions.push({
      type: "FLAG_FINANCE_ALERT",
      status: "executed",
      reason: `Finance domain with ${ctx.priority} priority — alerting finance operations team`,
      metadata: { priority: ctx.priority },
      timestamp: ts(),
    });
  }

  // ── Rule 8: NOTIFY_COMPLIANCE ─────────────────────────────────────────────
  const securityAndLegal =
    ctx.departments.includes("Security") && ctx.departments.includes("Legal");
  if (securityAndLegal || ctx.domainEscalated || ctx.priority === "CRITICAL") {
    actions.push({
      type: "NOTIFY_COMPLIANCE",
      status: "executed",
      reason: ctx.priority === "CRITICAL"
        ? "CRITICAL priority — compliance notification dispatched"
        : ctx.domainEscalated
          ? "Multi-domain escalation — compliance review required"
          : "Security + Legal combination — regulatory disclosure review triggered",
      timestamp: ts(),
    });
  }

  // ── Rule 9: REQUEST_CALLBACK ──────────────────────────────────────────────
  const isTripleDomain = ctx.domainRulesApplied.some(
    (r) => r.split("+").length >= 3,
  );
  const needsCallback =
    (ctx.departments.includes("Medical") && ctx.priority === "CRITICAL") ||
    ctx.departments.includes("Escalation") ||
    isTripleDomain;

  if (needsCallback) {
    actions.push({
      type: "REQUEST_CALLBACK",
      status: "executed",
      reason: isTripleDomain
        ? "Triple-domain conflict — priority callback scheduled"
        : ctx.departments.includes("Medical") && ctx.priority === "CRITICAL"
          ? "Critical medical case — emergency callback initiated"
          : "Escalation department — human callback required",
      timestamp: ts(),
    });
  }

  // ── Rule 10: AUTO_CLOSE_ELIGIBLE ──────────────────────────────────────────
  const canAutoClose =
    ctx.priority === "LOW" &&
    ctx.departments.length === 1 &&
    ctx.responseControlMode === "send" &&
    ctx.firewallAction === "send" &&
    !ctx.domainEscalated &&
    !ctx.departments.includes("Legal") &&
    !ctx.departments.includes("Medical") &&
    !ctx.departments.includes("Security");

  if (canAutoClose) {
    actions.push({
      type: "AUTO_CLOSE_ELIGIBLE",
      status: "executed",
      reason:
        "Low-complexity, single-department case — eligible for auto-close after customer confirmation",
      timestamp: ts(),
    });
  }

  // ── Rule 11: SEND_VIA_CHANNEL — always last ───────────────────────────────
  actions.push({
    type: "SEND_VIA_CHANNEL",
    status: "executed",
    reason: `Dispatching response via ${ctx.source}-preferred channel routing`,
    metadata: { source: ctx.source },
    timestamp: ts(),
  });

  return actions;
}
