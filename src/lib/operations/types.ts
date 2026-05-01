// ---------------------------------------------------------------------------
// Business Operation Layer — Types
//
// An operation is a structured record extracted from a normalized system event.
// It represents a real-world business action (sale, payment, etc.) with enough
// structured fields to be written directly to the database.
// ---------------------------------------------------------------------------

import type { OperationType, OperationStatus } from "@workspace/db";
import type { SystemType } from "../integrations/types";

export type { OperationType, OperationStatus };

export interface BusinessOperation {
  type: OperationType;
  status: OperationStatus;

  // Financial
  amount?: number;
  currency?: string;

  // Product / inventory
  sku?: string;
  productName?: string;
  quantity?: number;

  // Parties
  customerName?: string;
  customerEmail?: string;
  vendorName?: string;

  // Traceability
  sourceSystem: SystemType;
  sourceProvider?: string;
  sourceEventType: string;
  sourceId?: string;
  occurredAt?: string;

  // Verbatim payload excerpt for audit trail
  data: Record<string, unknown>;
}

export interface OperationWriteResult {
  id: number;
  type: OperationType;
  status: OperationStatus;
  sourceEventType: string;
}
