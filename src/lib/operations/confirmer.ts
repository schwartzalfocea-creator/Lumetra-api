// ---------------------------------------------------------------------------
// Operation Confirmer  (v3 — atomic optimistic lock + expiry + reservations)
//
// confirmBatch:
//   • Sweeps expired batches first
//   • Inside a single transaction: atomically claims status=confirmed only if
//     current status=pending_confirmation (optimistic lock — concurrent-safe)
//   • Runs all executors inside that same transaction
//   • Releases quantityReserved after executing sale ops
//   • If any executor throws, the full tx rolls back (no partial execution)
//
// rejectBatch:
//   • Atomically claims status=rejected the same way
//   • Releases stock reservations within the same transaction
//
// expireBatch / sweepExpiredBatches:
//   • Release reservations + mark expired
//   • sweepExpiredBatches is idempotent and race-safe (conditional UPDATE)
// ---------------------------------------------------------------------------

import { eq, and, inArray, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db,
  operationsTable,
  confirmationBatchesTable,
  inventoryItemsTable,
} from "@workspace/db";
import type { ConfirmationBatchRow } from "@workspace/db";
import { executeOperation } from "./executor";
import { releaseReservationsByOpIds } from "./reservations";
import { logger } from "../logger";

export type { ConfirmationBatchRow };

// ---------------------------------------------------------------------------
// Load batch
// ---------------------------------------------------------------------------

export async function getBatch(batchId: string): Promise<ConfirmationBatchRow | null> {
  const rows = await db
    .select()
    .from(confirmationBatchesTable)
    .where(eq(confirmationBatchesTable.batchId, batchId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// expireBatch — idempotent; releases reservations and marks expired
// ---------------------------------------------------------------------------

export async function expireBatch(batchId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Atomically claim: only proceed if still pending_confirmation
    const claimed = await tx
      .update(confirmationBatchesTable)
      .set({ status: "expired" })
      .where(
        and(
          eq(confirmationBatchesTable.batchId, batchId),
          eq(confirmationBatchesTable.status, "pending_confirmation"),
        ),
      )
      .returning({
        operationIds: confirmationBatchesTable.operationIds,
        batchId: confirmationBatchesTable.batchId,
      });

    if (claimed.length === 0) return; // Already handled

    const opIds = (claimed[0].operationIds as number[]) ?? [];

    // Release stock reservations
    await releaseReservationsByOpIds(tx, opIds);

    // Mark ops with expiry note (leave executed=false)
    if (opIds.length > 0) {
      await tx
        .update(operationsTable)
        .set({ executionLog: { expired: true, batchId, reason: "batch expired after 20 minutes" } })
        .where(inArray(operationsTable.id, opIds));
    }
  });

  logger.info({ batchId }, "confirmation batch expired — reservations released");
}

// ---------------------------------------------------------------------------
// sweepExpiredBatches — safe to call concurrently (expireBatch is idempotent)
// ---------------------------------------------------------------------------

export async function sweepExpiredBatches(): Promise<number> {
  const expired = await db
    .select({ batchId: confirmationBatchesTable.batchId })
    .from(confirmationBatchesTable)
    .where(
      and(
        eq(confirmationBatchesTable.status, "pending_confirmation"),
        lt(confirmationBatchesTable.expiresAt, new Date()),
      ),
    );

  let count = 0;
  for (const { batchId } of expired) {
    await expireBatch(batchId);
    count++;
  }
  if (count > 0) {
    logger.info({ count }, "swept expired confirmation batches");
  }
  return count;
}

// ---------------------------------------------------------------------------
// confirmBatch — atomic optimistic lock prevents double-execution
// ---------------------------------------------------------------------------

export async function confirmBatch(
  batchId: string,
  note?: string,
): Promise<{ ok: true; batch: ConfirmationBatchRow } | { ok: false; error: string; code?: string }> {
  // Sweep expired batches before attempting to confirm
  await sweepExpiredBatches();

  try {
    const saleOpsForRelease: Array<{ sku: string; quantity: number }> = [];

    await db.transaction(async (tx) => {
      // ── Atomic status claim (optimistic lock) ──────────────────────────
      // Only proceeds if the batch is STILL pending_confirmation.
      // If two concurrent requests arrive simultaneously, only ONE UPDATE
      // will match the WHERE clause — the other gets 0 rows and throws.
      const claimed = await tx
        .update(confirmationBatchesTable)
        .set({ status: "confirmed", confirmedAt: new Date(), reviewNote: note ?? null })
        .where(
          and(
            eq(confirmationBatchesTable.batchId, batchId),
            eq(confirmationBatchesTable.status, "pending_confirmation"),
          ),
        )
        .returning({
          operationIds: confirmationBatchesTable.operationIds,
          expiresAt: confirmationBatchesTable.expiresAt,
        });

      if (claimed.length === 0) {
        // Either batch doesn't exist, already confirmed/rejected, or just expired
        // Load current state to give a precise error
        const current = await tx
          .select({ status: confirmationBatchesTable.status, expiresAt: confirmationBatchesTable.expiresAt })
          .from(confirmationBatchesTable)
          .where(eq(confirmationBatchesTable.batchId, batchId))
          .limit(1);

        if (current.length === 0) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });

        const status = current[0].status;
        if (status === "expired") throw Object.assign(new Error("EXPIRED"), { code: "EXPIRED" });
        throw Object.assign(new Error(`ALREADY_${status.toUpperCase()}`), { code: `ALREADY_${status.toUpperCase()}` });
      }

      const { operationIds, expiresAt } = claimed[0];

      // Double-check TTL (belt-and-suspenders — sweep may have missed a race)
      if (expiresAt && new Date(expiresAt) < new Date()) {
        // Roll back this claim by flipping back to expired
        await tx
          .update(confirmationBatchesTable)
          .set({ status: "expired", confirmedAt: null })
          .where(eq(confirmationBatchesTable.batchId, batchId));
        await releaseReservationsByOpIds(tx, operationIds as number[]);
        throw Object.assign(new Error("EXPIRED"), { code: "EXPIRED" });
      }

      const opIds = (operationIds as number[]) ?? [];
      if (opIds.length === 0) throw new Error("Batch contains no operations");

      // ── Execute all operations ──────────────────────────────────────────
      // IMPORTANT: errors here propagate out of the tx callback → full rollback.
      // This means the status='confirmed' UPDATE above is also rolled back,
      // returning the batch to 'pending_confirmation'. No partial execution.
      const ops = await tx.select().from(operationsTable).where(inArray(operationsTable.id, opIds));

      for (const opRow of ops) {
        const businessOp = {
          type: opRow.type as Parameters<typeof executeOperation>[1]["type"],
          status: opRow.status as Parameters<typeof executeOperation>[1]["status"],
          amount: opRow.amount ?? undefined,
          currency: opRow.currency ?? "USD",
          sku: opRow.sku ?? undefined,
          productName: opRow.productName ?? undefined,
          quantity: opRow.quantity ?? undefined,
          customerName: opRow.customerName ?? undefined,
          customerEmail: opRow.customerEmail ?? undefined,
          vendorName: opRow.vendorName ?? undefined,
          sourceSystem: (opRow.sourceSystem ?? "pos") as Parameters<typeof executeOperation>[1]["sourceSystem"],
          sourceEventType: opRow.sourceEventType ?? "",
          sourceId: opRow.sourceId ?? undefined,
          data: (opRow.data as Record<string, unknown>) ?? {},
        };

        // executeOperation throws on critical failures (e.g. insufficient stock at
        // execution time). The error propagates → entire tx rolls back → batch
        // reverts to pending_confirmation → no partial state committed.
        const result = await executeOperation(tx, businessOp);

        await tx
          .update(operationsTable)
          .set({ executed: true, executionLog: result.log, executionError: null })
          .where(eq(operationsTable.id, opRow.id));

        // Track sale ops for reservation release
        if (opRow.type === "sale" && opRow.status === "completed" && opRow.sku && (opRow.quantity ?? 0) > 0) {
          saleOpsForRelease.push({ sku: opRow.sku, quantity: opRow.quantity! });
        }
      }

      // ── Release stock reservations ──────────────────────────────────────
      for (const { sku, quantity } of saleOpsForRelease) {
        await tx
          .update(inventoryItemsTable)
          .set({
            quantityReserved: sql`GREATEST(0, ${inventoryItemsTable.quantityReserved} - ${quantity})`,
            updatedAt: new Date(),
          })
          .where(eq(inventoryItemsTable.sku, sku));
      }
    });

    logger.info({ batchId }, "confirmation batch confirmed and executed");
    const updated = await getBatch(batchId);
    return { ok: true, batch: updated! };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const raw = err instanceof Error ? err.message : "Transaction failed";

    if (code === "NOT_FOUND") return { ok: false, error: "Batch not found", code };
    if (code === "EXPIRED") return { ok: false, error: "EXPIRED", code };
    if (code?.startsWith("ALREADY_")) {
      const status = code.replace("ALREADY_", "").toLowerCase();
      return { ok: false, error: `Batch is already ${status}`, code };
    }

    logger.error({ batchId, err }, "confirmation transaction failed");
    return { ok: false, error: raw };
  }
}

