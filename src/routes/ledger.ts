// ---------------------------------------------------------------------------
// Ledger routes
//
// GET /api/ledger/inventory  — current stock levels per SKU
// GET /api/ledger/cash       — cash balance per account+currency
// GET /api/ledger            — combined snapshot
// ---------------------------------------------------------------------------

import { Router } from "express";
import { desc, sql } from "drizzle-orm";
import { db, inventoryItemsTable, cashBalancesTable, operationsTable } from "@workspace/db";

export const ledgerRouter = Router();

ledgerRouter.get("/ledger/inventory", async (req, res) => {
  try {
    const items = await db
      .select()
      .from(inventoryItemsTable)
      .orderBy(desc(inventoryItemsTable.updatedAt));

    return res.json({ items });
  } catch (err) {
    req.log.error({ err }, "ledger inventory query failed");
    return res.status(500).json({ error: "Failed to load inventory" });
  }
});

ledgerRouter.get("/ledger/cash", async (req, res) => {
  try {
    const balances = await db
      .select()
      .from(cashBalancesTable)
      .orderBy(desc(cashBalancesTable.updatedAt));

    return res.json({ balances });
  } catch (err) {
    req.log.error({ err }, "ledger cash query failed");
    return res.status(500).json({ error: "Failed to load cash balances" });
  }
});

ledgerRouter.get("/ledger", async (req, res) => {
  try {
    const [inventory, cash, execStats] = await Promise.all([
      db.select().from(inventoryItemsTable).orderBy(desc(inventoryItemsTable.updatedAt)),
      db.select().from(cashBalancesTable).orderBy(desc(cashBalancesTable.updatedAt)),
      db
        .select({
          executed: operationsTable.executed,
          count: sql<number>`cast(count(*) as int)`,
        })
        .from(operationsTable)
        .groupBy(operationsTable.executed),
    ]);

    const totalOps = execStats.reduce((a, r) => a + r.count, 0);
    const executedOps = execStats.find((r) => r.executed)?.count ?? 0;

    return res.json({
      inventory,
      cash,
      execution: {
        total: totalOps,
        executed: executedOps,
        pending: totalOps - executedOps,
      },
    });
  } catch (err) {
    req.log.error({ err }, "ledger snapshot query failed");
    return res.status(500).json({ error: "Failed to load ledger snapshot" });
  }
});
