/**
 * Confirmations Routes  (v4 — human interaction layer)
 *
 * New in v4:
 *   • Session context: short-term product memory per session (X-Session-ID header)
 *   • Context words: "add 2 more" / "agregar 2 más" resolve to last product
 *   • Smart clarification: unknown product → lists available options by name
 *   • Suggested commands: every response includes actionable next steps
 *   • Guided mode: after 2 consecutive failures → step-by-step help text
 *
 * GET  /confirmations              — list (auto-sweeps expired)
 * GET  /confirmations/stats        — counts by status
 * GET  /confirmations/:batchId     — detail + ops
 * POST /confirmations/:batchId/confirm  — atomic execute
 * POST /confirmations/:batchId/reject   — atomic reject + release
 * POST /confirmations/respond           — chat-based ("confirmar" / "cancelar")
 * PATCH /confirmations/:batchId/edit    — natural language batch edit (guided)
 */

import { Router } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  confirmationBatchesTable,
  operationsTable,
  CONFIRMATION_STATUSES,
} from "@workspace/db";
import {
  confirmBatch,
  rejectBatch,
  getBatch,
  sweepExpiredBatches,
} from "../lib/operations/confirmer";
import { validateOperations } from "../lib/operations/validator";
import { adjustReservationForSku } from "../lib/operations/reservations";
import { buildSummary } from "../lib/operations/writer";
import { parseEditMessage } from "../lib/operations/language";
import type { BusinessOperation } from "../lib/operations/types";
import {
  getContext,
  recordSuccess,
  recordFailure,
  resetFailures,
  isContextWord,
  stripContextPrefix,
} from "../lib/operations/session-context";

const router = Router();

// ---------------------------------------------------------------------------
// Session ID helpers
// ---------------------------------------------------------------------------

