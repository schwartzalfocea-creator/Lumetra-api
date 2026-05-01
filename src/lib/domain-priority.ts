/**
 * domain-priority.ts
 *
 * Deterministic multi-domain conflict resolution for the LUMETRA routing pipeline.
 *
 * Problem: when multiple high-signal domains are detected simultaneously (e.g.
 * Legal + Logistics, Medical + Security), the system previously emitted all of
 * them as a flat union.  This module applies a conflict matrix to produce a
 * single authoritative primary department, a minimum priority floor, and a
 * traceable set of rule names and reasons — so every routing decision is
 * explainable and deterministic.
 *
 * Resolution strategy
 * ───────────────────
 *  1. Triple-domain critical rules are checked first (highest severity).
 *  2. Two-domain rules are checked in severity order.
 *  3. If no specific rule matches, the natural priority ranking is used.
 *  4. Priority is NEVER decreased — a matching rule can only raise it.
 */

import type { Priority } from "./router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainResolution {
  /** The department that owns / leads this case. */
  primary: string;
  /**
   * All departments that should receive the case:
   *   - escalated  → ["Escalation", ...original depts]
   *   - dominant   → [primary, ...coOwners, ...remaining-if-any]
   *   - fallback   → natural-priority-sorted originals
   */
  departments: string[];
  /** True when the case was routed to Escalation. */
  escalated: boolean;
  /** Resolved priority (never less than the incoming value). */
  priority: Priority;
  /** Machine-readable names of the conflict rules that fired. */
  rulesApplied: string[];
  /** Human-readable explanations for each applied rule. */
  reasons: string[];
}

