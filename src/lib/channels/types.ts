export interface ChannelResult {
  channel: "whatsapp" | "email";
  status: "sent" | "failed" | "not_configured" | "no_contact";
  messageId?: string;
  to?: string;
  timestamp: string;
  error?: string;
}
