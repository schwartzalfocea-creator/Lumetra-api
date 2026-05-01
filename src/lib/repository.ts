import { db, requestsTable, type RequestRow } from "@workspace/db";
import { desc, eq, gte, sql } from "drizzle-orm";

export interface PersistRequestInput {
  originalText: string;
  detectedLanguage: string;
  lumetraCode: string;
  finalResponse: string;
  routeUsed: string;
  department: string;
  departments: string[];
  priority: string;
  confidence: number;
  source: string;
  rootsHit: string[];
  timeSavedMin: number;
  costSavedUsd: number;
  latencyMs: number;
  aiUsed: boolean;
  aiModel?: string | null;
  aiReasoning?: string | null;
  firewallAction: string;
  firewallFlags: string[];
  matchedRules: string[];
}

export async function persistRequest(
  input: PersistRequestInput,
): Promise<RequestRow> {
  const [row] = await db
    .insert(requestsTable)
    .values({
      ...input,
      aiModel: input.aiModel ?? null,
      aiReasoning: input.aiReasoning ?? null,
    })
    .returning();

  if (!row) throw new Error("Failed to insert request");

  return row;
}

export async function getMetrics() {
  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(requestsTable);

  const total = totalRow[0]?.count ?? 0;

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const todayRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(requestsTable)
    .where(gte(requestsTable.timestamp, since));

  const today = todayRow[0]?.count ?? 0;

  return {
    totals: { all: total, today },
  };
}

export async function getRecentRequests(limit = 20) {
  return db
    .select()
    .from(requestsTable)
    .orderBy(desc(requestsTable.timestamp))
    .limit(limit);
}
