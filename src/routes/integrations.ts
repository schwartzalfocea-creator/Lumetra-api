/**
 * System Integration Routes
 *
 * POST /api/integrations/event   — Process a single system event
 * POST /api/integrations/batch   — Process up to 50 events (sequential)
 * GET  /api/integrations          — Discovery: supported systems + examples
 * GET  /api/integrations/:system  — Details for a specific system
 */

import { Router } from "express";
import {
  processSystemEvent,
  processSystemEventBatch,
} from "../lib/integrations/event-processor";
import {
  normalizeEvent,
  listSupportedSystems,
  UnsupportedSystemError,
} from "../lib/integrations/normalizer";
import type { RawSystemEvent } from "../lib/integrations/types";

const router = Router();

const SUPPORTED_SYSTEM_TYPES = ["pos", "database", "api", "crm", "iot", "erp"];
const BATCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// Example payloads per system — used for the discovery endpoint
// ---------------------------------------------------------------------------

const EXAMPLES: Record<string, object> = {
  pos: {
    system: "pos",
    provider: "stripe",
    event_type: "charge.failed",
    source_id: "ch_3NxZA2HCFGnxpD5t1e1e1234",
    occurred_at: new Date().toISOString(),
    payload: {
      data: {
        object: {
          id: "ch_3NxZA2HCFGnxpD5t1e1e1234",
          amount: 4999,
          currency: "usd",
          receipt_email: "customer@example.com",
          last_payment_error: { message: "Card was declined." },
        },
      },
    },
  },

  database: {
    system: "database",
    provider: "debezium",
    event_type: "row.updated",
    source_id: "orders:1042",
    occurred_at: new Date().toISOString(),
    payload: {
      op: "u",
      source: { table: "orders" },
      before: { id: 1042, status: "processing", total: 89.99 },
      after: { id: 1042, status: "cancelled", total: 89.99, customer_email: "jane@example.com" },
    },
  },

  api: {
    system: "api",
    provider: "zendesk",
    event_type: "ticket.created",
    source_id: "ZD-98213",
    occurred_at: new Date().toISOString(),
    payload: {
      ticket: {
        id: 98213,
        subject: "Package arrived damaged",
        description: "I received my order today but the box was crushed and the item inside is broken. I need a replacement or refund urgently.",
        priority: "high",
        status: "open",
        requester_email: "customer@example.com",
        requester_name: "John Smith",
      },
    },
  },

  crm: {
    system: "crm",
    provider: "hubspot",
    event_type: "complaint.created",
    source_id: "HS-TICKET-4421",
    occurred_at: new Date().toISOString(),
    payload: {
      objectId: "4421",
      properties: {
        subject: "Wrong item shipped and refused refund",
        content: "I ordered model A but received model B. When I contacted support they refused my refund request.",
        hs_ticket_priority: "HIGH",
        email: "buyer@example.com",
      },
    },
  },

  iot: {
    system: "iot",
    provider: "aws_iot",
    event_type: "temperature.exceeded",
    source_id: "sensor:HVAC-3B",
    occurred_at: new Date().toISOString(),
    payload: {
      device_id: "HVAC-3B",
      location: "Server Room B, Floor 3",
      temperature: 78,
      max_temperature: 65,
      unit: "C",
    },
  },

  erp: {
    system: "erp",
    provider: "sap",
    event_type: "invoice.overdue",
    source_id: "INV-2024-0987",
    occurred_at: new Date().toISOString(),
    payload: {
      invoice_number: "INV-2024-0987",
      vendor_name: "Tech Supplies Ltd.",
      amount: 12450.00,
      days_overdue: 32,
      contact_email: "billing@techsupplies.com",
    },
  },
};

// ---------------------------------------------------------------------------
// POST /api/integrations/event
// ---------------------------------------------------------------------------

