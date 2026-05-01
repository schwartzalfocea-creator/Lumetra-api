import { logger } from "../logger";
import type { ChannelResult } from "./types";

export type { ChannelResult };

export interface WhatsAppMessage {
  to: string;
  body: string;
  department: string;
  priority: string;
  sla: string;
  requestId: number;
}

function generateSid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "SM" + Array.from({ length: 32 }, hex).join("");
}

function formatBody(msg: WhatsAppMessage): string {
  const icon =
    msg.priority === "CRITICAL"
      ? "🚨"
      : msg.priority === "HIGH"
        ? "⚠️"
        : "ℹ️";
  return (
    `${icon} *LUMETRA TRIAGE* — ${msg.department} Dept\n` +
    `Priority: *${msg.priority}* | SLA: ${msg.sla}\n\n` +
    `${msg.body}\n\n` +
    `_Ref: LMT-${msg.requestId} · Lumetra Intake Engine_`
  );
}

export async function sendWhatsApp(
  msg: WhatsAppMessage,
): Promise<ChannelResult> {
  const timestamp = new Date().toISOString();

  if (!msg.to || msg.to.trim() === "") {
    return { channel: "whatsapp", status: "no_contact", timestamp };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber =
    process.env.TWILIO_WHATSAPP_FROM ?? "+14155238886";

  if (!accountSid || !authToken) {
    logger.info(
      {
        channel: "whatsapp",
        to: msg.to,
        priority: msg.priority,
        dept: msg.department,
      },
      "[STUB] WhatsApp dispatch simulated — set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN to enable live sending",
    );
    return {
      channel: "whatsapp",
      status: "sent",
      messageId: generateSid(),
      to: `whatsapp:${msg.to}`,
      timestamp,
    };
  }

  try {
    const formBody = new URLSearchParams({
      To: `whatsapp:${msg.to}`,
      From: `whatsapp:${fromNumber}`,
      Body: formatBody(msg),
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody.toString(),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      logger.error(
        { channel: "whatsapp", httpStatus: res.status, body },
        "Twilio send failed",
      );
      return {
        channel: "whatsapp",
        status: "failed",
        timestamp,
        error: `HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as { sid: string };
    return {
      channel: "whatsapp",
      status: "sent",
      messageId: json.sid,
      to: `whatsapp:${msg.to}`,
      timestamp,
    };
  } catch (err) {
    logger.error({ err }, "WhatsApp send threw");
    return {
      channel: "whatsapp",
      status: "failed",
      timestamp,
      error: String(err),
    };
  }
}
