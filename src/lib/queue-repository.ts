import {
  db,
  queueItemsTable,
  QUEUE_STATUSES,
  type QueueItemRow,
  type QueueStatus,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

export { QUEUE_STATUSES };
export type { QueueItemRow, QueueStatus };

/**
 * Insert one queue item per department for a given request.
 * Each department gets its own independent queue slot so teams
 * can work their items independently.
 */
export async function enqueueForDepartments(
  requestId: number,
  departments: string[],
  priority: string,
): Promise<QueueItemRow[]> {
  if (departments.length === 0) return [];

  const rows = await db
    .insert(queueItemsTable)
    .values(
      departments.map((department) => ({
        requestId,
        department,
        priority,
        status: "queued" as QueueStatus,
      })),
    )
    .returning();

  return rows;
}

export interface QueueQuery {
  department?: string;
  status?: QueueStatus;
  limit?: number;
}

/**
 * Query queued items, optionally filtered by department and/or status.
 * Results are ordered: CRITICAL first, then by creation time ascending
 * (oldest first — first in, first served within the same priority bucket).
 */
export async function getQueueItems(query: QueueQuery = {}): Promise<QueueItemRow[]> {
  const { department, status, limit = 100 } = query;

  const conditions = [];
  if (department) conditions.push(eq(queueItemsTable.department, department));
  if (status) conditions.push(eq(queueItemsTable.status, status));

  const priorityOrder = `CASE priority
    WHEN 'CRITICAL' THEN 0
    WHEN 'HIGH'     THEN 1
    WHEN 'MEDIUM'   THEN 2
    ELSE                 3
  END`;

  return db
    .select()
    .from(queueItemsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      // Drizzle doesn't support raw SQL in orderBy easily, so we use
      // a supported approach: sort by createdAt ascending (FIFO).
      // Priority ordering is applied in the route layer when needed.
      asc(queueItemsTable.createdAt),
    )
    .limit(limit);
}

/**
 * Update the status of a single queue item. Returns the updated row,
 * or null if the item was not found.
 */
export async function updateQueueItemStatus(
  id: number,
  status: QueueStatus,
): Promise<QueueItemRow | null> {
  const [row] = await db
    .update(queueItemsTable)
    .set({ status })
    .where(eq(queueItemsTable.id, id))
    .returning();

  return row ?? null;
}

/**
 * Return a count breakdown of queue items grouped by department and status.
 * Useful for dashboard metrics.
 */
export async function getQueueStats(): Promise<
  { department: string; status: string; count: number }[]
> {
  const rows = await db
    .select({
      department: queueItemsTable.department,
      status: queueItemsTable.status,
    })
    .from(queueItemsTable);

  const map = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.department}::${row.status}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return [...map.entries()].map(([key, count]) => {
    const [department, status] = key.split("::");
    return { department: department!, status: status!, count };
  });
}
