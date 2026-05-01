// ---------------------------------------------------------------------------
// Operation Executor
//
// Applies the real-world side-effects of each business operation inside the
// same database transaction used to insert the operation row.
//
// Handlers per operation type:
//   sale         → inventory -= qty  |  cash += amount  (revenue)
//   purchase     → inventory += qty  |  cash -= amount  (cost)
//   stock_update → no side-effects   (alert only)
//   payment      → cash += amount    (when completed)
//   refund       → cash -= amount    (when completed)  |  inventory += qty
//   dispute      → no side-effects   (tracked only)
//   support_ticket / contract / compliance / device_alert → no side-effects
//
// All mutations go through UPSERT so rows are auto-created on first sight.
// ---------------------------------------------------------------------------

import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import * as schema from "@workspace/db";
import type { BusinessOperation } from "./types";

// Infer the transaction type from the db instance to avoid schema shape mismatches
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Shared upsert helpers
// ---------------------------------------------------------------------------

/**
 * Ensure an inventory_items row exists for the given SKU, then atomically
 * apply `delta` to `quantity_on_hand`.  Returns the new balance.
 *
 * For decrements (negative delta): the UPDATE only succeeds when the result
 * would be >= 0 — preventing negative stock under all concurrency conditions.
 * Throws an error if stock would go negative.
 */
async function adjustInventory(
  tx: Tx,
  sku: string,
  productName: string | undefined,
  delta: number,
): Promise<{ sku: string; delta: number; newQty: number }> {
  // Upsert the row (create with 0 if it doesn't exist yet)
  await tx
    .insert(schema.inventoryItemsTable)
    .values({
      sku,
      productName: productName ?? null,
      quantityOnHand: 0,
    })
    .onConflictDoNothing();

  // Atomic increment / decrement with floor guard for negative deltas.
  // For decrements we add a WHERE guard: only update if result >= 0.
  const rows =
    delta < 0
      ? await tx
          .update(schema.inventoryItemsTable)
          .set({
            quantityOnHand: sql`${schema.inventoryItemsTable.quantityOnHand} + ${delta}`,
            productName: productName
              ? sql`COALESCE(${schema.inventoryItemsTable.productName}, ${productName})`
              : schema.inventoryItemsTable.productName,
            updatedAt: new Date(),
          })
          .where(
            sql`${schema.inventoryItemsTable.sku} = ${sku}
                AND ${schema.inventoryItemsTable.quantityOnHand} + ${delta} >= 0`,
          )
          .returning({ newQty: schema.inventoryItemsTable.quantityOnHand })
      : await tx
          .update(schema.inventoryItemsTable)
          .set({
            quantityOnHand: sql`${schema.inventoryItemsTable.quantityOnHand} + ${delta}`,
            productName: productName
              ? sql`COALESCE(${schema.inventoryItemsTable.productName}, ${productName})`
              : schema.inventoryItemsTable.productName,
            updatedAt: new Date(),
          })
          .where(eq(schema.inventoryItemsTable.sku, sku))
          .returning({ newQty: schema.inventoryItemsTable.quantityOnHand });

  if (rows.length === 0 && delta < 0) {
    throw new Error(`Insufficient stock for SKU ${sku}: cannot decrement by ${Math.abs(delta)}`);
  }

  return { sku, delta, newQty: rows[0]?.newQty ?? 0 };
}

/**
 * Ensure a cash_balances row exists for `account`+`currency`, then
 * atomically apply `delta`.  Returns the new balance.
 */
