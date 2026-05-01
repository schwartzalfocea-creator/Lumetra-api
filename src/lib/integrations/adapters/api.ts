// ---------------------------------------------------------------------------
// API / Third-Party Adapter
//
// Supports named providers: Zendesk, HubSpot, Salesforce, Jira, GitHub, plus
// a generic fallback for any REST API or webhook payload.
//
// All normalization is deterministic — no AI.
// ---------------------------------------------------------------------------

import type {
  IntegrationAdapter,
  RawSystemEvent,
  NormalizedEvent,
  SystemType,
} from "../types";

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function extractContact(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): Pick<NormalizedEvent, "to_email" | "to_phone" | "from_name"> {
  return {
    to_email:
      event.customer_email ??
      (str(
        p.requester_email ??
          p.email ??
          p.contact_email ??
          p.customer_email ??
          p.from_email ??
          "",
      ) || undefined),
    to_phone:
      event.customer_phone ??
      (str(p.phone ?? p.mobile ?? p.customer_phone ?? "") || undefined),
    from_name:
      event.customer_name ??
      (str(
        p.requester_name ??
          p.contact_name ??
          p.name ??
          p.full_name ??
          p.first_name ??
          "",
      ) || undefined),
  };
}

function meta(
  event: RawSystemEvent,
  severity: NormalizedEvent["metadata"]["severity"],
  extra?: Record<string, unknown>,
): NormalizedEvent["metadata"] {
  return {
    system: event.system,
    provider: event.provider,
    event_type: event.event_type,
    source_id: event.source_id,
    occurred_at: event.occurred_at ?? new Date().toISOString(),
    severity,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Zendesk
// ---------------------------------------------------------------------------

function zendesk(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const ticket = (p.ticket ?? p) as Record<string, unknown>;
  const id = str(ticket.id ?? "");
  const subject = str(ticket.subject ?? ticket.title ?? "");
  const desc = str(ticket.description ?? ticket.latest_comment ?? "");
  const priority = str(ticket.priority ?? "normal").toLowerCase();
  const status = str(ticket.status ?? "open").toLowerCase();
  const contact = extractContact(event, ticket);

  const severityMap: Record<string, NormalizedEvent["metadata"]["severity"]> = {
    urgent: "critical",
    high: "high",
    normal: "medium",
    low: "low",
  };
  const severity = severityMap[priority] ?? "medium";

  const et = event.event_type;

  if (et === "ticket.created") {
    return {
      text: `New Zendesk support ticket created${id ? ` #${id}` : ""}. Subject: ${subject || "No subject"}. ${desc ? desc.slice(0, 300) : ""} Priority: ${priority}.`,
      source: "api",
      ...contact,
      metadata: meta(event, severity, { ticket_id: id, status, priority }),
    };
  }

  if (et === "ticket.updated") {
    return {
      text: `Zendesk ticket updated${id ? ` #${id}` : ""}. Subject: ${subject || "Unknown"}. Status: ${status}. ${desc ? desc.slice(0, 200) : ""}`,
      source: "api",
      ...contact,
      metadata: meta(event, severity, { ticket_id: id, status }),
    };
  }

  if (et === "ticket.escalated" || priority === "urgent") {
    return {
      text: `URGENT Zendesk ticket escalated${id ? ` #${id}` : ""}. Subject: ${subject || "Unknown"}. ${desc ? desc.slice(0, 300) : ""} Immediate human review required.`,
      source: "api",
      ...contact,
      metadata: meta(event, "critical", { ticket_id: id }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

function hubspot(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const et = event.event_type;
  const props = (p.properties ?? p) as Record<string, unknown>;
  const contact = extractContact(event, props);
  const id = str(p.objectId ?? p.id ?? "");

  if (et === "contact.created" || et === "contact.propertyChange") {
    const name = str(props.firstname ?? "") + " " + str(props.lastname ?? "");
    const email = str(props.email ?? "");
    return {
      text: `New HubSpot contact created${name.trim() ? `: ${name.trim()}` : ""}${email ? ` (${email})` : ""}. Customer record added to CRM for onboarding and support.`,
      source: "api",
      to_email: contact.to_email ?? (email || undefined),
      from_name: contact.from_name ?? (name.trim() || undefined),
      to_phone: contact.to_phone,
      metadata: meta(event, "low", { contact_id: id }),
    };
  }

  if (et === "deal.stageChange" || et === "deal.created") {
    const dealName = str(props.dealname ?? props.name ?? "");
    const stage = str(props.dealstage ?? props.stage ?? "");
    const amount = str(props.amount ?? "");
    return {
      text: `HubSpot deal updated${dealName ? `: ${dealName}` : ""}${stage ? `. Stage: ${stage}` : ""}${amount ? `. Value: $${amount}` : ""}. CRM deal record change requires follow-up.`,
      source: "api",
      ...contact,
      metadata: meta(event, "medium", { deal_id: id, stage }),
    };
  }

  if (et === "complaint.created" || et === "ticket.created") {
    const subject = str(props.subject ?? props.content ?? "");
    const priority = str(props.hs_ticket_priority ?? "MEDIUM").toLowerCase();
    return {
      text: `HubSpot complaint ticket created${id ? ` #${id}` : ""}. ${subject || "Customer issue reported."} Priority: ${priority}. Immediate follow-up required.`,
      source: "api",
      ...contact,
      metadata: meta(event, priority === "high" ? "high" : "medium", { ticket_id: id }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

function salesforce(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const et = event.event_type;
  const record = (p.sobject ?? p.record ?? p) as Record<string, unknown>;
  const id = str(record.Id ?? record.id ?? "");
  const contact = extractContact(event, record);

  if (et === "Case.created" || et === "Case.updated") {
    const subject = str(record.Subject ?? record.subject ?? "");
    const desc = str(record.Description ?? record.description ?? "");
    const priority = str(record.Priority ?? record.priority ?? "Medium");
    const status = str(record.Status ?? record.status ?? "Open");
    const severity: NormalizedEvent["metadata"]["severity"] =
      priority.toLowerCase() === "high" ? "high" :
      priority.toLowerCase() === "critical" ? "critical" : "medium";

    return {
      text: `Salesforce Case ${et.split(".")[1]}${id ? ` #${id}` : ""}. Subject: ${subject || "Unspecified"}. ${desc ? desc.slice(0, 300) : ""} Status: ${status}. Priority: ${priority}.`,
      source: "api",
      ...contact,
      metadata: meta(event, severity, { case_id: id, status, priority }),
    };
  }

  if (et === "Case.escalated") {
    const subject = str(record.Subject ?? "");
    return {
      text: `Salesforce Case escalated${id ? ` #${id}` : ""}. ${subject || "Customer issue escalated."} Urgent human review and callback required.`,
      source: "api",
      ...contact,
      metadata: meta(event, "critical", { case_id: id }),
    };
  }

  if (et === "Opportunity.closed" || et === "Opportunity.won") {
    return {
      text: `Salesforce Opportunity closed${id ? ` #${id}` : ""}${record.Name ? ` (${record.Name})` : ""}. Contract and billing follow-up required.`,
      source: "api",
      ...contact,
      metadata: meta(event, "low", { opportunity_id: id }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

function jira(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const issue = (p.issue ?? p) as Record<string, unknown>;
  const fields = (issue.fields ?? issue) as Record<string, unknown>;
  const key = str(issue.key ?? "");
  const summary = str(fields.summary ?? "");
  const desc = str(
    ((fields.description as Record<string, unknown>)?.content as unknown[] | undefined)?.[0] ??
      fields.description ??
      "",
  );
  const priority = str(
    (fields.priority as Record<string, unknown>)?.name ?? fields.priority ?? "Medium",
  );
  const status = str(
    (fields.status as Record<string, unknown>)?.name ?? fields.status ?? "Open",
  );
  const contact = extractContact(event, fields);

  const et = event.event_type;
  const severity: NormalizedEvent["metadata"]["severity"] =
    priority.toLowerCase() === "highest" || priority.toLowerCase() === "critical"
      ? "critical"
      : priority.toLowerCase() === "high" ? "high" : "medium";

  if (et === "issue.created") {
    return {
      text: `Jira issue created${key ? ` ${key}` : ""}. Summary: ${summary || "No summary"}. ${typeof desc === "string" ? desc.slice(0, 200) : ""} Priority: ${priority}.`,
      source: "api",
      ...contact,
      metadata: meta(event, severity, { issue_key: key, priority, status }),
    };
  }

  if (et === "issue.priority_changed" || priority.toLowerCase() === "highest") {
    return {
      text: `Jira issue priority escalated to ${priority}${key ? ` (${key})` : ""}. Summary: ${summary || "Unknown issue"}. Immediate attention required.`,
      source: "api",
      ...contact,
      metadata: meta(event, "critical", { issue_key: key }),
    };
  }

  if (et === "issue.updated") {
    return {
      text: `Jira issue updated${key ? ` ${key}` : ""}. ${summary || "No summary"}. Status: ${status}. Priority: ${priority}.`,
      source: "api",
      ...contact,
      metadata: meta(event, severity, { issue_key: key, status }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function github(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent | null {
  const issue = (p.issue ?? p) as Record<string, unknown>;
  const number = str(issue.number ?? "");
  const title = str(issue.title ?? "");
  const body = str(issue.body ?? "");
  const labels = Array.isArray(issue.labels)
    ? (issue.labels as Array<Record<string, unknown>>).map((l) => str(l.name ?? "")).join(", ")
    : "";
  const contact = extractContact(event, p);
  const repo = str((p.repository as Record<string, unknown>)?.full_name ?? "");

  const isBug = labels.toLowerCase().includes("bug");
  const isUrgent = labels.toLowerCase().includes("urgent") || labels.toLowerCase().includes("critical");

  const et = event.event_type;

  if (et === "issue.created" || et === "issues.opened") {
    return {
      text: `GitHub issue opened${number ? ` #${number}` : ""}${repo ? ` in ${repo}` : ""}. Title: ${title || "No title"}. ${body ? body.slice(0, 300) : ""}${labels ? ` Labels: ${labels}.` : ""}${isBug ? " Bug report requiring attention." : ""}`,
      source: "api",
      ...contact,
      metadata: meta(event, isUrgent ? "high" : isBug ? "medium" : "low", {
        issue_number: number,
        labels,
        repo,
      }),
    };
  }

  if (et === "issue.labeled" || et === "issues.labeled") {
    return {
      text: `GitHub issue labeled${number ? ` #${number}` : ""}. Title: ${title}. Label added: ${labels}${isUrgent ? " — urgent escalation required." : "."}`,
      source: "api",
      ...contact,
      metadata: meta(event, isUrgent ? "high" : "low", { issue_number: number, labels }),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Generic API fallback
// ---------------------------------------------------------------------------

function genericApi(
  event: RawSystemEvent,
  p: Record<string, unknown>,
): NormalizedEvent {
  const contact = extractContact(event, p);

  // Try to find the most meaningful text field
  const textFields = [
    "message", "description", "body", "content",
    "subject", "title", "text", "summary", "note",
    "detail", "details", "reason", "comment",
  ];

  const extracted = textFields.map((f) => str(p[f])).find((v) => v.length > 5) ?? "";

  const contextFields = [
    p.id ? `ID: ${p.id}` : "",
    p.status ? `Status: ${p.status}` : "",
    p.priority ? `Priority: ${p.priority}` : "",
    p.amount ? `Amount: $${p.amount}` : "",
    p.type ? `Type: ${p.type}` : "",
  ].filter(Boolean).join(". ");

  const text = [
    `API event "${event.event_type}"`,
    event.provider ? `from ${event.provider}` : "",
    extracted || contextFields || "Event received requiring triage.",
  ]
    .filter(Boolean)
    .join(". ");

  return {
    text: text.slice(0, 1500),
    source: "api",
    ...contact,
    metadata: meta(event, "medium"),
  };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const PROVIDER_HANDLERS: Record<
  string,
  (event: RawSystemEvent, p: Record<string, unknown>) => NormalizedEvent | null
> = {
  zendesk,
  hubspot,
  salesforce,
  jira,
  github,
};

export const apiAdapter: IntegrationAdapter = {
  system: "api" as SystemType,
  providers: ["zendesk", "hubspot", "salesforce", "jira", "github", "generic"],
  eventTypes: [
    "ticket.created", "ticket.updated", "ticket.escalated",
    "contact.created", "contact.propertyChange",
    "deal.created", "deal.stageChange",
    "complaint.created",
    "Case.created", "Case.updated", "Case.escalated", "Opportunity.closed", "Opportunity.won",
    "issue.created", "issue.updated", "issue.priority_changed", "issue.labeled",
    "issues.opened", "issues.labeled",
    "generic",
  ],

  supports(event: RawSystemEvent): boolean {
    return event.system === "api" || event.system === "crm";
  },

  normalize(event: RawSystemEvent): NormalizedEvent {
    const p = event.payload;
    const provider = (event.provider ?? "generic").toLowerCase();

    const handler = PROVIDER_HANDLERS[provider];
    if (handler) {
      const result = handler(event, p);
      if (result) return result;
    }

    return genericApi(event, p);
  },
};
