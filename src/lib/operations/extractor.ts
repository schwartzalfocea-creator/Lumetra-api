// ---------------------------------------------------------------------------
// Operation Extractor
//
// Deterministic rule engine that converts a RawSystemEvent + NormalizedEvent
// into zero-or-more BusinessOperation records.
//
// No AI involved — every mapping is an explicit conditional rule.
// ---------------------------------------------------------------------------

import type { RawSystemEvent, NormalizedEvent } from "../integrations/types";
import type { BusinessOperation, OperationType, OperationStatus } from "./types";

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : parseFloat(str(v));
  return isNaN(n) ? undefined : n;
}

function cents(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined ? Math.round(n) / 100 : undefined; // Stripe/Square use cents
}

function dollars(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined ? parseFloat(n.toFixed(2)) : undefined;
}

function op(
  type: OperationType,
  status: OperationStatus,
  event: RawSystemEvent,
  normalized: NormalizedEvent,
  overrides: Partial<BusinessOperation> = {},
): BusinessOperation {
  return {
    type,
    status,
    sourceSystem: event.system,
    sourceProvider: event.provider,
    sourceEventType: event.event_type,
    sourceId: event.source_id,
    occurredAt: event.occurred_at,
    customerEmail: normalized.to_email,
    customerName: normalized.from_name,
    data: event.payload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POS extraction
// ---------------------------------------------------------------------------

function extractFromPos(
  event: RawSystemEvent,
  normalized: NormalizedEvent,
): BusinessOperation[] {
  const p = event.payload;
  const et = event.event_type;
  const provider = (event.provider ?? "generic").toLowerCase();
  const results: BusinessOperation[] = [];

  // Resolve the inner Stripe/Square object
  const obj =
    provider === "stripe"
      ? ((p.data as Record<string, unknown>)?.object as Record<string, unknown> | undefined) ?? p
      : p;

  const rawAmount = obj.amount ?? obj.total_money ?? obj.amount_due ?? obj.amount_paid;
  const amountInCents = num(
    typeof rawAmount === "object" && rawAmount !== null
      ? (rawAmount as Record<string, unknown>).amount
      : rawAmount,
  );
  // Stripe uses cents; raw POS typically uses dollars
  const amount = provider === "stripe" || provider === "square"
    ? cents(amountInCents)
    : dollars(rawAmount);

  const currency = str(obj.currency ?? "USD").toUpperCase() || "USD";
  const orderId = str(obj.order_id ?? obj.id ?? "");
  const sku = str(obj.sku ?? obj.item_sku ?? "");
  const productName = str(obj.product_name ?? obj.item_name ?? obj.description ?? "");
  const qty = num(obj.quantity ?? obj.qty);
  const vendorName = str(obj.vendor_name ?? "");

  // ── Stripe ──────────────────────────────────────────────────────────────
  if (provider === "stripe") {
    if (et === "charge.failed" || et === "payment_intent.payment_failed") {
      results.push(op("payment", "failed", event, normalized, { amount, currency }));
    } else if (et === "invoice.payment_failed") {
      results.push(op("payment", "failed", event, normalized, { amount, currency }));
    } else if (et === "charge.refunded" || et === "refund.created") {
      results.push(op("refund", "completed", event, normalized, { amount, currency }));
    } else if (et === "charge.dispute.created" || et === "charge.dispute.updated") {
      results.push(op("dispute", "open", event, normalized, { amount, currency }));
    } else if (et === "customer.subscription.deleted") {
      results.push(op("sale", "cancelled", event, normalized, { amount, currency }));
    } else if (et === "payment_intent.succeeded" || et === "charge.succeeded") {
      results.push(op("payment", "completed", event, normalized, { amount, currency }));
      results.push(op("sale", "completed", event, normalized, { amount, currency }));
    }
    return results;
  }

  // ── Square ───────────────────────────────────────────────────────────────
  if (provider === "square") {
    const state = str(obj.state ?? obj.status ?? "");
    if (et === "payment.created" && state === "FAILED") {
      results.push(op("payment", "failed", event, normalized, { amount, currency }));
    } else if (et === "payment.created" && state === "COMPLETED") {
      results.push(op("payment", "completed", event, normalized, { amount, currency }));
      results.push(op("sale", "completed", event, normalized, { amount, currency }));
    } else if (
      (et === "order.created" || et === "order.updated") &&
      (state === "CANCELED" || state === "CANCELLED")
    ) {
      results.push(op("sale", "cancelled", event, normalized, { amount, currency }));
    } else if (et === "dispute.created" || et === "dispute.state_changed") {
      results.push(op("dispute", "open", event, normalized, { amount, currency }));
    } else if (et === "refund.created") {
      results.push(op("refund", "completed", event, normalized, { amount, currency }));
    }
    return results;
  }

  // ── Generic POS (Toast, Clover, etc.) ────────────────────────────────────
  const typeMap: Record<string, [OperationType, OperationStatus]> = {
    "payment.failed": ["payment", "failed"],
    "payment.declined": ["payment", "failed"],
    "payment.disputed": ["dispute", "open"],
    "payment.refunded": ["refund", "completed"],
    "refund.requested": ["refund", "pending"],
    "refund.denied": ["refund", "denied"],
    "order.cancelled": ["sale", "cancelled"],
    "order.returned": ["sale", "cancelled"],
    "order.delayed": ["sale", "pending"],
    "order.damaged": ["sale", "failed"],
    "inventory.low": ["stock_update", "alert"],
    "inventory.stockout": ["stock_update", "alert"],
    "transaction.fraud_alert": ["dispute", "fraud"],
    "customer.complaint": ["support_ticket", "open"],
    "PAYMENT_FAILED": ["payment", "failed"],
    "ORDER_CANCELLED": ["sale", "cancelled"],
  };

  const mapped = typeMap[et];
  if (mapped) {
    const [type, status] = mapped;
    results.push(
      op(type, status, event, normalized, {
        amount: dollars(p.amount ?? p.total),
        currency: str(p.currency ?? "USD").toUpperCase() || "USD",
        sku: sku || undefined,
        productName: productName || undefined,
        quantity: qty,
        vendorName: vendorName || undefined,
        sourceId: event.source_id ?? (str(orderId) || undefined),
      }),
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Database / CDC extraction
// ---------------------------------------------------------------------------

const TABLE_OPERATION_MAP: Record<string, OperationType> = {
  orders: "sale",
  order_items: "sale",
  shipments: "sale",
  deliveries: "sale",
  payments: "payment",
  invoices: "payment",
  billing: "payment",
  transactions: "payment",
  refunds: "refund",
  chargebacks: "dispute",
  fraud_alerts: "dispute",
  tickets: "support_ticket",
  complaints: "support_ticket",
  support_requests: "support_ticket",
  inventory: "stock_update",
  products: "stock_update",
  stock: "stock_update",
  purchase_orders: "purchase",
  contracts: "contract",
  compliance_records: "compliance",
  security_logs: "compliance",
};

const STATUS_FROM_DB: Record<string, OperationStatus> = {
  cancelled: "cancelled",
  canceled: "cancelled",
  CANCELLED: "cancelled",
  CANCELED: "cancelled",
  completed: "completed",
  COMPLETED: "completed",
  fulfilled: "completed",
  FULFILLED: "completed",
  delivered: "completed",
  DELIVERED: "completed",
  failed: "failed",
  FAILED: "failed",
  rejected: "rejected",
  REJECTED: "rejected",
  processing: "pending",
  PROCESSING: "pending",
  pending: "pending",
  PENDING: "pending",
  open: "open",
  OPEN: "open",
  new: "open",
  NEW: "open",
  overdue: "overdue",
  OVERDUE: "overdue",
};

function extractFromDatabase(
  event: RawSystemEvent,
  normalized: NormalizedEvent,
): BusinessOperation[] {
  const p = event.payload;
  const results: BusinessOperation[] = [];

  // Resolve table name
  const source = p.source as Record<string, unknown> | undefined;
  const tableName = str(
    source?.table ?? p.table ?? p.table_name ?? p.collection ?? "",
  ).toLowerCase();

  if (!tableName) return results;

  const opType = TABLE_OPERATION_MAP[tableName];
  if (!opType) return results; // unrecognised table — no operation

  // Resolve the record (Debezium "after" or generic "data"/"record")
  const after = (p.after ?? p.data ?? p.record ?? p.new ?? {}) as Record<string, unknown>;
  const dbOp = str(p.op ?? p.operation ?? p.action ?? "u");

  // Determine status
  let status: OperationStatus = "completed";

  if (dbOp === "d") {
    status = "cancelled";
  } else if (dbOp === "c") {
    status = "pending";
  } else {
    // For updates, look at the status/state field
    const dbStatus = str(after.status ?? after.state ?? after.status_code ?? "");
    status = STATUS_FROM_DB[dbStatus] ?? "completed";
  }

  const amount = dollars(after.total ?? after.amount ?? after.amount_due ?? after.price);
  const currency = str(after.currency ?? "USD").toUpperCase() || "USD";
  const recordId = str(after.id ?? after.uuid ?? "");

  results.push(
    op(opType, status, event, normalized, {
      amount,
      currency,
      sku: str(after.sku ?? after.product_sku ?? "") || undefined,
      productName: str(after.product_name ?? after.item_name ?? after.name ?? "") || undefined,
      quantity: num(after.quantity ?? after.qty),
      customerEmail: normalized.to_email ?? (str(after.customer_email ?? after.email ?? "") || undefined),
      customerName: normalized.from_name ?? (str(after.customer_name ?? after.name ?? "") || undefined),
      vendorName: str(after.vendor_name ?? after.supplier_name ?? "") || undefined,
      sourceId: event.source_id ?? (recordId ? `${tableName}:${recordId}` : undefined),
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// API / CRM extraction
// ---------------------------------------------------------------------------

function extractFromApi(
  event: RawSystemEvent,
  normalized: NormalizedEvent,
): BusinessOperation[] {
  const p = event.payload;
  const et = event.event_type;
  const provider = (event.provider ?? "generic").toLowerCase();
  const results: BusinessOperation[] = [];

  const ticketProviders = new Set(["zendesk", "hubspot", "salesforce", "jira", "github"]);

  if (ticketProviders.has(provider) || et.includes("ticket") || et.includes("Case") || et.includes("issue")) {
    let status: OperationStatus = "open";
    if (et.includes("escalated") || et.includes("priority_changed")) status = "escalated";
    if (et.includes("closed") || et.includes("resolved")) status = "completed";

    // Extract ticket fields
    const ticket = (p.ticket ?? p.issue ?? p.record ?? p.sobject ?? p) as Record<string, unknown>;
    const fields = (ticket.fields ?? ticket) as Record<string, unknown>;
    const id = str(ticket.id ?? ticket.key ?? fields.Id ?? "");
    const priority = str(
      (fields.priority as Record<string, unknown>)?.name ?? fields.priority ?? ticket.priority ?? ""
    ).toLowerCase();

    results.push(
      op("support_ticket", status, event, normalized, {
        sourceId: event.source_id ?? (id ? `${provider}:${id}` : undefined),
        data: {
          ...p,
          _extracted_priority: priority || undefined,
          _extracted_id: id || undefined,
        },
      }),
    );
  } else if (et.includes("deal") || et.includes("Opportunity")) {
    const props = (p.properties ?? p) as Record<string, unknown>;
    const amount = dollars(props.amount ?? props.dealvalue ?? (p as Record<string, unknown>).Amount);
    const currency = str(props.currency ?? "USD").toUpperCase() || "USD";
    let status: OperationStatus = "pending";
    if (et.includes("closed") || et.includes("won")) status = "completed";

    results.push(op("sale", status, event, normalized, { amount, currency }));
  } else if (et.includes("contact.created")) {
    // No structured operation for contact creation (no financial/inventory action)
  } else {
    // Generic API event — create a support_ticket as the safest default
    results.push(op("support_ticket", "open", event, normalized));
  }

  return results;
}

// ---------------------------------------------------------------------------
// ERP extraction
// ---------------------------------------------------------------------------

function extractFromErp(
  event: RawSystemEvent,
  normalized: NormalizedEvent,
): BusinessOperation[] {
  const p = event.payload;
  const et = event.event_type;
  const results: BusinessOperation[] = [];

  const amount = dollars(
    p.amount ?? p.total ?? p.contract_value ?? p.annual_value ?? p.budget_amount,
  );
  const currency = str(p.currency ?? "USD").toUpperCase() || "USD";
  const vendorName = str(p.vendor_name ?? p.supplier_name ?? p.party_name ?? "");

  const erpMap: Record<string, [OperationType, OperationStatus]> = {
    "purchase_order.rejected": ["purchase", "rejected"],
    "purchase_order.created": ["purchase", "pending"],
    "purchase_order.approved": ["purchase", "completed"],
    "invoice.overdue": ["payment", "overdue"],
    "invoice.created": ["payment", "pending"],
    "invoice.paid": ["payment", "completed"],
    "inventory.shortage": ["stock_update", "alert"],
    "contract.expired": ["contract", "cancelled"],
    "contract.renewal_due": ["contract", "pending"],
    "compliance.violation": ["compliance", "violation"],
    "audit.exception": ["compliance", "violation"],
    "budget.exceeded": ["payment", "failed"],
    "payment.approval_required": ["payment", "pending"],
    "shipment.delayed": ["sale", "pending"],
  };

  const mapped = erpMap[et];
  if (mapped) {
    const [type, status] = mapped;
    results.push(
      op(type, status, event, normalized, {
        amount,
        currency,
        vendorName: vendorName || undefined,
        sku: str(p.item_code ?? p.sku ?? "") || undefined,
        productName: str(p.item_name ?? p.product_name ?? "") || undefined,
        quantity: num(p.quantity ?? p.qty),
      }),
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// IoT extraction
// ---------------------------------------------------------------------------

function extractFromIot(
  event: RawSystemEvent,
  normalized: NormalizedEvent,
): BusinessOperation[] {
  const p = event.payload;

  // All IoT events map to device_alert
  return [
    op("device_alert", "alert", event, normalized, {
      data: {
        ...p,
        _device_id: str(p.device_id ?? p.sensor_id ?? ""),
        _location: str(p.location ?? p.zone ?? ""),
        _metric: str(p.metric ?? p.sensor_type ?? event.event_type),
        _value: p.value ?? p.temperature ?? p.pressure ?? p.reading,
        _threshold: p.threshold ?? p.max_temperature ?? p.max_pressure ?? p.limit,
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extract zero-or-more business operations from a system event.
 * Returns an empty array when the event doesn't correspond to a
 * recognisable operation (e.g. contact creation, generic webhook).
 */
export function extractOperations(
  event: RawSystemEvent,
  normalized: NormalizedEvent,
): BusinessOperation[] {
  try {
    switch (event.system) {
      case "pos":
        return extractFromPos(event, normalized);
      case "database":
        return extractFromDatabase(event, normalized);
      case "api":
      case "crm":
        return extractFromApi(event, normalized);
      case "erp":
        return extractFromErp(event, normalized);
      case "iot":
        return extractFromIot(event, normalized);
      default:
        return [];
    }
  } catch {
    // Extractor failures must never crash the integration pipeline
    return [];
  }
}