// ---------------------------------------------------------------------------
// rejectBatch — atomic optimistic lock + reservation release
// ---------------------------------------------------------------------------

export async function rejectBatch(
  batchId: string,
  note?: string,
): Promise<{ ok: true; batch: ConfirmationBatchRow } | { ok: false; error: string; code?: string }> {
  await sweepExpiredBatches();

  try {
    await db.transaction(async (tx) => {
      // Atomic status claim
      const claimed = await tx
        .update(confirmationBatchesTable)
        .set({ status: "rejected", rejectedAt: new Date(), reviewNote: note ?? null })
        .where(
          and(
            eq(confirmationBatchesTable.batchId, batchId),
            eq(confirmationBatchesTable.status, "pending_confirmation"),
          ),
        )
        .returning({ operationIds: confirmationBatchesTable.operationIds });

      if (claimed.length === 0) {
        const current = await tx
          .select({ status: confirmationBatchesTable.status })
          .from(confirmationBatchesTable)
          .where(eq(confirmationBatchesTable.batchId, batchId))
          .limit(1);

        if (current.length === 0) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
        const status = current[0].status;
        throw Object.assign(new Error(`ALREADY_${status.toUpperCase()}`), { code: `ALREADY_${status.toUpperCase()}` });
      }

      const opIds = (claimed[0].operationIds as number[]) ?? [];

      // Release stock reservations
      await releaseReservationsByOpIds(tx, opIds);

      // Mark ops with rejection note (stay executed=false)
      if (opIds.length > 0) {
        await tx
          .update(operationsTable)
          .set({ executionLog: { rejected: true, batchId, reason: note ?? "operator rejected" } })
          .where(inArray(operationsTable.id, opIds));
      }
    });

    logger.info({ batchId }, "confirmation batch rejected — reservations released");
    const updated = await getBatch(batchId);
    return { ok: true, batch: updated! };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_FOUND") return { ok: false, error: "Batch not found", code };
    if (code?.startsWith("ALREADY_")) {
      const status = code.replace("ALREADY_", "").toLowerCase();
      return { ok: false, error: `Batch is already ${status}`, code };
    }
    logger.error({ batchId, err }, "rejection transaction failed");
    return { ok: false, error: err instanceof Error ? err.message : "Rejection failed" };
  }
}
