// ---------------------------------------------------------------------------
// Integration Event Processor
//
// Pipeline: normalize → triage → extract operations → write to DB → return.
// All steps are deterministic.  No AI is invoked during integration processing
// (the AI gate in processIntake still applies, but integrations produce
// structured, high-signal text that rarely needs AI to route correctly).
// ---------------------------------------------------------------------------

import { normalizeEvent } from "./normalizer";
import { processIntake } from "../intake";
import { extractOperations } from "../operations/extractor";
import { writeOperations } from "../operations/writer";
import type { RawSystemEvent, IntegrationProcessingResult } from "./types";
import { logger } from "../logger";

export async function processSystemEvent(
  event: RawSystemEvent,
): Promise<IntegrationProcessingResult> {
  const startedAt = Date.now();

  // ── 1. Normalize ──────────────────────────────────────────────────────────

  const normalized = normalizeEvent(event);

  const text = normalized.text.slice(0, 4000);

  logger.info(
    {
      system: event.system,
      provider: event.provider ?? "generic",
      event_type: event.event_type,
      source_id: event.source_id ?? null,
      text_length: text.length,
      severity: normalized.metadata.severity,
    },
    "integration event normalized",
  );

  // ── 2. Process through the Lumetra pipeline ───────────────────────────────

  const intake = await processIntake({
    text,
    source: normalized.source,
    toEmail: normalized.to_email,
    toPhone: normalized.to_phone,
    fromName: normalized.from_name,
  });

  // ── 3. Extract structured business operations ─────────────────────────────

  const businessOps = extractOperations(event, normalized);

  // ── 4. Persist operations + create confirmation batch ────────────────────

  const { operations: writtenOps, confirmationBatch } = await writeOperations(
    businessOps,
    intake.id,
  );

  const elapsed = Date.now() - startedAt;

  logger.info(
    {
      system: event.system,
      department: intake.department,
      priority: intake.priority,
      actions: intake.business_actions.map((a) => a.type),
      channels: intake.channel_dispatch.map((c) => `${c.channel}:${c.status}`),
      operations: writtenOps.map((o) => `${o.type}:${o.status}`),
      batchId: confirmationBatch?.batchId ?? null,
      validationPassed: confirmationBatch?.validationResults
        ? (confirmationBatch.validationResults as { passed: boolean }).passed
        : null,
      elapsed_ms: elapsed,
    },
    "integration event fully processed",
  );

  // ── 5. Shape result ───────────────────────────────────────────────────────

  return {
    ok: true,
    system: event.system,
    provider: event.provider,
    event_type: event.event_type,
    source_id: event.source_id,
    normalized_text: text,
    processing_time_ms: elapsed,
    triage: {
      id: intake.id,
      department: intake.department,
      departments: intake.departments,
      priority: intake.priority,
      action: intake.action,
      confidence: intake.confidence,
      sla: intake.sla,
      lumetra_code: intake.lumetra_code,
      business_actions: intake.business_actions,
      channel_dispatch: intake.channel_dispatch,
    },
    operations: writtenOps,
    confirmationBatch,
  };
}

/**
 * Batch processor — runs events sequentially to avoid DB contention.
 * Returns results in the same order as the input array.
 */
export async function processSystemEventBatch(
  events: RawSystemEvent[],
): Promise<
  Array<
    | IntegrationProcessingResult
    | { ok: false; error: string; event_type: string; source_id?: string }
  >
> {
  const results = [];
  for (const event of events) {
    try {
      results.push(await processSystemEvent(event));
    } catch (err) {
      logger.error(
        { err, system: event.system, event_type: event.event_type },
        "integration event processing failed",
      );
      results.push({
        ok: false as const,
        error: err instanceof Error ? err.message : "Unknown error",
        event_type: event.event_type,
        source_id: event.source_id,
      });
    }
  }
  return results;
}
