import { Router } from "express";
import {
  getQueueItems,
  updateQueueItemStatus,
  getQueueStats,
  type QueueStatus,
  QUEUE_STATUSES,
} from "../lib/queue-repository";

const router = Router();

/**
 * GET /api/queue
 * Query queue items. Accepts optional query params:
 *   ?department=Finance
 *   ?status=queued          (queued | processing | done | cancelled)
 *   ?limit=50               (default 100, max 500)
 *
 * Items are returned FIFO within each department.
 */
router.get("/queue", async (req, res, next) => {
  try {
    const { department, status, limit: limitRaw } = req.query as Record<string, string | undefined>;

    if (status && !(QUEUE_STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({
        error: "INVALID_STATUS",
        message: `status must be one of: ${QUEUE_STATUSES.join(", ")}`,
      });
      return;
    }

    const limit = Math.min(500, Math.max(1, parseInt(limitRaw ?? "100", 10) || 100));

    const items = await getQueueItems({
      department: department || undefined,
      status: (status as QueueStatus) || undefined,
      limit,
    });

    res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/queue/stats
 * Returns a count breakdown grouped by department × status.
 */
router.get("/queue/stats", async (_req, res, next) => {
  try {
    const stats = await getQueueStats();
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/queue/:id
 * Update the status of a queue item.
 * Body: { "status": "processing" | "done" | "cancelled" | "queued" }
 */
router.patch("/queue/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "INVALID_ID", message: "id must be a number" });
      return;
    }

    const body = req.body as { status?: unknown };
    const status = body?.status;

    if (typeof status !== "string" || !(QUEUE_STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({
        error: "INVALID_STATUS",
        message: `status must be one of: ${QUEUE_STATUSES.join(", ")}`,
      });
      return;
    }

    const updated = await updateQueueItemStatus(id, status as QueueStatus);
    if (!updated) {
      res.status(404).json({ error: "NOT_FOUND", message: `Queue item ${id} not found` });
      return;
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
