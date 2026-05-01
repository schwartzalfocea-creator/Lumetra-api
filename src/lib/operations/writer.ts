// ---------------------------------------------------------------------------
// Operation Writer  (v4 — confirmation-gated + stock reservation)
//
// Flow per event:
//   1. Generate a unique batch ID
//   2. Insert all operation rows with executed=false, linked to the batch
//   3. Run validation checks (stock uses onHand-reserved, duplicates, totals)
//   4. If stock validation passes → atomically reserve quantityReserved
//      If reservation throws (race-condition) → fold error into validation
//   5. Insert a confirmation_batch row (status=pending_confirmation, TTL=20 min)
//   6. Return: { operations, confirmationBatch }
//
// Nothing is executed until the operator explicitly confirms the batch via
//   POST /api/confirmations/:batchId/confirm
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db, operationsTable, confirmationBatchesTable } from "@workspace/db";
import type { ConfirmationSummary } from "@workspace/db";
import type { BusinessOperation, OperationWriteResult } from "./types";
import type { ConfirmationBatchRow } from "./confirmer";
import { validateOperations } from "./validator";
import { reserveSaleStock } from "./reservations";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Batch ID generation
// ---------------------------------------------------------------------------

function generateBatchId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CONF-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

export function buildSummary(
  ops: BusinessOperation[],
  _batchId: string,
): ConfirmationSummary {
  const first = ops[0];
  const totalAmount = ops.reduce((s, o) => s + (o.amount ?? 0), 0);
  const currency = first?.currency ?? "USD";

  const source = [first?.sourceSystem, first?.sourceProvider].filter(Boolean).join("/");
  const title = `${first?.sourceEventType ?? "event"} — ${source}`;

  return {
    title,
    sourceSystem: first?.sourceSystem ?? "unknown",
    sourceProvider: first?.sourceProvider,
    sourceEventType: first?.sourceEventType ?? "unknown",
    sourceId: first?.sourceId,
    operationCount: ops.length,
    items: ops.map((o) => ({
      type: o.type,
      status: o.status,
      amount: o.amount,
      currency: o.currency,
      sku: o.sku,
      productName: o.productName,
      quantity: o.quantity,
      customerEmail: o.customerEmail,
      vendorName: o.vendorName,
    })),
    totals: {
      amount: Math.round(totalAmount * 100) / 100,
      currency,
      itemCount: ops.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WriteResult {
  operations: OperationWriteResult[];
  confirmationBatch: ConfirmationBatchRow | null;
}

/** Default TTL for pending confirmation batches — 20 minutes. */
const BATCH_TTL_MS = 20 * 60 * 1000;

/**
 * Write one or more operations to the database and create a
 * pending_confirmation batch for operator review.
 *
 * Automatically reserves stock for sale ops (soft-lock).
 * If there are no operations (empty array) nothing is written.
 */
export async function writeOperations(
  operations: BusinessOperation[],
  requestId?: number,
): Promise<WriteResult> {
  if (operations.length === 0) {
    return { operations: [], confirmationBatch: null };
  }

  const batchId = generateBatchId();

  // ── Step 1: insert all operation rows ─────────────────────────────────────
  const rows = await db
    .insert(operationsTable)
    .values(
      operations.map((op) => ({
        type: op.type,
        status: op.status,
        sourceSystem: op.sourceSystem,
        sourceProvider: op.sourceProvider ?? null,
        sourceEventType: op.sourceEventType,
        sourceId: op.sourceId ?? null,
        requestId: requestId ?? null,
        amount: op.amount ?? null,
        currency: op.currency ?? "USD",
        sku: op.sku ?? null,
        productName: op.productName ?? null,
        quantity: op.quantity ?? null,
        customerName: op.customerName ?? null,
        customerEmail: op.customerEmail ?? null,
        vendorName: op.vendorName ?? null,
        data: op.data,
        occurredAt: op.occurredAt ? new Date(op.occurredAt) : null,
        confirmationBatchId: batchId,
        executed: false,
        executionLog: { awaiting_confirmation: true, batchId },
      })),
    )
    .returning({
      id: operationsTable.id,
      type: operationsTable.type,
      status: operationsTable.status,
      sourceEventType: operationsTable.sourceEventType,
    });

  const writtenOps = rows as OperationWriteResult[];

  // ── Step 2: run validation (read-only, uses onHand-reserved) ──────────────
  const validation = await validateOperations(operations, batchId);

  // ── Step 3: reserve stock if validation passed ─────────────────────────────
  // If a concurrent batch already reserved the same SKUs, the atomic UPDATE
  // will throw — we fold the error back into validation so the batch is still
  // created (in failed state) and the operator sees why.
  if (validation.checks.stock.passed) {
    try {
      await reserveSaleStock(operations);
    } catch (reserveErr) {
      const msg = reserveErr instanceof Error ? reserveErr.message : "Reservation failed";
      logger.warn({ batchId, msg }, "stock reservation failed after validation — folding into result");
      // Invalidate the stock check so the UI shows the real reason
      validation.checks.stock.passed = false;
      validation.passed = false;
      validation.hasWarnings = true;
      // Add a synthetic item to surface the error
      validation.checks.stock.items.push({
        sku: "RESERVATION_CONFLICT",
        required: 0,
        available: 0,
        pass: false,
      });
    }
  }

  // ── Step 4: build summary ticket ──────────────────────────────────────────
  const summary = buildSummary(operations, batchId);

  // ── Step 5: insert confirmation batch row (TTL = 20 minutes) ──────────────
  const expiresAt = new Date(Date.now() + BATCH_TTL_MS);

  const [batch] = await db
    .insert(confirmationBatchesTable)
    .values({
      batchId,
      status: "pending_confirmation",
      summary,
      validationResults: validation,
      operationIds: writtenOps.map((r) => r.id),
      requestId: requestId ?? null,
      expiresAt,
    })
    .returning();

  logger.info(
    {
      batchId,
      opCount: writtenOps.length,
      validationPassed: validation.passed,
      expiresAt: expiresAt.toISOString(),
      types: writtenOps.map((r) => r.type),
    },
    "confirmation batch created — awaiting operator review",
  );

  return { operations: writtenOps, confirmationBatch: batch as ConfirmationBatchRow };
}
