// ---------------------------------------------------------------------------
// Database / CDC Adapter
//
// Handles row-change events from:
//   • Debezium (standard CDC format: op + before + after + source)
//   • PostgreSQL pg_notify (table + operation + data)
//   • Generic JSON diff events
//
// Table name → department mapping ensures the right Lumetra roots are hit.
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
  row: Record<string, unknown>,
): Pick<NormalizedEvent, "to_email" | "to_phone" | "from_name"> {
  return {
    to_email:
      event.customer_email ??
      (str(row.email ?? row.customer_email ?? row.contact_email) || undefined),
    to_phone:
      event.customer_phone ??
      (str(row.phone ?? row.customer_phone ?? row.mobile) || undefined),
    from_name:
      event.customer_name ??
      (str(
        row.name ??
          row.customer_name ??
          row.full_name ??
          row.first_name,
      ) || undefined),
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
// Table → domain mapping
// ---------------------------------------------------------------------------

type TableDomain = {
  keywords: string[];
  label: string;
  severity: NormalizedEvent["metadata"]["severity"];
};

const TABLE_DOMAINS: Record<string, TableDomain> = {
  // Logistics
  orders: { keywords: ["order", "shipment", "delivery", "package"], label: "order", severity: "medium" },
  order_items: { keywords: ["order", "item", "product"], label: "order line", severity: "low" },
  shipments: { keywords: ["shipment", "delivery", "package", "tracking"], label: "shipment", severity: "medium" },
  deliveries: { keywords: ["delivery", "package", "address"], label: "delivery", severity: "medium" },

  // Finance / Billing
  payments: { keywords: ["payment", "transaction", "charge", "billing"], label: "payment", severity: "high" },
  invoices: { keywords: ["invoice", "billing", "amount due"], label: "invoice", severity: "high" },
  billing: { keywords: ["billing", "charge", "subscription"], label: "billing record", severity: "medium" },
  refunds: { keywords: ["refund", "reversal", "credit"], label: "refund", severity: "medium" },
  transactions: { keywords: ["transaction", "payment", "charge"], label: "transaction", severity: "high" },
  chargebacks: { keywords: ["chargeback", "dispute", "refund", "fraud"], label: "chargeback", severity: "critical" },

  // Support / Tickets
  tickets: { keywords: ["support ticket", "complaint", "issue"], label: "support ticket", severity: "medium" },
  complaints: { keywords: ["complaint", "issue", "problem"], label: "complaint", severity: "high" },
  support_requests: { keywords: ["support request", "help request"], label: "support request", severity: "medium" },
  feedback: { keywords: ["feedback", "review", "rating"], label: "feedback", severity: "low" },

  // Security
  security_logs: { keywords: ["security alert", "unauthorized access", "login attempt"], label: "security event", severity: "high" },
  audit_logs: { keywords: ["audit", "security", "access"], label: "audit entry", severity: "medium" },
  fraud_alerts: { keywords: ["fraud alert", "suspicious activity", "security breach"], label: "fraud alert", severity: "critical" },
  access_logs: { keywords: ["login", "access", "authentication"], label: "access event", severity: "medium" },

  // Medical / Health
  medical_records: { keywords: ["medical record", "patient", "health"], label: "medical record", severity: "high" },
  prescriptions: { keywords: ["prescription", "medication", "drug"], label: "prescription", severity: "high" },
  appointments: { keywords: ["appointment", "doctor", "clinic", "booking"], label: "appointment", severity: "medium" },
  patient_records: { keywords: ["patient", "medical", "clinical"], label: "patient record", severity: "high" },
  lab_results: { keywords: ["lab result", "diagnosis", "medical test"], label: "lab result", severity: "high" },

  // Legal
  contracts: { keywords: ["contract", "agreement", "legal"], label: "contract", severity: "high" },
  legal_cases: { keywords: ["legal case", "lawsuit", "litigation"], label: "legal case", severity: "critical" },
  disputes: { keywords: ["dispute", "claim", "legal"], label: "dispute", severity: "high" },
  compliance_records: { keywords: ["compliance", "regulation", "legal"], label: "compliance record", severity: "high" },

  // Customers / Users
  customers: { keywords: ["customer", "account", "user"], label: "customer record", severity: "low" },
  users: { keywords: ["user", "account", "profile"], label: "user account", severity: "medium" },
  accounts: { keywords: ["account", "user", "profile"], label: "account", severity: "medium" },
};

// ---------------------------------------------------------------------------
// Operation labels
// ---------------------------------------------------------------------------

const OP_LABELS: Record<string, string> = {
  c: "created",
  r: "read",
  u: "updated",
  d: "deleted",
  create: "created",
  insert: "created",
  update: "updated",
  delete: "deleted",
  upsert: "upserted",
};

// ---------------------------------------------------------------------------
// Core normalization logic
// ---------------------------------------------------------------------------

function normalizeRow(
  tableName: string,
  operation: string,
  after: Record<string, unknown>,
  before: Record<string, unknown>,
  event: RawSystemEvent,
): NormalizedEvent {
  const domain = TABLE_DOMAINS[tableName.toLowerCase()];
  const opLabel = OP_LABELS[operation.toLowerCase()] ?? operation;
  const recordId =
    str(after.id ?? after.uuid ?? after.record_id ?? after.order_id ?? before.id ?? "");
  const contact = extractContact(event, after);

  // Build rich context from changed fields
  const contextParts: string[] = [];

  if (tableName.toLowerCase().startsWith("order")) {
    const newStatus = str(after.status ?? after.state ?? "");
    const oldStatus = str(before.status ?? before.state ?? "");
    if (newStatus && newStatus !== oldStatus) {
      contextParts.push(`Status changed from ${oldStatus || "unknown"} to ${newStatus}`);
    }
    const amount = after.total ?? after.amount;
    if (amount) contextParts.push(`Total: $${amount}`);
    const item = str(after.item_name ?? after.product_name ?? "");
    if (item) contextParts.push(`Item: ${item}`);
  }

  if (tableName.toLowerCase().includes("payment") || tableName.toLowerCase().includes("invoice")) {
    const amount = after.amount ?? after.total ?? after.amount_due;
    if (amount) contextParts.push(`Amount: $${amount}`);
    const status = str(after.status ?? "");
    if (status) contextParts.push(`Status: ${status}`);
    const reason = str(after.failure_reason ?? after.decline_reason ?? after.error ?? "");
    if (reason) contextParts.push(`Reason: ${reason}`);
  }

  if (tableName.toLowerCase().includes("complaint") || tableName.toLowerCase().includes("ticket")) {
    const subject = str(after.subject ?? after.title ?? after.description ?? "");
    if (subject) contextParts.push(subject);
    const priority = str(after.priority ?? "");
    if (priority) contextParts.push(`Priority: ${priority}`);
  }

  if (tableName.toLowerCase().includes("security") || tableName.toLowerCase().includes("fraud")) {
    const ip = str(after.ip_address ?? after.source_ip ?? "");
    if (ip) contextParts.push(`IP: ${ip}`);
    const user = str(after.username ?? after.user_id ?? "");
    if (user) contextParts.push(`User: ${user}`);
  }

  const domainKeywords = domain?.keywords.join(", ") ?? tableName;
  const domainLabel = domain?.label ?? tableName;
  const severity = domain?.severity ?? "medium";

  let text = `Database record ${opLabel}: ${domainLabel}${recordId ? ` #${recordId}` : ""} in ${tableName}.`;

  if (contextParts.length > 0) {
    text += ` ${contextParts.join(". ")}.`;
  }

  // Add semantic keywords to help the parser hit the right roots
  text += ` [${domainKeywords}]`;

  return {
    text,
    source: "api",
    ...contact,
    metadata: meta(event, severity, {
      table: tableName,
      operation: opLabel,
      record_id: recordId || undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Debezium CDC format parser
// ---------------------------------------------------------------------------

function fromDebezium(event: RawSystemEvent): NormalizedEvent | null {
  const p = event.payload;
  const op = str(p.op ?? "");
  if (!op) return null;

  const source = p.source as Record<string, unknown> | undefined;
  const tableName = str(
    source?.table ?? p.table ?? event.payload.collection ?? "",
  );
  if (!tableName) return null;

  const after = (p.after as Record<string, unknown>) ?? {};
  const before = (p.before as Record<string, unknown>) ?? {};

  return normalizeRow(tableName, op, after, before, event);
}

// ---------------------------------------------------------------------------
// pg_notify / generic format parser
// ---------------------------------------------------------------------------

function fromGeneric(event: RawSystemEvent): NormalizedEvent | null {
  const p = event.payload;

  const tableName = str(
    p.table ??
      p.table_name ??
      p.collection ??
      p.resource ??
      p.entity ??
      "",
  );
  if (!tableName) return null;

  const operation = str(
    p.operation ??
      p.action ??
      p.op ??
      p.event_type ??
      event.event_type.split(".").pop() ??
      "updated",
  );

  const row = (p.data ?? p.record ?? p.row ?? p.new ?? p) as Record<
    string,
    unknown
  >;
  const oldRow = (p.old ?? p.previous ?? p.before ?? {}) as Record<
    string,
    unknown
  >;

  return normalizeRow(tableName, operation, row, oldRow, event);
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const databaseAdapter: IntegrationAdapter = {
  system: "database" as SystemType,
  providers: ["debezium", "pg_notify", "mysql_binlog", "generic"],
  eventTypes: [
    "row.created",
    "row.updated",
    "row.deleted",
    "insert",
    "update",
    "delete",
    "upsert",
    "change",
  ],

  supports(event: RawSystemEvent): boolean {
    return event.system === "database";
  },

  normalize(event: RawSystemEvent): NormalizedEvent {
    // Try Debezium format first (has `op` field)
    if ("op" in event.payload) {
      const result = fromDebezium(event);
      if (result) return result;
    }

    // Try generic format
    const result = fromGeneric(event);
    if (result) return result;

    // Absolute fallback
    return {
      text: `Database change event "${event.event_type}" received. Record updated in system — review required.`,
      source: "api",
      metadata: meta(event, "medium"),
    };
  },
};
