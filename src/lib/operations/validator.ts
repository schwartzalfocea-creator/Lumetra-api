// ---------------------------------------------------------------------------
// Operation Validator
//
// Runs three checks before a confirmation batch is finalised:
//
//   1. Stock availability  — sales must not exceed (quantityOnHand - quantityReserved)
//                            Uses the soft-lock available figure so concurrent batches
//                            do not over-sell each other's reserved stock.
//   2. Duplicate events    — source_id must not already exist in any OTHER batch/op
//   3. Total consistency   — sum of sale amounts ≈ sum of payment amounts
//                            (within the same batch, where both are present)
//
// All checks are read-only; no mutations are performed here.
// ---------------------------------------------------------------------------

import { eq, and, not, inArray } from "drizzle-orm";
import { db, inventoryItemsTable, operationsTable } from "@workspace/db";
import type {
  ValidationResults,
  StockCheckItem,
  DuplicateCheckItem,
  TotalsCheckResult,
} from "@workspace/db";
import type { BusinessOperation } from "./types";

// ---------------------------------------------------------------------------
// 1. Stock availability check (uses available = onHand - reserved)
// ---------------------------------------------------------------------------

async function checkStock(ops: BusinessOperation[]): Promise<{
  passed: boolean;
  items: StockCheckItem[];
}> {
  const saleOps = ops.filter(
    (o) => o.type === "sale" && o.status === "completed" && o.sku && o.quantity != null && o.quantity > 0,
  );

  if (saleOps.length === 0) return { passed: true, items: [] };

  // Aggregate required quantity per SKU
  const requiredBySku = new Map<string, { qty: number; productName?: string }>();
  for (const op of saleOps) {
    const existing = requiredBySku.get(op.sku!) ?? { qty: 0, productName: op.productName };
    requiredBySku.set(op.sku!, { qty: existing.qty + op.quantity!, productName: op.productName });
  }

  const skus = Array.from(requiredBySku.keys());
  const rows = await db
    .select({
      sku: inventoryItemsTable.sku,
      productName: inventoryItemsTable.productName,
      onHand: inventoryItemsTable.quantityOnHand,
      reserved: inventoryItemsTable.quantityReserved,
    })
    .from(inventoryItemsTable)
    .where(inArray(inventoryItemsTable.sku, skus));

  const stockBySku = new Map(rows.map((r) => [r.sku, r]));

  const items: StockCheckItem[] = [];
  for (const [sku, { qty: required, productName }] of requiredBySku) {
    const stock = stockBySku.get(sku);
    // Available = on-hand minus already-reserved (soft-lock aware)
    const available = (stock?.onHand ?? 0) - (stock?.reserved ?? 0);
    items.push({
      sku,
      productName: productName ?? stock?.productName ?? undefined,
      required,
      available: Math.max(0, available),
      pass: available >= required,
    });
  }

  return { passed: items.every((i) => i.pass), items };
}

// ---------------------------------------------------------------------------
// 2. Duplicate event check
// ---------------------------------------------------------------------------

async function checkDuplicates(
  ops: BusinessOperation[],
  currentBatchId: string,
): Promise<{ passed: boolean; items: DuplicateCheckItem[] }> {
  const sourceIds = ops.map((o) => o.sourceId).filter((id): id is string => !!id);
  if (sourceIds.length === 0) return { passed: true, items: [] };

  const existing = await db
    .select({
      id: operationsTable.id,
      sourceId: operationsTable.sourceId,
      confirmationBatchId: operationsTable.confirmationBatchId,
    })
    .from(operationsTable)
    .where(
      and(
        inArray(operationsTable.sourceId, sourceIds),
        not(eq(operationsTable.confirmationBatchId, currentBatchId)),
      ),
    );

  const items: DuplicateCheckItem[] = existing
    .filter((r): r is typeof r & { sourceId: string } => r.sourceId !== null)
    .map((r) => ({
      sourceId: r.sourceId,
      existingOperationId: r.id,
      existingBatchId: r.confirmationBatchId ?? undefined,
    }));

  return { passed: items.length === 0, items };
}

// ---------------------------------------------------------------------------
// 3. Total consistency check
// ---------------------------------------------------------------------------

function checkTotals(ops: BusinessOperation[]): {
  passed: boolean;
  result: TotalsCheckResult | null;
} {
  const salesTotal = ops
    .filter((o) => o.type === "sale" && o.status === "completed" && o.amount != null)
    .reduce((sum, o) => sum + (o.amount ?? 0), 0);

  const paymentsTotal = ops
    .filter((o) => o.type === "payment" && o.status === "completed" && o.amount != null)
    .reduce((sum, o) => sum + (o.amount ?? 0), 0);

  const bothPresent = salesTotal > 0 && paymentsTotal > 0;
  if (!bothPresent) return { passed: true, result: null };

  const delta = Math.abs(salesTotal - paymentsTotal);
  const pass = delta < 0.02; // 1-cent tolerance

  return {
    passed: pass,
    result: { salesTotal, paymentsTotal, delta, pass },
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function validateOperations(
  ops: BusinessOperation[],
  batchId: string,
): Promise<ValidationResults> {
  const [stock, duplicates, totals] = await Promise.all([
    checkStock(ops),
    checkDuplicates(ops, batchId),
    Promise.resolve(checkTotals(ops)),
  ]);

  const passed = stock.passed && duplicates.passed && totals.passed;
  const hasWarnings = !passed;

  return {
    passed,
    hasWarnings,
    checks: { stock, duplicates, totals },
  };
}
