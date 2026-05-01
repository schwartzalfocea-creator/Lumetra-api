/**
 * Webhook routes
 *
 * POST /api/webhook/:source  – receive an inbound message, normalize it, and
 *                              run it through processIntake.
 *
 * GET  /api/webhook/whatsapp – Meta Cloud API webhook verification challenge.
 *
 * Supported :source values:  whatsapp | email | sms | generic
 *
 * Design notes:
 *  - Always responds 200 to the external provider (Twilio, Meta, SendGrid, …)
 *    even when processing fails, so the provider does not keep retrying the
 *    same message.  Errors are logged and returned in the response body under
 *    the `error` key.
 *  - Normalization failures (unrecognizable payload) return 422 because the
 *    provider should know it sent something malformed.
 */

import { Router } from "express";
import { NORMALIZERS, SUPPORTED_SOURCES } from "../lib/webhook-normalizer";
import { processIntake } from "../lib/intake";
import { logger } from "../lib/logger";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/webhook/whatsapp
// Meta Cloud API webhook verification challenge
// ---------------------------------------------------------------------------
// Meta sends: ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
// We must echo back hub.challenge if the token matches.
// Set WEBHOOK_VERIFY_TOKEN in env vars; defaults to "lumetra-verify" in dev.
// ---------------------------------------------------------------------------

router.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expected = process.env["WEBHOOK_VERIFY_TOKEN"] ?? "lumetra-verify";

  if (mode === "subscribe" && token === expected) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }

  res.status(403).json({ error: "FORBIDDEN", message: "Verify token mismatch" });
});

// ---------------------------------------------------------------------------
// POST /api/webhook/:source
// ---------------------------------------------------------------------------

router.post("/webhook/:source", async (req, res) => {
  const { source } = req.params as { source: string };

  // 1. Check source is supported
  const normalize = NORMALIZERS[source];
  if (!normalize) {
    res.status(404).json({
      error: "UNKNOWN_SOURCE",
      message: `Unknown webhook source "${source}". Supported: ${SUPPORTED_SOURCES.join(", ")}`,
    });
    return;
  }

  // 2. Normalize payload
  const query = req.query as Record<string, string>;
  const headers = req.headers as Record<string, string>;

  const normalized = normalize(req.body, query, headers);
  if (!normalized) {
    res.status(422).json({
      error: "UNRECOGNIZABLE_PAYLOAD",
      message: `Could not extract a message from the "${source}" payload. Check the payload shape.`,
    });
    return;
  }

  // 3. Guard: text length
  const text = normalized.text.slice(0, 4000);

  // 4. Log receipt
  req.log.info(
    {
      source: normalized.source,
      senderId: normalized.senderId,
      textLength: text.length,
    },
    "webhook message received",
  );

  // 5. Run through processIntake
  // Always return 200 — errors are surfaced in the body, not via HTTP status,
  // so the provider does not retry the message.
  try {
    const result = await processIntake({ text, source: normalized.source });

    res.status(200).json({
      received: true,
      sender_id: normalized.senderId ?? null,
      subject: normalized.subject ?? null,
      metadata: normalized.metadata,
      triage: {
        id: result.id,
        department: result.department,
        departments: result.departments,
        priority: result.priority,
        action: result.action,
        route_used: result.route_used,
        confidence: result.confidence,
        sla: result.sla,
        matched_rules: result.matched_rules,
        escalation_risk: result.escalation_risk,
        language: result.language,
        lumetra_code: result.lumetra_code,
        firewall: result.firewall.action,
      },
    });
  } catch (err) {
    logger.error({ err, source: normalized.source }, "processIntake failed in webhook handler");

    res.status(200).json({
      received: true,
      error: "PROCESSING_FAILED",
      message: "Message was received but could not be processed. It has been logged.",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/webhook — discovery endpoint
// ---------------------------------------------------------------------------

router.get("/webhook", (_req, res) => {
  res.json({
    supported_sources: SUPPORTED_SOURCES,
    endpoints: SUPPORTED_SOURCES.map((s) => ({
      source: s,
      url: `/api/webhook/${s}`,
      method: "POST",
    })),
    verification: {
      url: "/api/webhook/whatsapp",
      method: "GET",
      params: ["hub.mode", "hub.verify_token", "hub.challenge"],
      note: "Set WEBHOOK_VERIFY_TOKEN in environment variables",
    },
  });
});

export default router;
