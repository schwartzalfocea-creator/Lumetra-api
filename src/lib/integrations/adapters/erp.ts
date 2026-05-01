// ---------------------------------------------------------------------------
// ERP Adapter
//
// Handles events from enterprise resource-planning systems:
// SAP, Oracle, NetSuite, Microsoft Dynamics, and generic ERP formats.
//
// All normalization is deterministic — no AI.
// ---------------------------------------------------------------------------

import type {
  IntegrationAdapter,
  RawSystemEvent,
  NormalizedEvent,
  SystemType,
} from "../types";

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function extractContact(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): Pick<NormalizedEvent, "to_email" | "to_phone" | "from_name"> {
  return {
    to_email:
      event.customer_email ??
      (str(p.contact_email ?? p.vendor_email ?? p.customer_email ?? p.email ?? "") || undefined),
    to_phone:
      event.customer_phone ??
      (str(p.contact_phone ?? p.phone ?? "") || undefined),
    from_name:
      event.customer_name ??
      (str(p.vendor_name ?? p.customer_name ?? p.contact_name ?? p.supplier_name ?? "") || undefined),
  };
}

function meta(
  event: RawSystemEvent,
  severity: NormalizedEvent["metadata"]["severity"],
  extra?: Record<string, unknown>,
): NormalizedEvent["metadata"] {
  return {
    system: event.system,
    provider: event.provider,
    event_type: event.event_type,
    source_id: event.source_id,
    occurred_at: event.occurred_at ?? new Date().toISOString(),
    severity,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Event templates
// ---------------------------------------------------------------------------

type ERPTemplate = {
  build(p: Record<string, unknown>): string;
  severity: NormalizedEvent["metadata"]["severity"];
};

const TEMPLATES: Record<string, ERPTemplate> = {
  "purchase_order.rejected": {
    build: (p) => {
      const po = str(p.po_number ?? p.order_id ?? p.id ?? "");
      const vendor = str(p.vendor_name ?? p.supplier_name ?? "");
      const reason = str(p.rejection_reason ?? p.reason ?? "");
      const amount = str(p.amount ?? p.total ?? "");
      return `Purchase order rejected${po ? ` #${po}` : ""}${vendor ? ` from ${vendor}` : ""}${amount ? `, value $${amount}` : ""}. ${reason || "Order was not approved."} Finance and procurement review required.`;
    },
    severity: "high",
  },

  "invoice.overdue": {
    build: (p) => {
      const inv = str(p.invoice_number ?? p.invoice_id ?? p.id ?? "");
      const vendor = str(p.vendor_name ?? p.supplier_name ?? p.customer_name ?? "");
      const amount = str(p.amount ?? p.total ?? p.outstanding ?? "");
      const days = str(p.days_overdue ?? p.overdue_days ?? "");
      return `Invoice overdue${inv ? ` #${inv}` : ""}${vendor ? ` from ${vendor}` : ""}${amount ? `, amount $${amount}` : ""}${days ? `, ${days} days overdue` : ""}. Payment urgently required — finance team must act.`;
    },
    severity: "high",
  },

  "shipment.delayed": {
    build: (p) => {
      const id = str(p.shipment_id ?? p.order_id ?? "");
      const eta = str(p.original_eta ?? p.expected_date ?? "");
      const newEta = str(p.new_eta ?? p.revised_date ?? "");
      const vendor = str(p.supplier_name ?? p.vendor_name ?? "");
      return `Shipment delayed${id ? ` (${id})` : ""}${vendor ? ` from ${vendor}` : ""}${eta ? `. Original ETA: ${eta}` : ""}${newEta ? `. Revised ETA: ${newEta}` : ""}. Logistics and procurement team must review impact.`;
    },
    severity: "medium",
  },

  "contract.expired": {
    build: (p) => {
      const id = str(p.contract_id ?? p.id ?? "");
      const vendor = str(p.vendor_name ?? p.party_name ?? "");
      const value = str(p.contract_value ?? p.annual_value ?? "");
      const expiry = str(p.expiry_date ?? p.end_date ?? "");
      return `Contract expired${id ? ` #${id}` : ""}${vendor ? ` with ${vendor}` : ""}${value ? `, value $${value}` : ""}${expiry ? ` on ${expiry}` : ""}. Legal and procurement review required. Renewal or termination decision needed.`;
    },
    severity: "high",
  },

  "contract.renewal_due": {
    build: (p) => {
      const id = str(p.contract_id ?? p.id ?? "");
      const vendor = str(p.vendor_name ?? p.party_name ?? "");
      const renewal = str(p.renewal_date ?? p.due_date ?? "");
      return `Contract renewal due${id ? ` #${id}` : ""}${vendor ? ` with ${vendor}` : ""}${renewal ? ` by ${renewal}` : ""}. Legal review and negotiation required.`;
    },
    severity: "medium",
  },

  "supplier.issue": {
    build: (p) => {
      const supplier = str(p.supplier_name ?? p.vendor_name ?? "supplier");
      const issue = str(p.issue_type ?? p.issue ?? p.description ?? "issue reported");
      const id = str(p.supplier_id ?? p.id ?? "");
      return `Supplier issue reported${id ? ` (${id})` : ""}: ${supplier}. Problem: ${issue}. Procurement and operations team must follow up.`;
    },
    severity: "high",
  },

  "compliance.violation": {
    build: (p) => {
      const type = str(p.violation_type ?? p.regulation ?? "compliance");
      const dept = str(p.department ?? p.entity ?? "");
      const desc = str(p.description ?? p.details ?? "");
      return `Compliance violation detected: ${type}${dept ? ` in ${dept}` : ""}. ${desc || "Regulatory breach identified."} Legal and compliance team must review immediately.`;
    },
    severity: "critical",
  },

  "audit.exception": {
    build: (p) => {
      const type = str(p.exception_type ?? p.audit_type ?? "audit exception");
      const period = str(p.period ?? p.audit_period ?? "");
      const amount = str(p.amount ?? p.discrepancy ?? "");
      const desc = str(p.description ?? "");
      return `Audit exception flagged: ${type}${period ? ` for ${period}` : ""}${amount ? `, discrepancy $${amount}` : ""}. ${desc || "Financial or compliance irregularity detected."} Immediate review required.`;
    },
    severity: "critical",
  },

  "inventory.shortage": {
    build: (p) => {
      const item = str(p.item_name ?? p.product_name ?? p.sku ?? "item");
      const qty = str(p.quantity ?? p.current_stock ?? "");
      const reorder = str(p.reorder_point ?? p.minimum_stock ?? "");
      return `Inventory shortage: ${item}${qty ? ` (${qty} units remaining` : ""}${reorder ? `, reorder at ${reorder}` : ""}). Supply chain action required to avoid stockout.`;
    },
    severity: "medium",
  },

  "budget.exceeded": {
    build: (p) => {
      const dept = str(p.department ?? p.cost_center ?? "department");
      const budget = str(p.budget_amount ?? p.budget ?? "");
      const actual = str(p.actual_amount ?? p.spent ?? "");
      const overage = str(p.overage ?? p.excess ?? "");
      return `Budget exceeded in ${dept}${budget ? `. Budget: $${budget}` : ""}${actual ? `, Actual: $${actual}` : ""}${overage ? `, Overage: $${overage}` : ""}. Finance and management approval required.`;
    },
    severity: "high",
  },

  "payment.approval_required": {
    build: (p) => {
      const amount = str(p.amount ?? "");
      const vendor = str(p.vendor_name ?? p.payee ?? "");
      const inv = str(p.invoice_id ?? p.reference ?? "");
      return `Payment requires approval${amount ? ` of $${amount}` : ""}${vendor ? ` to ${vendor}` : ""}${inv ? ` (invoice ${inv})` : ""}. Finance manager authorization needed before processing.`;
    },
    severity: "medium",
  },
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const erpAdapter: IntegrationAdapter = {
  system: "erp" as SystemType,
  providers: ["sap", "oracle", "netsuite", "dynamics", "generic"],
  eventTypes: Object.keys(TEMPLATES),

  supports(event: RawSystemEvent): boolean {
    return event.system === "erp";
  },

  normalize(event: RawSystemEvent): NormalizedEvent {
    const p = event.payload;
    const template = TEMPLATES[event.event_type];
    const contact = extractContact(event, p);

    if (template) {
      return {
        text: template.build(p),
        source: "api",
        ...contact,
        metadata: meta(event, template.severity, {
          provider: event.provider,
        }),
      };
    }

    // Generic ERP fallback
    const id = str(p.id ?? p.record_id ?? p.document_id ?? "");
    const desc = str(p.description ?? p.message ?? p.details ?? "");
    return {
      text: `ERP event "${event.event_type}"${event.provider ? ` from ${event.provider}` : ""}${id ? ` (record ${id})` : ""}. ${desc || "Enterprise system event requiring review."}`,
      source: "api",
      ...contact,
      metadata: meta(event, "medium"),
    };
  },
};
