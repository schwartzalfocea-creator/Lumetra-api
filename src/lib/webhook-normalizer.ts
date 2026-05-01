/**
 * Webhook Normalizer
 *
 * Each external source (WhatsApp, email, SMS, …) sends a different payload
 * shape. This module defines a NormalizeFn per source and collects them in
 * the NORMALIZERS registry.
 *
 * To add a new source:
 *   1. Write a NormalizeFn that extracts `text` and optional metadata.
 *   2. Add it to NORMALIZERS under a short slug (e.g. "slack", "teams").
 *   3. Done. The webhook route picks it up automatically.
 *
 * A NormalizeFn returns a NormalizedMessage or null.
 * Returning null means the payload was not recognizable for that source —
 * the route responds with 422 Unprocessable Entity.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedMessage {
  /** The plain-text content to run through processIntake. */
  text: string;
  /** Source slug as it will appear in the intake record. */
  source: string;
  /** Who sent the message (phone number, email address, user ID, …). */
  senderId?: string;
  /** Email subject line, if applicable. Combined with body when non-empty. */
  subject?: string;
  /** Arbitrary key-value metadata logged alongside the request. */
  metadata: Record<string, string>;
}

export type NormalizeFn = (
  body: unknown,
  query: Record<string, string>,
  headers: Record<string, string>,
) => NormalizedMessage | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function firstOf(...values: unknown[]): string {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// WhatsApp — Twilio (application/x-www-form-urlencoded)
// ---------------------------------------------------------------------------
//
// Twilio posts form-encoded bodies. Key fields:
//   Body    – the message text
//   From    – "whatsapp:+14155238886"
//   To      – your Twilio number
//   MessageSid
//
const normalizeWhatsAppTwilio: NormalizeFn = (body) => {
  const b = obj(body);
  const text = str(b["Body"]);
  if (!text) return null;

  const rawFrom = str(b["From"]);
  const senderId = rawFrom.replace(/^whatsapp:/i, "").trim() || undefined;

  return {
    text,
    source: "whatsapp",
    senderId,
    metadata: {
      provider: "twilio",
      messageSid: str(b["MessageSid"]),
      to: str(b["To"]),
    },
  };
};

// ---------------------------------------------------------------------------
// WhatsApp — Meta Cloud API (application/json)
// ---------------------------------------------------------------------------
//
// Meta sends a deeply nested JSON structure:
// {
//   "object": "whatsapp_business_account",
//   "entry": [{
//     "changes": [{
//       "value": {
//         "messages": [{ "from": "16315551234", "text": { "body": "Hello" }, "type": "text" }],
//         "metadata": { "phone_number_id": "...", "display_phone_number": "..." }
//       }
//     }]
//   }]
// }
//
const normalizeWhatsAppMeta: NormalizeFn = (body) => {
  const b = obj(body);
  if (str(b["object"]) !== "whatsapp_business_account") return null;

  const entry = arr(b["entry"])[0];
  const change = arr(obj(entry)["changes"])[0];
  const value = obj(obj(change)["value"]);
  const message = arr(value["messages"])[0];
  const msgObj = obj(message);

  if (str(msgObj["type"]) !== "text") return null;

  const text = str(obj(msgObj["text"])["body"]);
  if (!text) return null;

  const meta = obj(value["metadata"]);
  return {
    text,
    source: "whatsapp",
    senderId: str(msgObj["from"]) || undefined,
    metadata: {
      provider: "meta",
      messageId: str(msgObj["id"]),
      phoneNumberId: str(meta["phone_number_id"]),
    },
  };
};

// Combined WhatsApp normalizer: tries Meta first, then Twilio.
const normalizeWhatsApp: NormalizeFn = (body, query, headers) =>
  normalizeWhatsAppMeta(body, query, headers) ??
  normalizeWhatsAppTwilio(body, query, headers);

// ---------------------------------------------------------------------------
// Email — multi-provider
// ---------------------------------------------------------------------------
//
// Supports:
//   SendGrid Inbound Parse – form fields: subject, text, from
//   Mailgun               – form/json fields: subject, body-plain, sender
//   Postmark              – json fields: Subject, TextBody, From
//   Generic               – any of the above fallback fields
//
const normalizeEmail: NormalizeFn = (body) => {
  const b = obj(body);

  const subject = firstOf(b["subject"], b["Subject"]);
  const bodyText = firstOf(
    b["text"],            // SendGrid
    b["body-plain"],      // Mailgun
    b["TextBody"],        // Postmark
    b["body"],            // generic
    b["plain"],
    b["content"],
  );

  // Build the intake text: combine subject + body so the engine has full context
  const parts: string[] = [];
  if (subject) parts.push(`Subject: ${subject}`);
  if (bodyText) parts.push(bodyText);
  const text = parts.join("\n\n").trim();

  if (!text) return null;

  const senderId = firstOf(
    b["from"],            // SendGrid / generic
    b["sender"],          // Mailgun
    b["From"],            // Postmark
    b["reply_to"],
  ) || undefined;

  return {
    text,
    source: "email",
    senderId,
    subject: subject || undefined,
    metadata: {
      provider: detectEmailProvider(b),
      to: firstOf(b["to"], b["To"]),
    },
  };
};

function detectEmailProvider(b: Record<string, unknown>): string {
  if ("TextBody" in b) return "postmark";
  if ("body-plain" in b) return "mailgun";
  if ("dkim" in b || "SPF" in b) return "sendgrid";
  return "generic";
}

// ---------------------------------------------------------------------------
// SMS — Twilio SMS (same shape as WhatsApp Twilio, different source tag)
// ---------------------------------------------------------------------------
const normalizeSms: NormalizeFn = (body) => {
  const b = obj(body);
  const text = str(b["Body"]);
  if (!text) return null;

  return {
    text,
    source: "sms",
    senderId: str(b["From"]) || undefined,
    metadata: {
      provider: "twilio",
      messageSid: str(b["MessageSid"]),
      to: str(b["To"]),
    },
  };
};

// ---------------------------------------------------------------------------
// Generic — plain JSON fallback for any custom integration
// ---------------------------------------------------------------------------
//
// Accepts any JSON body that has one of:
//   text | message | body | content | input
//
const normalizeGeneric: NormalizeFn = (body) => {
  const b = obj(body);
  const text = firstOf(
    b["text"],
    b["message"],
    b["body"],
    b["content"],
    b["input"],
  );
  if (!text) return null;

  return {
    text,
    source: "generic",
    senderId: str(b["sender"] ?? b["from"] ?? b["userId"] ?? b["user_id"]) || undefined,
    metadata: {},
  };
};

// ---------------------------------------------------------------------------
// Registry — add new sources here
// ---------------------------------------------------------------------------

export const NORMALIZERS: Record<string, NormalizeFn> = {
  whatsapp: normalizeWhatsApp,
  email: normalizeEmail,
  sms: normalizeSms,
  generic: normalizeGeneric,
};

export const SUPPORTED_SOURCES = Object.keys(NORMALIZERS);
