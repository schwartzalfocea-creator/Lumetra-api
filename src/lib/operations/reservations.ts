// ---------------------------------------------------------------------------
// Stock Reservations — soft-lock system
//
// When a confirmation batch is created for a sale:
//   • available = quantityOnHand - quantityReserved
//   • if available >= required → increment quantityReserved (soft-lock)
//   • if available < required  → throw (writer.ts captures + marks stock failed)
//
// On confirm: executor decrements quantityOnHand; we also decrement
//             quantityReserved inside the same transaction.
// On reject / expire: decrement quantityReserved, leave quantityOnHand alone.
// ---------------------------------------------------------------------------

import { eq, sql, inArray } from "drizzle-orm";
import { db, inventoryItemsTable, operationsTable } from "@workspace/db";
import type { BusinessOperation } from "./types";

// Infer Tx type from the db instance
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sale ops that affect inventory (completed + SKU + qty > 0). */
export function getSaleOpsWithStock(ops: BusinessOperation[]) {
  return ops.filter(
    (o) =>
      o.type === "sale" &&
      o.status === "completed" &&
      o.sku != null &&
      (o.quantity ?? 0) > 0,
  );
}

/** Aggregate required quantity per SKU. */
export function aggregateBySku(
  ops: BusinessOperation[],
): Map<string, { qty: number; productName?: string }> {
  const map = new Map<string, { qty: number; productName?: string }>();
  for (const op of getSaleOpsWithStock(ops)) {
    const existing = map.get(op.sku!) ?? { qty: 0, productName: op.productName };
    map.set(op.sku!, {
      qty: existing.qty + op.quantity!,
      productName: existing.productName ?? op.productName,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// reserveSaleStock — opens its own transaction; called from writer.ts
// ---------------------------------------------------------------------------

/**
 * Atomically soft-lock stock for all completed sale ops.
 *
 * Per SKU: upsert row, then conditional UPDATE …
 *   SET quantity_reserved += qty WHERE (on_hand - reserved) >= qty
 * If 0 rows updated → insufficient available → throws descriptive error.
 *
 * writer.ts catches the throw and marks the stock check as failed.
 */
export async function reserveSaleStock(ops: BusinessOperation[]): Promise<void> {
  const bySku = aggregateBySku(ops);
  if (bySku.size === 0) return;

  await db.transaction(async (tx) => {
    for (const [sku, { qty, productName }] of bySku) {
      // Ensure the row exists (zero stock = OK; we'll fail below if insufficient)
      await tx
        .insert(inventoryItemsTable)
        .values({ sku, productName: productName ?? null, quantityOnHand: 0 })
        .onConflictDoNothing();

      // Atomic conditional reserve — only succeeds when available >= qty
      const updated = await tx
        .update(inventoryItemsTable)
        .set({
          quantityReserved: sql`${inventoryItemsTable.quantityReserved} + ${qty}`,
          updatedAt: new Date(),
        })
        .where(
          sql`${inventoryItemsTable.sku} = ${sku}
              AND (${inventoryItemsTable.quantityOnHand} - ${inventoryItemsTable.quantityReserved}) >= ${qty}`,
        )
        .returning({ sku: inventoryItemsTable.sku });

      if (updated.length === 0) {
        // Row definitely exists after upsert — so insufficient stock
        const rows = await tx
          .select({
            onHand: inventoryItemsTable.quantityOnHand,
            reserved: inventoryItemsTable.quantityReserved,
          })
          .from(inventoryItemsTable)
          .where(eq(inventoryItemsTable.sku, sku))
          .limit(1);
        const available = (rows[0]?.onHand ?? 0) - (rows[0]?.reserved ?? 0);
        throw new Error(
          `Insufficient stock for ${sku}: need ${qty}, available ${available}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// releaseReservations — inside caller's tx (reject / expire)
// ---------------------------------------------------------------------------

/**
 * Decrement quantityReserved for all sale ops.
 * Clamped to 0 (idempotent-safe).
 */
export async function releaseReservations(
  tx: Tx,
  ops: BusinessOperation[],
): Promise<void> {
  const bySku = aggregateBySku(ops);
  for (const [sku, { qty }] of bySku) {
    await tx
      .update(inventoryItemsTable)
      .set({
        quantityReserved: sql`GREATEST(0, ${inventoryItemsTable.quantityReserved} - ${qty})`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItemsTable.sku, sku));
  }
}

// ---------------------------------------------------------------------------
// releaseReservationsByOpIds — used when we only have DB IDs (expire sweep)
// ---------------------------------------------------------------------------

/**
 * Load operation rows by IDs, then release their reservations.
 * Called from expireBatch which only has operationIds, not BusinessOperation[].
 */
export async function releaseReservationsByOpIds(
  tx: Tx,
  opIds: number[],
): Promise<void> {
  if (opIds.length === 0) return;

  const opRows = await tx
    .select({
      type: operationsTable.type,
      status: operationsTable.status,
      sku: operationsTable.sku,
      quantity: operationsTable.quantity,
    })
    .from(operationsTable)
    .where(inArray(operationsTable.id, opIds));

  const bySku = new Map<string, number>();
  for (const op of opRows) {
    if (
      op.type === "sale" &&
      op.status === "completed" &&
      op.sku &&
      (op.quantity ?? 0) > 0
    ) {
      bySku.set(op.sku, (bySku.get(op.sku) ?? 0) + (op.quantity ?? 0));
    }
  }

  for (const [sku, qty] of bySku) {
    await tx
      .update(inventoryItemsTable)
      .set({
        quantityReserved: sql`GREATEST(0, ${inventoryItemsTable.quantityReserved} - ${qty})`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItemsTable.sku, sku));
  }
}

// ---------------------------------------------------------------------------
// adjustReservationForSku — used during batch editing
// ---------------------------------------------------------------------------

/**
 * Adjust the reservation for a single SKU by a signed delta.
 *   delta > 0 → acquire more (conditional; throws if insufficient)
 *   delta < 0 → release some (clamped to 0)
 *   delta = 0 → noop
 */
export async function adjustReservationForSku(
  tx: Tx,
  sku: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;

  if (delta > 0) {
    const updated = await tx
      .update(inventoryItemsTable)
      .set({
        quantityReserved: sql`${inventoryItemsTable.quantityReserved} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(
        sql`${inventoryItemsTable.sku} = ${sku}
            AND (${inventoryItemsTable.quantityOnHand} - ${inventoryItemsTable.quantityReserved}) >= ${delta}`,
      )
      .returning({ sku: inventoryItemsTable.sku });

    if (updated.length === 0) {
      const rows = await tx
        .select({
          onHand: inventoryItemsTable.quantityOnHand,
          reserved: inventoryItemsTable.quantityReserved,
        })
        .from(inventoryItemsTable)
        .where(eq(inventoryItemsTable.sku, sku))
        .limit(1);
      const available = (rows[0]?.onHand ?? 0) - (rows[0]?.reserved ?? 0);
      throw new Error(
        `Insufficient stock to edit: ${sku} needs ${delta} more, only ${available} available`,
      );
    }
  } else {
    const release = Math.abs(delta);
    await tx
      .update(inventoryItemsTable)
      .set({
        quantityReserved: sql`GREATEST(0, ${inventoryItemsTable.quantityReserved} - ${release})`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItemsTable.sku, sku));
  }
}