router.post("/integrations/event", async (req, res, next) => {
  try {
    const body = req.body as Partial<RawSystemEvent>;

    if (!body.system || !SUPPORTED_SYSTEM_TYPES.includes(body.system)) {
      res.status(400).json({
        error: "INVALID_SYSTEM",
        message: `"system" must be one of: ${SUPPORTED_SYSTEM_TYPES.join(", ")}`,
      });
      return;
    }

    if (typeof body.event_type !== "string" || !body.event_type.trim()) {
      res.status(400).json({
        error: "MISSING_EVENT_TYPE",
        message: '"event_type" is required.',
      });
      return;
    }

    if (!body.payload || typeof body.payload !== "object") {
      res.status(400).json({
        error: "MISSING_PAYLOAD",
        message: '"payload" must be a non-null object.',
      });
      return;
    }

    const event = body as RawSystemEvent;
    const result = await processSystemEvent(event);
    res.json(result);
  } catch (err) {
    if (err instanceof UnsupportedSystemError) {
      res.status(400).json({ error: "UNSUPPORTED_SYSTEM", message: err.message });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/integrations/batch
// ---------------------------------------------------------------------------

router.post("/integrations/batch", async (req, res, next) => {
  try {
    const body = req.body;

    if (!Array.isArray(body)) {
      res.status(400).json({
        error: "INVALID_PAYLOAD",
        message: "Request body must be a JSON array of system events.",
      });
      return;
    }

    if (body.length === 0) {
      res.status(400).json({ error: "EMPTY_BATCH", message: "Batch must contain at least one event." });
      return;
    }

    if (body.length > BATCH_LIMIT) {
      res.status(413).json({
        error: "BATCH_TOO_LARGE",
        message: `Batch must contain at most ${BATCH_LIMIT} events.`,
      });
      return;
    }

    // Validate each event has the minimum required fields
    for (let i = 0; i < body.length; i++) {
      const e = body[i] as Partial<RawSystemEvent>;
      if (!e.system || !SUPPORTED_SYSTEM_TYPES.includes(e.system as string)) {
        res.status(400).json({
          error: "INVALID_SYSTEM",
          message: `Event at index ${i}: "system" must be one of: ${SUPPORTED_SYSTEM_TYPES.join(", ")}`,
        });
        return;
      }
      if (typeof e.event_type !== "string" || !e.event_type.trim()) {
        res.status(400).json({
          error: "MISSING_EVENT_TYPE",
          message: `Event at index ${i}: "event_type" is required.`,
        });
        return;
      }
      if (!e.payload || typeof e.payload !== "object") {
        res.status(400).json({
          error: "MISSING_PAYLOAD",
          message: `Event at index ${i}: "payload" must be a non-null object.`,
        });
        return;
      }
    }

    const results = await processSystemEventBatch(body as RawSystemEvent[]);

    res.json({
      processed: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/integrations
// ---------------------------------------------------------------------------

router.get("/integrations", (_req, res) => {
  const systems = listSupportedSystems();
  res.json({
    description:
      "Lumetra System Integration Layer — ingest events from external systems and process them through the triage pipeline.",
    supported_systems: systems,
    endpoints: {
      single_event: { method: "POST", url: "/api/integrations/event" },
      batch: {
        method: "POST",
        url: "/api/integrations/batch",
        max_events: BATCH_LIMIT,
      },
      discovery: { method: "GET", url: "/api/integrations" },
      system_detail: { method: "GET", url: "/api/integrations/:system" },
    },
    required_fields: ["system", "event_type", "payload"],
    optional_fields: [
      "provider",
      "source_id",
      "occurred_at",
      "customer_email",
      "customer_phone",
      "customer_name",
    ],
    examples: Object.fromEntries(
      Object.entries(EXAMPLES).map(([k]) => [
        k,
        `/api/integrations/${k}`,
      ]),
    ),
  });
});

// ---------------------------------------------------------------------------
// GET /api/integrations/:system
// ---------------------------------------------------------------------------

router.get("/integrations/:system", (req, res) => {
  const { system } = req.params as { system: string };

  if (!SUPPORTED_SYSTEM_TYPES.includes(system)) {
    res.status(404).json({
      error: "UNKNOWN_SYSTEM",
      message: `Unknown system "${system}". Supported: ${SUPPORTED_SYSTEM_TYPES.join(", ")}`,
    });
    return;
  }

  const systems = listSupportedSystems();
  const detail = systems.find((s) => s.system === system);

  // Test the normalizer on the example to get the normalized text
  let normalizedExample: string | null = null;
  const examplePayload = EXAMPLES[system] ?? EXAMPLES.api;
  try {
    const norm = normalizeEvent(examplePayload as RawSystemEvent);
    normalizedExample = norm.text;
  } catch {
    // ignore
  }

  res.json({
    system,
    ...detail,
    example_input: examplePayload,
    example_normalized_text: normalizedExample,
    note: "Send events to POST /api/integrations/event with the fields shown in example_input.",
  });
});

export default router;
