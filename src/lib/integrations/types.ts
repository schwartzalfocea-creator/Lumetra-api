// ---------------------------------------------------------------------------
// System Integration Layer — Shared Types
//
// All external-system events flow through this contract.  No AI involved at
// any stage; all normalization is deterministic rule-based mapping.
// ---------------------------------------------------------------------------

import type { IntakeResult } from "../intake";
import type { OperationWriteResult } from "../operations/types";
import type { ConfirmationBatchRow } from "../operations/confirmer";

export type SystemType =
  | "pos"      // Point-of-sale (Square, Stripe, Toast, Clover, generic)
  | "database" // Row-change / CDC events (Debezium, pg_notify, generic)
  | "api"      // Third-party REST API events (Zendesk, HubSpot, Jira, GitHub, Salesforce)
  | "crm"      // Dedicated CRM events (Salesforce, HubSpot deals/contacts)
  | "iot"      // IoT sensor / device events (MQTT bridged, Webhooks)
  | "erp";     // ERP system events (SAP, Oracle, NetSuite, generic)

// ---------------------------------------------------------------------------
// Input: what external systems send us
// ---------------------------------------------------------------------------

export interface RawSystemEvent {
  /** Which class of system emitted the event. */
  system: SystemType;
  /**
   * Specific vendor name (lowercase).
   * Examples: "square", "stripe", "zendesk", "hubspot", "salesforce",
   * "jira", "github", "sap", "oracle", "debezium"
   */
  provider?: string;
  /**
   * The event name in the source system's vocabulary.
   * Examples: "payment.failed", "order.cancelled", "ticket.created"
   */
  event_type: string;
  /** Raw payload from the source system — adapter-specific shape. */
  payload: Record<string, unknown>;
  /** External record identifier (for idempotency / deduplication). */
  source_id?: string;
  /** ISO-8601 timestamp from the source system (falls back to now). */
  occurred_at?: string;
  /** Optional pre-extracted contact info (overrides payload extraction). */
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
}

// ---------------------------------------------------------------------------
// Output: what the normalizer returns — ready for processIntake()
// ---------------------------------------------------------------------------

export interface NormalizedEvent {
  /** Human-readable description suitable for Lumetra semantic parsing. */
  text: string;
  /** Mapped to IntakeInput.source — drives channel routing. */
  source: string;
  /** Contact info extracted or provided by the caller. */
  to_email?: string;
  to_phone?: string;
  from_name?: string;
  metadata: {
    system: SystemType;
    provider?: string;
    event_type: string;
    source_id?: string;
    occurred_at: string;
    /** Adapter-assessed severity before Lumetra triage. */
    severity?: "low" | "medium" | "high" | "critical";
    /** Adapter-specific key-value extras for audit logs. */
    extra?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Result returned to the caller
// ---------------------------------------------------------------------------

export interface IntegrationProcessingResult {
  ok: boolean;
  system: SystemType;
  provider?: string;
  event_type: string;
  source_id?: string;
  normalized_text: string;
  processing_time_ms: number;
  triage: {
    id: number;
    department: string;
    departments: string[];
    priority: string;
    action: string;
    confidence: number;
    sla: string;
    lumetra_code: string;
    business_actions: IntakeResult["business_actions"];
    channel_dispatch: IntakeResult["channel_dispatch"];
  };
  /** Structured business operations extracted and persisted to the database. */
  operations: OperationWriteResult[];
  /**
   * The confirmation batch created for these operations.
   * null if no operations were extracted.
   */
  confirmationBatch: ConfirmationBatchRow | null;
}

// ---------------------------------------------------------------------------
// Adapter interface — every adapter must implement this
// ---------------------------------------------------------------------------

export interface IntegrationAdapter {
  readonly system: SystemType;
  /** Vendor names this adapter handles (empty = all for this system). */
  readonly providers: string[];
  /** Event types this adapter can normalize. */
  readonly eventTypes: string[];
  /** Return true when this adapter should handle the given event. */
  supports(event: RawSystemEvent): boolean;
  /** Convert a raw event into a NormalizedEvent. Throws on unrecognizable payload. */
  normalize(event: RawSystemEvent): NormalizedEvent;
}