interface ConflictRule {
  /** Unique machine-readable name used in audit trails and tests. */
  name: string;
  /** ALL of these departments must be present for this rule to match. */
  requires: string[];
  /**
   * Which department leads the resolution.
   * Use "Escalation" to force escalation.
   */
  primary: string;
  /**
   * Additional departments that co-own the case alongside `primary`.
   * Other detected departments beyond these are dropped from the queue.
   */
  coOwners?: string[];
  /**
   * When true, the primary is forced to "Escalation" and all original
   * departments are retained so they can each receive the escalated ticket.
   */
  escalate: boolean;
  /** Minimum priority floor this rule enforces. */
  minPriority: Priority;
  /** Human-readable explanation surfaced in the API response. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Natural priority ranking (used when no specific rule matches)
// ---------------------------------------------------------------------------

const DEPT_NATURAL_PRIORITY: Record<string, number> = {
  Escalation: 100,
  Medical: 80,
  Security: 70,
  Legal: 60,
  Finance: 40,
  Support: 30,
  Logistics: 20,
};

// ---------------------------------------------------------------------------
// Conflict resolution matrix
// Rules are checked in ORDER — the first match (most severe) wins.
// ---------------------------------------------------------------------------

const CONFLICT_RULES: ConflictRule[] = [
  // ── Triple-domain critical conflicts ──────────────────────────────────────

  {
    name: "medical+legal+security",
    requires: ["Medical", "Legal", "Security"],
    primary: "Escalation",
    escalate: true,
    minPriority: "CRITICAL",
    reason:
      "Triple-domain conflict (medical, legal, security): maximum complexity — immediate human review required",
  },
  {
    name: "medical+legal+finance",
    requires: ["Medical", "Legal", "Finance"],
    primary: "Escalation",
    escalate: true,
    minPriority: "CRITICAL",
    reason:
      "Triple-domain conflict (medical, legal, finance): potential healthcare liability and financial exposure — immediate human review required",
  },
  {
    name: "legal+security+finance",
    requires: ["Legal", "Security", "Finance"],
    primary: "Escalation",
    escalate: true,
    minPriority: "CRITICAL",
    reason:
      "Triple-domain conflict (legal, security, finance): possible fraud lawsuit and financial breach — immediate human review required",
  },

  // ── Two-domain — escalated (critical) ─────────────────────────────────────

  {
    name: "medical+legal",
    requires: ["Medical", "Legal"],
    primary: "Escalation",
    coOwners: ["Medical", "Legal"],
    escalate: true,
    minPriority: "CRITICAL",
    reason:
      "Medical + legal conflict: possible malpractice, personal injury claim, or healthcare liability — escalating for joint clinical and legal review",
  },

  // ── Two-domain — dominant (HIGH) ─────────────────────────────────────────

  {
    name: "legal+security",
    requires: ["Legal", "Security"],
    primary: "Legal",
    coOwners: ["Security"],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Legal + security conflict: possible data breach lawsuit or GDPR non-compliance claim — Legal leads with Security co-assigned",
  },
  {
    name: "medical+security",
    requires: ["Medical", "Security"],
    primary: "Medical",
    coOwners: ["Security"],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Medical + security conflict: possible healthcare data breach — Medical leads with Security co-assigned",
  },
  {
    name: "legal+finance",
    requires: ["Legal", "Finance"],
    primary: "Legal",
    coOwners: ["Finance"],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Legal + finance conflict: possible civil claim or financial dispute — Legal leads with Finance co-assigned for account review",
  },
  {
    name: "security+finance",
    requires: ["Security", "Finance"],
    primary: "Security",
    coOwners: ["Finance"],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Security + finance conflict: possible account compromise or payment fraud — Security leads with Finance co-assigned for exposure assessment",
  },

  // ── Two-domain — dominant with suppression ────────────────────────────────
  // Lower-priority domain is dropped from the queue (not a co-owner).

  {
    name: "legal+logistics",
    requires: ["Legal", "Logistics"],
    primary: "Legal",
    coOwners: [],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Legal supersedes Logistics: contract breach or liability claim overrides shipment tracking — routing entirely to Legal",
  },
  {
    name: "medical+logistics",
    requires: ["Medical", "Logistics"],
    primary: "Medical",
    coOwners: ["Logistics"],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Medical supersedes Logistics: health and safety takes priority — Medical leads, Logistics co-assigned for supply/delivery coordination",
  },
  {
    name: "security+logistics",
    requires: ["Security", "Logistics"],
    primary: "Security",
    coOwners: [],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Security supersedes Logistics: possible package interception or delivery fraud — routing entirely to Security",
  },
  {
    name: "legal+support",
    requires: ["Legal", "Support"],
    primary: "Legal",
    coOwners: [],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Legal supersedes Support: routing to Legal Review — general support inquiry is absorbed into the legal case",
  },
  {
    name: "medical+support",
    requires: ["Medical", "Support"],
    primary: "Medical",
    coOwners: [],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Medical supersedes Support: routing to Clinical Triage — general support inquiry is absorbed into the medical case",
  },
  {
    name: "security+support",
    requires: ["Security", "Support"],
    primary: "Security",
    coOwners: [],
    escalate: false,
    minPriority: "HIGH",
    reason:
      "Security supersedes Support: routing to Security Containment — general support inquiry is absorbed into the security case",
  },

  // ── Two-domain — shared ownership (MEDIUM) ────────────────────────────────

  {
    name: "finance+logistics",
    requires: ["Finance", "Logistics"],
    primary: "Logistics",
    coOwners: ["Finance"],
    escalate: false,
    minPriority: "MEDIUM",
    reason:
      "Finance + Logistics: billing issue on a shipment — Logistics leads for order resolution, Finance co-assigned for refund/charge review",
  },
  {
    name: "finance+support",
    requires: ["Finance", "Support"],
    primary: "Finance",
    coOwners: [],
    escalate: false,
    minPriority: "MEDIUM",
    reason:
      "Finance supersedes Support: routing to Account Review — general support inquiry absorbed into the financial case",
  },
];

// ---------------------------------------------------------------------------
// Priority utilities
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function maxPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_ORDER.indexOf(a) >= PRIORITY_ORDER.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Core resolution function
// ---------------------------------------------------------------------------

/**
 * Resolve multi-domain conflicts into a single deterministic routing decision.
 *
 * @param rawDepartments  The flat list of departments detected by parser + rules
 * @param currentPriority The priority already established by the rules engine
 * @returns A `DomainResolution` describing who owns the case and why
 */
export function resolveDomainConflict(
  rawDepartments: string[],
  currentPriority: Priority,
): DomainResolution {
  // ── Fast path: no conflict ─────────────────────────────────────────────
  if (rawDepartments.length <= 1) {
    return {
      primary: rawDepartments[0] ?? "Support",
      departments: rawDepartments.length ? [...rawDepartments] : ["Support"],
      escalated: false,
      priority: currentPriority,
      rulesApplied: [],
      reasons: [],
    };
  }

  // ── Deduplicate while preserving order ────────────────────────────────
  const depts = [...new Set(rawDepartments)];

  const rulesApplied: string[] = [];
  const reasons: string[] = [];
  let resolvedPriority: Priority = currentPriority;

  // ── Scan conflict matrix (first match wins) ───────────────────────────
  let matchedRule: ConflictRule | null = null;
  for (const rule of CONFLICT_RULES) {
    if (rule.requires.every((d) => depts.includes(d))) {
      matchedRule = rule;
      rulesApplied.push(rule.name);
      reasons.push(rule.reason);
      resolvedPriority = maxPriority(resolvedPriority, rule.minPriority);
      break; // first (most severe) match wins
    }
  }

  // ── Apply matched rule ────────────────────────────────────────────────
  if (matchedRule) {
    if (matchedRule.escalate) {
      // Escalated: primary is Escalation; all original departments are
      // retained in the queue so each team gets visibility.
      const allDepts = [
        "Escalation",
        ...depts.filter((d) => d !== "Escalation"),
      ];
      return {
        primary: "Escalation",
        departments: allDepts,
        escalated: true,
        priority: resolvedPriority,
        rulesApplied,
        reasons,
      };
    } else {
      // Dominant domain: primary + declared co-owners only.
      // Any domain not in primary or coOwners is suppressed.
      const coOwners = matchedRule.coOwners ?? [];
      const orderedDepts = [
        matchedRule.primary,
        ...coOwners.filter((d) => d !== matchedRule!.primary),
      ];
      // Retain any remaining detected domains that aren't mapped yet,
      // so nothing is silently lost when new domain combinations appear.
      for (const dept of depts) {
        if (!orderedDepts.includes(dept)) {
          orderedDepts.push(dept);
        }
      }
      return {
        primary: matchedRule.primary,
        departments: orderedDepts,
        escalated: false,
        priority: resolvedPriority,
        rulesApplied,
        reasons,
      };
    }
  }

  // ── Fallback: natural priority ranking ───────────────────────────────
  const sorted = [...depts].sort(
    (a, b) =>
      (DEPT_NATURAL_PRIORITY[b] ?? 0) - (DEPT_NATURAL_PRIORITY[a] ?? 0),
  );

  const fallbackReason = `No specific conflict rule matched; resolved by natural domain priority: ${sorted.join(" > ")}`;

  return {
    primary: sorted[0]!,
    departments: sorted,
    escalated: false,
    priority: resolvedPriority,
    rulesApplied: ["natural_priority_fallback"],
    reasons: [fallbackReason],
  };
}