async function adjustCash(
  tx: Tx,
  delta: number,
  currency: string = "USD",
  account: string = "default",
): Promise<{ account: string; currency: string; delta: number; newBalance: number }> {
  await tx
    .insert(schema.cashBalancesTable)
    .values({ account, currency, balance: 0 })
    .onConflictDoNothing();

  const rows = await tx
    .update(schema.cashBalancesTable)
    .set({
      balance: sql`${schema.cashBalancesTable.balance} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(
      sql`${schema.cashBalancesTable.account} = ${account} AND ${schema.cashBalancesTable.currency} = ${currency}`,
    )
    .returning({ newBalance: schema.cashBalancesTable.balance });

  return { account, currency, delta, newBalance: rows[0]?.newBalance ?? 0 };
}

// ---------------------------------------------------------------------------
// Execution result type
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  applied: boolean;
  log: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-type handlers
// ---------------------------------------------------------------------------

async function executeSale(tx: Tx, op: BusinessOperation): Promise<ExecutionResult> {
  if (op.status === "pending" || op.status === "failed") {
    return { applied: true, log: { skipped: `status=${op.status} — no side-effects until fulfilled` } };
  }

  const log: Record<string, unknown> = {};
  const isCancelled = op.status === "cancelled";

  // Revenue: completed sale = cash in; cancelled = cash out (refund)
  if (op.amount != null) {
    const cashDelta = isCancelled ? -op.amount : op.amount;
    log.cash = await adjustCash(tx, cashDelta, op.currency ?? "USD");
  }

  // Inventory: completed = stock out; cancelled = stock return
  if (op.sku && op.quantity != null) {
    const invDelta = isCancelled ? op.quantity : -op.quantity;
    log.inventory = await adjustInventory(tx, op.sku, op.productName, invDelta);
  }

  return { applied: true, log };
}

async function executePurchase(tx: Tx, op: BusinessOperation): Promise<ExecutionResult> {
  // Only materialise effects for completed POs; pending/rejected/denied have none
  if (!["completed"].includes(op.status)) {
    return { applied: true, log: { skipped: `status=${op.status} — no side-effects` } };
  }

  const log: Record<string, unknown> = {};

  // Cost: cash out
  if (op.amount != null) {
    log.cash = await adjustCash(tx, -op.amount, op.currency ?? "USD");
  }

  // Goods received: stock in
  if (op.sku && op.quantity != null) {
    log.inventory = await adjustInventory(tx, op.sku, op.productName, op.quantity);
  }

  return { applied: true, log };
}

async function executePayment(tx: Tx, op: BusinessOperation): Promise<ExecutionResult> {
  // Only completed payments change the balance
  if (op.status !== "completed") {
    return { applied: true, log: { skipped: `status=${op.status} — no cash movement` } };
  }
  if (op.amount == null) {
    return { applied: true, log: { skipped: "no amount" } };
  }

  const cash = await adjustCash(tx, op.amount, op.currency ?? "USD");
  return { applied: true, log: { cash } };
}

async function executeRefund(tx: Tx, op: BusinessOperation): Promise<ExecutionResult> {
  if (op.status !== "completed") {
    return { applied: true, log: { skipped: `status=${op.status} — no side-effects` } };
  }

  const log: Record<string, unknown> = {};

  // Cash out (money back to customer)
  if (op.amount != null) {
    log.cash = await adjustCash(tx, -op.amount, op.currency ?? "USD");
  }

  // Stock returned by customer
  if (op.sku && op.quantity != null) {
    log.inventory = await adjustInventory(tx, op.sku, op.productName, op.quantity);
  }

  return { applied: true, log };
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function executeOperation(
  tx: Tx,
  op: BusinessOperation,
): Promise<ExecutionResult> {
  switch (op.type) {
    case "sale":
      return executeSale(tx, op);

    case "purchase":
      return executePurchase(tx, op);

    case "payment":
      return executePayment(tx, op);

    case "refund":
      return executeRefund(tx, op);

    // These types are fully tracked but have no inventory / cash side-effects
    case "stock_update":
    case "dispute":
    case "support_ticket":
    case "contract":
    case "compliance":
    case "device_alert":
      return { applied: true, log: { note: `${op.type} tracked — no ledger side-effects` } };

    default:
      return { applied: false, log: { error: "unknown operation type" } };
  }
}