/** Extract or generate a session ID from the request. */
function resolveSessionId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = req.headers["x-session-id"];
  const id = Array.isArray(header) ? header[0] : header;
  if (id && id.trim().length > 0) return id.trim();
  // Generate a short random ID — client should read it from the response header
  // and echo it back on subsequent requests.
  return `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Human-friendly error message translator
// ---------------------------------------------------------------------------

function friendlyError(raw: string, code?: string): string {
  if (code === "EXPIRED" || raw === "EXPIRED") {
    return "This operation has expired. Please recreate the batch by resubmitting the original event.";
  }
  if (code === "NOT_FOUND") return "Batch not found.";
  if (raw.startsWith("Batch is already confirmed")) return "This batch has already been confirmed and executed.";
  if (raw.startsWith("Batch is already rejected")) return "This batch has already been rejected.";
  if (raw.startsWith("Batch is already expired")) return "This batch has expired and cannot be processed.";
  if (raw.includes("Insufficient stock")) return "There isn't enough stock available to complete this operation.";
  if (raw.includes("negative")) return "Quantity cannot be reduced below zero.";
  if (raw.includes("no operations")) return "This batch contains no operations to process.";
  if (raw.includes("Transaction failed")) return "An unexpected error occurred. Please try again.";
  return raw;
}

/** Build the expired-batch hint payload. */
function expiredBatchResponse(batch: {
  summary?: { title?: string; sourceSystem?: string; sourceId?: string };
} | null) {
  return {
    ok: false,
    expired: true,
    message:
      "This operation has expired (20-minute window passed). You can recreate it by resubmitting the original event.",
    hint: batch
      ? {
          title: batch.summary?.title ?? "Unknown batch",
          sourceSystem: batch.summary?.sourceSystem,
          originalSourceId: batch.summary?.sourceId,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Guidance helpers
// ---------------------------------------------------------------------------

type OpRow = {
  productName: string | null;
  sku: string | null;
  quantity: number | null;
  type: string;
};

/**
 * Build a list of suggested commands based on the products available in the batch.
 * Always returned alongside API responses so the user knows what to type next.
 */
function buildSuggestions(saleOps: OpRow[], sessionProduct?: string | null): string[] {
  const products = saleOps
    .map((o) => o.productName ?? o.sku)
    .filter((p): p is string => !!p)
    .slice(0, 3);

  if (products.length === 0) {
    return [
      "confirmar  — execute all operations",
      "cancelar   — reject this batch",
    ];
  }

  const p = sessionProduct && products.includes(sessionProduct) ? sessionProduct : products[0];
  const others = products.filter((x) => x !== p);

  return [
    `eran 3 ${p}     — set quantity to 3`,
    `agregar 1 ${p}  — add 1 to quantity`,
    `quitar 1 ${p}   — subtract 1 from quantity`,
    ...(others.length > 0 ? [`eran 2 ${others[0]}   — edit a different product`] : []),
    "confirmar        — execute all operations",
    "cancelar         — reject this batch",
  ];
}

/**
 * Build a smart clarification message listing all available products.
 * Used when the user's product hint doesn't match any op.
 */
function buildSmartClarification(
  productHint: string,
  saleOps: OpRow[],
  failureCount: number,
): string {
  const available = saleOps.map((o) => o.productName ?? o.sku).filter(Boolean) as string[];

  if (failureCount >= 2) {
    // Guided mode: more verbose step-by-step help
    const productLines =
      saleOps.length > 0
        ? saleOps
            .map((o) => {
              const label = [o.productName, o.sku].filter(Boolean).join(" / ");
              return `  • ${label}${o.quantity != null ? ` — qty: ${o.quantity}` : ""}`;
            })
            .join("\n")
        : "  (no named products in this batch)";

    return [
      "Let me help you step by step.",
      "",
      "To modify a product quantity, type one of:",
      `  "eran [number] [product]"    → set exact quantity`,
      `  "agregar [number] [product]" → increase quantity`,
      `  "quitar [number] [product]"  → decrease quantity`,
      "",
      "Available products in this batch:",
      productLines,
      "",
      `Example: "eran 3 ${available[0] ?? "product"}"`,
      "",
      `When ready, say "confirmar" to execute or "cancelar" to cancel.`,
    ].join("\n");
  }

  if (available.length === 0) {
    return `No matching product found for "${productHint}". This batch has no named products — check the batch details.`;
  }

  const list = available.map((p) => `  • ${p}`).join("\n");
  return [
    `Which product do you want to modify?`,
    list,
    ``,
    `Example: "eran 3 ${available[0]}"`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GET /confirmations
// ---------------------------------------------------------------------------

router.get("/confirmations", async (req, res) => {
  try {
    await sweepExpiredBatches();

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

    const rows = await db
      .select()
      .from(confirmationBatchesTable)
      .where(
        status && CONFIRMATION_STATUSES.includes(status as (typeof CONFIRMATION_STATUSES)[number])
          ? eq(confirmationBatchesTable.status, status as (typeof CONFIRMATION_STATUSES)[number])
          : undefined,
      )
      .orderBy(desc(confirmationBatchesTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(confirmationBatchesTable);

    return res.json({ batches: rows, total, limit, offset });
  } catch {
    return res.status(500).json({ error: "Unable to load confirmations. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /confirmations/stats
// ---------------------------------------------------------------------------

router.get("/confirmations/stats", async (_req, res) => {
  try {
    const byStatus = await db
      .select({
        status: confirmationBatchesTable.status,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(confirmationBatchesTable)
      .groupBy(confirmationBatchesTable.status);

    const today = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(confirmationBatchesTable)
      .where(sql`created_at >= now() - interval '24 hours'`);

    return res.json({ by_status: byStatus, today: today[0]?.count ?? 0 });
  } catch {
    return res.status(500).json({ error: "Unable to load confirmation stats." });
  }
});

// ---------------------------------------------------------------------------
// POST /confirmations/respond  (chat-based confirm / cancel)
// MUST be before /:batchId routes
// ---------------------------------------------------------------------------

router.post("/confirmations/respond", async (req, res) => {
  try {
    const { message, batchId } = req.body ?? {};
    const sessionId = resolveSessionId(req as Parameters<typeof resolveSessionId>[0]);
    res.setHeader("X-Session-ID", sessionId);

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Please provide a message ('confirmar' or 'cancelar').",
        suggestions: ["confirmar — execute all operations", "cancelar — reject this batch"],
      });
    }
    if (typeof batchId !== "string" || !batchId.trim()) {
      return res.status(400).json({ error: "A batch ID is required." });
    }

    const lower = message.toLowerCase().trim();
    type ChatAction = "confirm" | "reject" | null;
    let action: ChatAction = null;

    if (/\b(confirmar?|confirm|aprobar|ejecutar|yes|si|sí|ok|dale)\b/.test(lower)) {
      action = "confirm";
    } else if (/\b(cancelar?|cancel|reject|rechazar|no|nope|parar)\b/.test(lower)) {
      action = "reject";
    }

    if (!action) {
      return res.status(400).json({
        error: "Command not recognized. Reply with 'confirmar' to execute, or 'cancelar' to reject.",
        suggestions: ["confirmar — execute all operations", "cancelar — reject this batch"],
      });
    }

    const batch = await getBatch(batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found." });

    if (batch.status === "expired") {
      return res.status(410).json(expiredBatchResponse(batch as Parameters<typeof expiredBatchResponse>[0]));
    }

    if (batch.status !== "pending_confirmation") {
      resetFailures(sessionId);
      return res.json({
        ok: true,
        action: "noop",
        reason:
          batch.status === "confirmed"
            ? "This batch has already been confirmed and executed."
            : `This batch was already ${batch.status}.`,
        batch,
      });
    }

    if (action === "confirm") {
      const result = await confirmBatch(batchId, `Chat: "${message}"`);
      if (!result.ok) {
        const msg = friendlyError(result.error, result.code);
        if (result.code === "EXPIRED") {
          return res.status(410).json(expiredBatchResponse(batch as Parameters<typeof expiredBatchResponse>[0]));
        }
        return res.status(400).json({ error: msg });
      }
      resetFailures(sessionId);
      return res.json({ ok: true, action: "confirmed", batch: result.batch });
    } else {
      const result = await rejectBatch(batchId, `Chat: "${message}"`);
      if (!result.ok) {
        return res.status(400).json({ error: friendlyError(result.error, result.code) });
      }
      resetFailures(sessionId);
      return res.json({ ok: true, action: "rejected", batch: result.batch });
    }
  } catch {
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// PATCH /confirmations/:batchId/edit  (natural-language batch edit — guided)
// ---------------------------------------------------------------------------

router.patch("/confirmations/:batchId/edit", async (req, res) => {
  try {
    const { batchId } = req.params;
    const { message } = req.body ?? {};

    // ── Session context ─────────────────────────────────────────────────────
    const sessionId = resolveSessionId(req as Parameters<typeof resolveSessionId>[0]);
    res.setHeader("X-Session-ID", sessionId);
    const session = getContext(sessionId);

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: 'Please describe the edit. Examples: "eran 3 jeans", "agregar 2 remeras", "quitar 1 jeans".',
        suggestions: [
          "eran [number] [product]    — set exact quantity",
          "agregar [number] [product] — increase quantity",
          "quitar [number] [product]  — decrease quantity",
        ],
      });
    }

    const batch = await getBatch(batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found." });

    if (batch.status === "expired") {
      return res.status(410).json(expiredBatchResponse(batch as Parameters<typeof expiredBatchResponse>[0]));
    }
    if (batch.status !== "pending_confirmation") {
      return res.status(400).json({
        error: `This batch cannot be edited — it has already been ${batch.status}.`,
      });
    }

    // ── Load ops for context and suggestions ────────────────────────────────
    const opIds = (batch.operationIds as number[]) ?? [];
    if (opIds.length === 0) {
      return res.status(400).json({ error: "This batch has no operations to edit." });
    }

    const opRows = await db
      .select()
      .from(operationsTable)
      .where(inArray(operationsTable.id, opIds));

    const saleOps = opRows.filter((op) => op.type === "sale");

    // ── Parse the edit instruction (number words, vague guard) ──────────────
    const parseResult = parseEditMessage(message);

    if (parseResult.clarification || !parseResult.parsed) {
      recordFailure(sessionId);
      const suggestions = buildSuggestions(saleOps, session.lastProductName);
      return res.status(422).json({
        ok: false,
        clarification:
          parseResult.clarification ??
          "Could not understand the edit. Please be more specific.",
        needsClarification: true,
        suggestions,
      });
    }

    let { action: editAction, quantity: editQty, productHint } = parseResult.parsed;

    // ── Context word resolution: "add 2 more" → last product ────────────────
    // Strip leading context prefix ("más jeans" → "jeans") first
    const strippedHint = stripContextPrefix(productHint);
    if (strippedHint !== productHint) {
      productHint = strippedHint;
    }

    if (isContextWord(productHint)) {
      // The entire hint is a context reference — try to resolve from session
      if (session.lastProductHint && session.lastBatchId === batchId) {
        productHint = session.lastProductHint;
        req.log.info({ sessionId, resolved: productHint }, "context word resolved to last product");
      } else {
        // No context available — ask for clarification with smart product list
        recordFailure(sessionId);
        const clarification = buildSmartClarification(productHint, saleOps, session.failureCount);
        const suggestions = buildSuggestions(saleOps, session.lastProductName);
        return res.status(422).json({
          ok: false,
          clarification,
          needsClarification: true,
          contextUnavailable: true,
          suggestions,
        });
      }
    }

    // ── Safe product matching (no blind fallbacks) ───────────────────────────
    const matchingOps = saleOps.filter((op) => {
      const name = (op.productName ?? "").toLowerCase();
      const sku = (op.sku ?? "").toLowerCase();
      return (name && name.includes(productHint)) || (sku && sku.includes(productHint));
    });

    if (matchingOps.length === 0) {
      // Smart clarification: list available products
      recordFailure(sessionId);
      const clarification = buildSmartClarification(productHint, saleOps, session.failureCount);
      const suggestions = buildSuggestions(saleOps, session.lastProductName);
      return res.status(422).json({
        ok: false,
        clarification,
        needsClarification: true,
        suggestions,
      });
    }

    // ── Apply edits inside a transaction ────────────────────────────────────
    await db.transaction(async (tx) => {
      for (const op of matchingOps) {
        const oldQty = op.quantity ?? 0;
        let newQty: number;

        switch (editAction) {
          case "set":      newQty = editQty; break;
          case "add":      newQty = oldQty + editQty; break;
          case "subtract": newQty = Math.max(0, oldQty - editQty); break;
          default:         newQty = oldQty;
        }

        if (newQty < 0) throw new Error("Quantity cannot be negative.");

        const qtyDelta = newQty - oldQty;
        if (op.sku && qtyDelta !== 0) {
          await adjustReservationForSku(tx, op.sku, qtyDelta);
        }

        await tx
          .update(operationsTable)
          .set({ quantity: newQty })
          .where(eq(operationsTable.id, op.id));
      }
    });

    // ── Reload + re-validate + regenerate summary ────────────────────────────
    const updatedOpRows = await db
      .select()
      .from(operationsTable)
      .where(inArray(operationsTable.id, opIds));

    const businessOps: BusinessOperation[] = updatedOpRows.map((row) => ({
      type: row.type as BusinessOperation["type"],
      status: row.status as BusinessOperation["status"],
      amount: row.amount ?? undefined,
      currency: row.currency ?? "USD",
      sku: row.sku ?? undefined,
      productName: row.productName ?? undefined,
      quantity: row.quantity ?? undefined,
      customerName: row.customerName ?? undefined,
      customerEmail: row.customerEmail ?? undefined,
      vendorName: row.vendorName ?? undefined,
      sourceSystem: (row.sourceSystem ?? "pos") as BusinessOperation["sourceSystem"],
      sourceEventType: row.sourceEventType ?? "",
      sourceId: row.sourceId ?? undefined,
      data: (row.data as Record<string, unknown>) ?? {},
    }));

    const newValidation = await validateOperations(businessOps, batchId);
    const newSummary = buildSummary(businessOps, batchId);

    await db
      .update(confirmationBatchesTable)
      .set({ validationResults: newValidation, summary: newSummary })
      .where(eq(confirmationBatchesTable.batchId, batchId));

    const updatedBatch = await getBatch(batchId);

    // ── Update session context ────────────────────────────────────────────────
    const resolvedProductName =
      matchingOps[0]?.productName ?? matchingOps[0]?.sku ?? productHint;
    recordSuccess(sessionId, batchId, productHint, resolvedProductName);

    req.log.info(
      { batchId, message, matchCount: matchingOps.length, editAction, sessionId },
      "batch edit applied",
    );

    // ── Build suggestions for the next action ────────────────────────────────
    const suggestions = buildSuggestions(
      updatedOpRows.filter((r) => r.type === "sale"),
      resolvedProductName,
    );

    return res.json({
      ok: true,
      editAction,
      matchedOps: matchingOps.length,
      matchedProduct: resolvedProductName,
      validationPassed: newValidation.passed,
      batch: updatedBatch,
      suggestions,
    });
  } catch (err) {
    const { batchId } = req.params;
    const sessionId = resolveSessionId(req as Parameters<typeof resolveSessionId>[0]);
    req.log.error({ err }, "batch edit failed");
    recordFailure(sessionId);
    const msg = err instanceof Error ? friendlyError(err.message) : "The edit could not be applied. Please try again.";
    return res.status(400).json({
      error: msg,
      suggestions: [
        "eran [number] [product]    — set exact quantity",
        "agregar [number] [product] — increase quantity",
        "quitar [number] [product]  — decrease quantity",
        "confirmar                  — execute all operations",
        "cancelar                   — reject this batch",
      ],
    });
  }
});

// ---------------------------------------------------------------------------
// GET /confirmations/:batchId
// ---------------------------------------------------------------------------

router.get("/confirmations/:batchId", async (req, res) => {
  try {
    const batch = await getBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found." });

    const opIds = (batch.operationIds as number[]) ?? [];
    const operations =
      opIds.length > 0
        ? await db.select().from(operationsTable).where(inArray(operationsTable.id, opIds))
        : [];

    return res.json({ ...batch, operations });
  } catch {
    return res.status(500).json({ error: "Unable to load batch details. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /confirmations/:batchId/confirm
// ---------------------------------------------------------------------------

router.post("/confirmations/:batchId/confirm", async (req, res) => {
  try {
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const result = await confirmBatch(req.params.batchId, note);
    if (!result.ok) {
      if (result.code === "EXPIRED") {
        const batch = await getBatch(req.params.batchId);
        return res.status(410).json(
          expiredBatchResponse(batch as Parameters<typeof expiredBatchResponse>[0]),
        );
      }
      return res.status(400).json({ error: friendlyError(result.error, result.code) });
    }
    return res.json({ ok: true, batch: result.batch });
  } catch {
    return res.status(500).json({ error: "Confirmation failed. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /confirmations/:batchId/reject
// ---------------------------------------------------------------------------

router.post("/confirmations/:batchId/reject", async (req, res) => {
  try {
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const result = await rejectBatch(req.params.batchId, note);
    if (!result.ok) {
      return res.status(400).json({ error: friendlyError(result.error, result.code) });
    }
    return res.json({ ok: true, batch: result.batch });
  } catch {
    return res.status(500).json({ error: "Rejection failed. Please try again." });
  }
});

export default router;
