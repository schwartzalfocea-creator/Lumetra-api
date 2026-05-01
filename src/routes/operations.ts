/**
 * Operations Routes
 *
 * GET  /api/operations          — List operations with optional filters
 * GET  /api/operations/stats    — Aggregate stats (by type, status, value)
 * GET  /api/operations/:id      — Single operation detail
 */

import { Router } from "express";
import { db, operationsTable, OPERATION_TYPES, OPERATION_STATUSES } from "@workspace/db";
import { desc, eq, gte, lte, and, sql, type SQL } from "drizzle-orm";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/operations
// ---------------------------------------------------------------------------
// Query params:
//   type        filter by operation type
//   status      filter by status
//   system      filter by source_system
//   from        ISO date — only operations created after this
//   to          ISO date — only operations created before this
//   limit       max results (default 50, max 200)
//   offset      pagination offset

router.get("/operations", async (req, res, next) => {
  try {
    const { type, status, system, from, to, limit: limitQ, offset: offsetQ } = req.query as Record<string, string>;

    const limit = Math.min(parseInt(limitQ ?? "50", 10) || 50, 200);
    const offset = parseInt(offsetQ ?? "0", 10) || 0;

    const conditions: SQL[] = [];

    if (type) {
      if (!(OPERATION_TYPES as readonly string[]).includes(type)) {
        res.status(400).json({ error: "INVALID_TYPE", message: `Unknown type "${type}". Valid: ${OPERATION_TYPES.join(", ")}` });
        return;
      }
      conditions.push(eq(operationsTable.type, type as typeof OPERATION_TYPES[number]));
    }

    if (status) {
      if (!(OPERATION_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ error: "INVALID_STATUS", message: `Unknown status "${status}". Valid: ${OPERATION_STATUSES.join(", ")}` });
        return;
      }
      conditions.push(eq(operationsTable.status, status as typeof OPERATION_STATUSES[number]));
    }

    if (system) {
      conditions.push(eq(operationsTable.sourceSystem, system));
    }

    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) conditions.push(gte(operationsTable.createdAt, d));
    }

    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) conditions.push(lte(operationsTable.createdAt, d));
    }

    const rows = await db
      .select({
        id: operationsTable.id,
        type: operationsTable.type,
        status: operationsTable.status,
        sourceSystem: operationsTable.sourceSystem,
        sourceProvider: operationsTable.sourceProvider,
        sourceEventType: operationsTable.sourceEventType,
        sourceId: operationsTable.sourceId,
        requestId: operationsTable.requestId,
        amount: operationsTable.amount,
        currency: operationsTable.currency,
        sku: operationsTable.sku,
        productName: operationsTable.productName,
        quantity: operationsTable.quantity,
        customerName: operationsTable.customerName,
        customerEmail: operationsTable.customerEmail,
        vendorName: operationsTable.vendorName,
        occurredAt: operationsTable.occurredAt,
        createdAt: operationsTable.createdAt,
      })
      .from(operationsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(operationsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ total: rows.length, limit, offset, operations: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/operations/stats
// ---------------------------------------------------------------------------

router.get("/operations/stats", async (_req, res, next) => {
  try {
    // Count + sum by type
    const byType = await db
      .select({
        type: operationsTable.type,
        count: sql<number>`count(*)::int`,
        total_amount: sql<number>`COALESCE(sum(amount), 0)::numeric(14,2)`,
      })
      .from(operationsTable)
      .groupBy(operationsTable.type)
      .orderBy(sql`count(*) desc`);

    // Count by status
    const byStatus = await db
      .select({
        status: operationsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(operationsTable)
      .groupBy(operationsTable.status)
      .orderBy(sql`count(*) desc`);

    // Count by system
    const bySystem = await db
      .select({
        system: operationsTable.sourceSystem,
        count: sql<number>`count(*)::int`,
      })
      .from(operationsTable)
      .groupBy(operationsTable.sourceSystem)
      .orderBy(sql`count(*) desc`);

    // Today
    const today = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(operationsTable)
      .where(gte(operationsTable.createdAt, new Date(new Date().setHours(0, 0, 0, 0))));

    // Overall totals
    const totals = await db
      .select({
        total: sql<number>`count(*)::int`,
        total_value: sql<number>`COALESCE(sum(amount), 0)::numeric(14,2)`,
        failed: sql<number>`count(*) filter (where status = 'failed')::int`,
        critical: sql<number>`count(*) filter (where status in ('failed','fraud','violation','rejected'))::int`,
      })
      .from(operationsTable);

    res.json({
      totals: totals[0],
      today: today[0]?.count ?? 0,
      by_type: byType,
      by_status: byStatus,
      by_system: bySystem,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/operations/:id
// ---------------------------------------------------------------------------

router.get("/operations/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "INVALID_ID", message: "Operation ID must be a number." });
      return;
    }

    const rows = await db
      .select()
      .from(operationsTable)
      .where(eq(operationsTable.id, id))
      .limit(1);

    if (!rows[0]) {
      res.status(404).json({ error: "NOT_FOUND", message: `Operation ${id} not found.` });
      return;
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
