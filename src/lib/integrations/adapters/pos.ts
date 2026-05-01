// ---------------------------------------------------------------------------
// POS Adapter
//
// Supports: Square, Stripe, Toast, Clover, and a generic POS format.
// All normalization is deterministic — no AI.
// ---------------------------------------------------------------------------

import type {
  IntegrationAdapter,
  RawSystemEvent,
  NormalizedEvent,
  SystemType,
} from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function money(v: unknown): string {
  const n = typeof v === "number" ? v : parseFloat(str(v));
  if (isNaN(n)) return "";
  return `$${(n / 100).toFixed(2)}`; // assume cents; halve for dollars
}

function moneyDirect(v: unknown): string {
  const n = typeof v === "number" ? v : parseFloat(str(v));
  if (isNaN(n)) return "";
  return `$${n.toFixed(2)}`;
}

function extractContact(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): Pick<NormalizedEvent, "to_email" | "to_phone" | "from_name"> {
  const email =
    event.customer_email ??
    str(p.customer_email ?? p.email ?? p.receipt_email ?? p.buyer_email ?? "");
  const phone =
    event.customer_phone ??
    str(p.customer_phone ?? p.phone ?? p.mobile ?? "");
  const name =
    event.customer_name ??
    str(
      p.customer_name ??
        p.buyer_name ??
        p.cardholder_name ??
        p.billing_name ??
        "",
    );
  return {
    to_email: email || undefined,
    to_phone: phone || undefined,
    from_name: name || undefined,
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
// Stripe normalizers
// ---------------------------------------------------------------------------

function stripeEvent(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const obj = (p.data as Record<string, unknown>)?.object as Record<
    string,
    unknown
  > | undefined;
  const o = obj ?? p;
  const amount = money(o.amount ?? o.amount_due ?? o.amount_paid);
  const currency = str(o.currency).toUpperCase() || "USD";
  const orderId = str(o.id ?? o.charge ?? "");
  const contact = extractContact(event, o);
  const reason = str(
    (o.last_payment_error as Record<string, unknown>)?.message ??
      o.failure_message ??
      "",
  );

  const et = event.event_type;

  if (et === "charge.failed" || et === "payment_intent.payment_failed") {
    return {
      text: `Payment failed${amount ? ` for ${amount} ${currency}` : ""}${orderId ? `, transaction ${orderId}` : ""}. ${reason ? `Reason: ${reason}.` : "The charge was declined."} Customer requires assistance with payment issue.`,
      source: "api",
      ...contact,
      metadata: meta(event, "high", { amount, currency, orderId }),
    };
  }

  if (et === "charge.dispute.created" || et === "charge.dispute.updated") {
    const disputeAmount = money(o.amount);
    return {
      text: `Customer filed a dispute${disputeAmount ? ` for ${disputeAmount} ${currency}` : ""}${orderId ? `, charge ${orderId}` : ""}. The transaction is being contested and requires immediate review.`,
      source: "api",
      ...contact,
      metadata: meta(event, "critical", { amount: disputeAmount, currency }),
    };
  }

  if (et === "charge.refunded" || et === "refund.created") {
    const refundAmount = money(
      (o.refunds as Record<string, unknown>)?.total_count ?? o.amount,
    );
    return {
      text: `Refund processed${refundAmount ? ` for ${refundAmount} ${currency}` : ""}${orderId ? `, transaction ${orderId}` : ""}. Customer account has been credited.`,
      source: "api",
      ...contact,
      metadata: meta(event, "medium", { orderId }),
    };
  }

  if (et === "invoice.payment_failed") {
    return {
      text: `Invoice payment failed${amount ? ` for ${amount} ${currency}` : ""}${orderId ? `, invoice ${orderId}` : ""}. ${reason || "The payment could not be processed."}`,
      source: "api",
      ...contact,
      metadata: meta(event, "high", { orderId }),
    };
  }

  if (et === "customer.subscription.deleted") {
    return {
      text: `Customer subscription cancelled${orderId ? ` (subscription ${orderId})` : ""}. Subscription has been terminated and billing stopped.`,
      source: "api",
      ...contact,
      metadata: meta(event, "medium", { orderId }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Square normalizers
// ---------------------------------------------------------------------------

function squareEvent(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const et = event.event_type;
  const o = (p.data as Record<string, unknown>)?.object as Record<
    string,
    unknown
  > ?? p;
  const orderId = str(o.order_id ?? o.id ?? "");
  const amount = moneyDirect(
    (o.amount_money as Record<string, unknown>)?.amount ??
      (o.total_money as Record<string, unknown>)?.amount,
  );
  const contact = extractContact(event, o);

  if (et === "payment.created" && str(o.status) === "FAILED") {
    return {
      text: `Payment failed${amount ? ` for ${amount}` : ""}${orderId ? `, order ${orderId}` : ""}. Transaction could not be completed — customer needs payment assistance.`,
      source: "api",
      ...contact,
      metadata: meta(event, "high", { orderId }),
    };
  }

  if (et === "order.created" || et === "order.updated") {
    const state = str(o.state);
    if (state === "CANCELED" || state === "CANCELLED") {
      return {
        text: `Order ${orderId || "unknown"} was cancelled${amount ? ` (${amount})` : ""}. Customer may require a refund or assistance with a replacement order.`,
        source: "api",
        ...contact,
        metadata: meta(event, "medium", { orderId, state }),
      };
    }
  }

  if (et === "dispute.created" || et === "dispute.state_changed") {
    return {
      text: `Payment dispute opened${orderId ? ` on order ${orderId}` : ""}${amount ? ` for ${amount}` : ""}. Customer is contesting the charge — legal review may be required.`,
      source: "api",
      ...contact,
      metadata: meta(event, "critical", { orderId }),
    };
  }

  if (et === "refund.created" || et === "refund.updated") {
    const refundState = str(o.status);
    return {
      text: `Refund ${refundState.toLowerCase() || "initiated"}${amount ? ` for ${amount}` : ""}${orderId ? ` on order ${orderId}` : ""}. Customer refund is being processed.`,
      source: "api",
      ...contact,
      metadata: meta(event, "medium", { orderId, refundState }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Toast normalizers
// ---------------------------------------------------------------------------

function toastEvent(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const et = event.event_type;
  const orderId = str(p.order_guid ?? p.order_id ?? p.id ?? "");
  const amount = moneyDirect(p.total_amount ?? p.check_amount);
  const contact = extractContact(event, p);

  if (et === "order.cancelled" || et === "ORDER_CANCELLED") {
    return {
      text: `Restaurant order cancelled${orderId ? ` (${orderId})` : ""}${amount ? `, total ${amount}` : ""}. Customer requires assistance or a refund for the cancelled order.`,
      source: "api",
      ...contact,
      metadata: meta(event, "medium", { orderId }),
    };
  }

  if (et === "payment.failed" || et === "PAYMENT_FAILED") {
    return {
      text: `Payment failed at point of sale${amount ? ` for ${amount}` : ""}${orderId ? `, check ${orderId}` : ""}. The transaction was declined — customer needs payment help.`,
      source: "api",
      ...contact,
      metadata: meta(event, "high", { orderId }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Generic POS normalizer (fallback)
// ---------------------------------------------------------------------------

const GENERIC_EVENT_TEMPLATES: Record<
  string,
  (p: Record<string, unknown>) => { text: string; severity: NormalizedEvent["metadata"]["severity"] }
> = {
  "payment.failed": (p) => ({
    text: `Payment failed${p.amount ? ` for $${p.amount}` : ""}${p.order_id ? ` on order ${p.order_id}` : ""}. ${p.reason ?? p.failure_reason ?? "Transaction was declined."} Customer needs payment assistance.`,
    severity: "high",
  }),
  "payment.declined": (p) => ({
    text: `Payment declined${p.amount ? ` for $${p.amount}` : ""}${p.order_id ? ` on order ${p.order_id}` : ""}. ${p.reason ?? "Card was not accepted."} Please assist the customer with an alternative payment method.`,
    severity: "high",
  }),
  "payment.disputed": (p) => ({
    text: `Customer disputed payment${p.amount ? ` of $${p.amount}` : ""}${p.order_id ? ` for order ${p.order_id}` : ""}. Chargeback initiated — finance and legal review required.`,
    severity: "critical",
  }),
  "payment.refunded": (p) => ({
    text: `Refund of${p.amount ? ` $${p.amount}` : ""} processed${p.order_id ? ` for order ${p.order_id}` : ""}. ${p.reason ? `Reason: ${p.reason}.` : ""}`,
    severity: "medium",
  }),
  "order.cancelled": (p) => ({
    text: `Order cancelled${p.order_id ? ` (${p.order_id})` : ""}${p.amount ? `, value $${p.amount}` : ""}. ${p.reason ? `Reason: ${p.reason}.` : ""} Customer may require a refund.`,
    severity: "medium",
  }),
  "order.delayed": (p) => ({
    text: `Order delayed${p.order_id ? ` (${p.order_id})` : ""}. ${p.estimated_delay ? `Estimated delay: ${p.estimated_delay}.` : "Shipment is behind schedule."} Customer should be notified.`,
    severity: "medium",
  }),
  "order.damaged": (p) => ({
    text: `Damaged item reported${p.order_id ? ` for order ${p.order_id}` : ""}. ${p.description ?? "Product arrived damaged."} Customer requires replacement or refund.`,
    severity: "high",
  }),
  "order.returned": (p) => ({
    text: `Return initiated${p.order_id ? ` for order ${p.order_id}` : ""}${p.reason ? `. Reason: ${p.reason}` : ""}. Refund or replacement needed.`,
    severity: "medium",
  }),
  "refund.requested": (p) => ({
    text: `Refund requested${p.amount ? ` for $${p.amount}` : ""}${p.order_id ? `, order ${p.order_id}` : ""}. ${p.reason ? `Reason: ${p.reason}.` : ""}`,
    severity: "medium",
  }),
  "refund.denied": (p) => ({
    text: `Refund request denied${p.order_id ? ` for order ${p.order_id}` : ""}${p.amount ? ` ($${p.amount})` : ""}. ${p.reason ? `Reason: ${p.reason}.` : "Customer disputes the refusal."}`,
    severity: "high",
  }),
  "inventory.low": (p) => ({
    text: `Low inventory alert${p.sku ? ` for SKU ${p.sku}` : ""}${p.product_name ? ` (${p.product_name})` : ""}. ${p.quantity !== undefined ? `Only ${p.quantity} units remaining.` : "Stock below threshold."} Reorder required.`,
    severity: "low",
  }),
  "inventory.stockout": (p) => ({
    text: `Stock-out alert${p.sku ? ` for SKU ${p.sku}` : ""}${p.product_name ? ` (${p.product_name})` : ""}. Product is completely out of stock — fulfillment at risk.`,
    severity: "high",
  }),
  "customer.complaint": (p) => ({
    text: `Customer complaint received${p.order_id ? ` regarding order ${p.order_id}` : ""}. ${p.description ?? p.message ?? p.complaint ?? "Issue not specified."} Immediate follow-up required.`,
    severity: "high",
  }),
  "transaction.fraud_alert": (p) => ({
    text: `Fraud alert triggered${p.amount ? ` on transaction of $${p.amount}` : ""}${p.transaction_id ? ` (${p.transaction_id})` : ""}. ${p.reason ?? "Suspicious activity detected."} Security review required immediately.`,
    severity: "critical",
  }),
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const posAdapter: IntegrationAdapter = {
  system: "pos" as SystemType,
  providers: ["square", "stripe", "toast", "clover", "generic"],
  eventTypes: Object.keys(GENERIC_EVENT_TEMPLATES).concat([
    "charge.failed",
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.updated",
    "payment_intent.payment_failed",
    "invoice.payment_failed",
    "customer.subscription.deleted",
    "refund.created",
    "refund.updated",
    "dispute.created",
    "dispute.state_changed",
    "order.created",
    "order.updated",
    "ORDER_CANCELLED",
    "PAYMENT_FAILED",
  ]),

  supports(event: RawSystemEvent): boolean {
    return event.system === "pos";
  },

  normalize(event: RawSystemEvent): NormalizedEvent {
    const p = event.payload;
    const provider = (event.provider ?? "generic").toLowerCase();

    let result: NormalizedEvent | null = null;

    if (provider === "stripe") result = stripeEvent(event, p);
    else if (provider === "square") result = squareEvent(event, p);
    else if (provider === "toast") result = toastEvent(event, p);

    if (!result) {
      // Generic fallback
      const tpl = GENERIC_EVENT_TEMPLATES[event.event_type];
      if (tpl) {
        const { text, severity } = tpl(p);
        result = {
          text,
          source: "api",
          ...extractContact(event, p),
          metadata: meta(event, severity),
        };
      }
    }

    if (!result) {
      // Last-resort: stringify the most useful payload fields
      const parts: string[] = [
        `POS event "${event.event_type}"`,
        event.provider ? `from ${event.provider}` : "",
        p.description ? String(p.description) : "",
        p.message ? String(p.message) : "",
        p.order_id ? `order ${p.order_id}` : "",
        p.amount ? `amount $${p.amount}` : "",
      ].filter(Boolean);

      result = {
        text: parts.join(". "),
        source: "api",
        ...extractContact(event, p),
        metadata: meta(event, "medium"),
      };
    }

    return result;
  },
};
