// ---------------------------------------------------------------------------
// Channel Router
//
// Source-aware, deterministic dispatch layer.  No AI.  Selects and sequences
// delivery channels based on how the original message arrived:
//
//   whatsapp → WhatsApp (primary, order 1) + Email (fallback, order 2)
//   email    → Email (primary, order 1) + WhatsApp (fallback, order 2)
//   web / api / mobile → Email only
//
// CRITICAL priority always dispatches on ALL available channels simultaneously
// (Promise.all), regardless of whether the fallback contact is provided.
// ---------------------------------------------------------------------------

import { sendWhatsApp } from "./channels/whatsapp";
import { sendEmail } from "./channels/email";
import type { ChannelResult } from "./channels/types";

export interface ChannelDispatch extends ChannelResult {
  order: 1 | 2;
}

export interface ChannelRouterInput {
  source: string;
  toPhone?: string;
  toEmail?: string;
  fromName?: string;
  message: string;
  department: string;
  priority: string;
  sla: string;
  requestId: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function dispatchWhatsApp(
  input: ChannelRouterInput,
  order: 1 | 2,
): Promise<ChannelDispatch> {
  const result = await sendWhatsApp({
    to: input.toPhone ?? "",
    body: input.message,
    department: input.department,
    priority: input.priority,
    sla: input.sla,
    requestId: input.requestId,
  });
  return { ...result, order };
}

async function dispatchEmail(
  input: ChannelRouterInput,
  order: 1 | 2,
): Promise<ChannelDispatch> {
  const result = await sendEmail({
    to: input.toEmail ?? "",
    subject: "", // buildSubject handles this internally
    body: input.message,
    department: input.department,
    priority: input.priority,
    sla: input.sla,
    requestId: input.requestId,
    fromName: input.fromName,
  });
  return { ...result, order };
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

export async function routeToChannels(
  input: ChannelRouterInput,
): Promise<ChannelDispatch[]> {
  const isCritical = input.priority === "CRITICAL";
  const src = input.source.toLowerCase();

  if (src === "whatsapp") {
    if (isCritical) {
      // CRITICAL: blast all channels simultaneously
      return Promise.all([
        dispatchWhatsApp(input, 1),
        dispatchEmail(input, 2),
      ]);
    }
    const primary = await dispatchWhatsApp(input, 1);
    const fallback = await dispatchEmail(input, 2);
    return [primary, fallback];
  }

  if (src === "email") {
    if (isCritical) {
      return Promise.all([
        dispatchEmail(input, 1),
        dispatchWhatsApp(input, 2),
      ]);
    }
    const primary = await dispatchEmail(input, 1);
    const fallback = await dispatchWhatsApp(input, 2);
    return [primary, fallback];
  }

  // web / api / mobile — email only
  const primary = await dispatchEmail(input, 1);
  return [primary];
}
