// ---------------------------------------------------------------------------
// IoT / Device Adapter
//
// Handles sensor alerts, device status changes, threshold violations, and
// equipment fault events.  These often have operational or safety implications
// that map naturally into Lumetra's escalation model.
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

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(str(v));
  return isNaN(n) ? null : n;
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
// Event template table
// ---------------------------------------------------------------------------

type IoTTemplate = {
  build(p: Record<string, unknown>): string;
  severity: NormalizedEvent["metadata"]["severity"];
};

const TEMPLATES: Record<string, IoTTemplate> = {
  "sensor.alert": {
    build: (p) => {
      const device = str(p.device_id ?? p.sensor_id ?? p.device_name ?? "unknown device");
      const metric = str(p.metric ?? p.sensor_type ?? "reading");
      const value = num(p.value ?? p.reading);
      const threshold = num(p.threshold ?? p.limit);
      const unit = str(p.unit ?? "");
      const location = str(p.location ?? p.zone ?? "");
      return [
        `Sensor alert from device ${device}${location ? ` at ${location}` : ""}.`,
        `${metric.charAt(0).toUpperCase() + metric.slice(1)} ${value !== null ? `reading: ${value}${unit}` : "out of range"}`,
        threshold !== null ? `(threshold: ${threshold}${unit}).` : ".",
        "Operational issue requiring immediate attention.",
      ].filter(Boolean).join(" ");
    },
    severity: "high",
  },

  "temperature.exceeded": {
    build: (p) => {
      const device = str(p.device_id ?? p.sensor_id ?? "sensor");
      const temp = num(p.temperature ?? p.value);
      const max = num(p.max_temperature ?? p.threshold);
      const location = str(p.location ?? "");
      return `Temperature threshold exceeded on ${device}${location ? ` in ${location}` : ""}. ${temp !== null ? `Current: ${temp}°` : ""}${max !== null ? `, limit: ${max}°` : ""}. Equipment damage or safety risk — urgent inspection required.`;
    },
    severity: "critical",
  },

  "pressure.exceeded": {
    build: (p) => {
      const device = str(p.device_id ?? "sensor");
      const val = num(p.pressure ?? p.value);
      const max = num(p.threshold ?? p.max_pressure);
      const unit = str(p.unit ?? "psi");
      return `Pressure threshold exceeded on ${device}. ${val !== null ? `Current: ${val} ${unit}` : ""}${max !== null ? `, limit: ${max} ${unit}` : ""}. Risk of equipment failure — immediate action required.`;
    },
    severity: "critical",
  },

  "device.offline": {
    build: (p) => {
      const device = str(p.device_id ?? p.device_name ?? "device");
      const location = str(p.location ?? p.zone ?? "");
      const since = str(p.last_seen ?? p.offline_since ?? "");
      return `Device offline: ${device}${location ? ` at ${location}` : ""}${since ? `, last seen ${since}` : ""}. Connectivity issue — check network or hardware. Operations may be affected.`;
    },
    severity: "medium",
  },

  "alarm.triggered": {
    build: (p) => {
      const type = str(p.alarm_type ?? p.type ?? "alarm");
      const device = str(p.device_id ?? p.sensor_id ?? "");
      const location = str(p.location ?? p.zone ?? "");
      const desc = str(p.description ?? p.message ?? "");
      return `${type.charAt(0).toUpperCase() + type.slice(1)} alarm triggered${device ? ` by ${device}` : ""}${location ? ` at ${location}` : ""}. ${desc || "Immediate investigation required."} This may be a security or safety incident.`;
    },
    severity: "critical",
  },

  "threshold.exceeded": {
    build: (p) => {
      const metric = str(p.metric ?? p.sensor_type ?? p.parameter ?? "metric");
      const device = str(p.device_id ?? "sensor");
      const value = num(p.value ?? p.current);
      const threshold = num(p.threshold ?? p.limit);
      const unit = str(p.unit ?? "");
      return `${metric} threshold exceeded on ${device}. ${value !== null ? `Value: ${value}${unit}` : ""}${threshold !== null ? `, limit: ${threshold}${unit}` : ""}. Operational limit breach — review and corrective action required.`;
    },
    severity: "high",
  },

  "motion.detected": {
    build: (p) => {
      const device = str(p.device_id ?? p.camera_id ?? "motion sensor");
      const location = str(p.location ?? p.zone ?? "");
      const time = str(p.detected_at ?? p.timestamp ?? "");
      return `Motion detected by ${device}${location ? ` at ${location}` : ""}${time ? ` at ${time}` : ""}. Potential unauthorized access — security review required.`;
    },
    severity: "high",
  },

  "battery.low": {
    build: (p) => {
      const device = str(p.device_id ?? p.device_name ?? "device");
      const level = num(p.battery_level ?? p.level ?? p.percentage);
      return `Low battery on ${device}${level !== null ? ` (${level}%)` : ""}. Device may go offline soon — replacement or charge required.`;
    },
    severity: "low",
  },

  "equipment.fault": {
    build: (p) => {
      const device = str(p.device_id ?? p.equipment_id ?? p.machine_id ?? "equipment");
      const code = str(p.fault_code ?? p.error_code ?? p.code ?? "");
      const desc = str(p.description ?? p.message ?? p.fault_description ?? "");
      return `Equipment fault on ${device}${code ? ` (code: ${code})` : ""}. ${desc || "Hardware failure detected."} Maintenance required immediately.`;
    },
    severity: "high",
  },

  "machine.error": {
    build: (p) => {
      const machine = str(p.machine_id ?? p.device_id ?? "machine");
      const error = str(p.error ?? p.error_code ?? p.message ?? "Error");
      const desc = str(p.description ?? "");
      return `Machine error on ${machine}. Error: ${error}. ${desc} Operational downtime may occur — maintenance team required.`;
    },
    severity: "high",
  },

  "maintenance.required": {
    build: (p) => {
      const device = str(p.device_id ?? p.equipment_id ?? "equipment");
      const reason = str(p.reason ?? p.maintenance_type ?? "scheduled maintenance");
      return `Maintenance required for ${device}. Reason: ${reason}. Schedule maintenance to prevent failure.`;
    },
    severity: "low",
  },
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const iotAdapter: IntegrationAdapter = {
  system: "iot" as SystemType,
  providers: ["mqtt", "aws_iot", "azure_iot", "generic"],
  eventTypes: Object.keys(TEMPLATES),

  supports(event: RawSystemEvent): boolean {
    return event.system === "iot";
  },

  normalize(event: RawSystemEvent): NormalizedEvent {
    const p = event.payload;
    const template = TEMPLATES[event.event_type];

    if (template) {
      return {
        text: template.build(p),
        source: "api",
        metadata: meta(event, template.severity, {
          device_id: str(p.device_id ?? p.sensor_id ?? ""),
          location: str(p.location ?? p.zone ?? ""),
        }),
      };
    }

    // Generic IoT fallback
    const device = str(p.device_id ?? p.sensor_id ?? p.device_name ?? "unknown device");
    const message = str(p.message ?? p.description ?? p.alert ?? "Alert triggered.");
    return {
      text: `IoT event "${event.event_type}" from device ${device}. ${message} Operational review required.`,
      source: "api",
      metadata: meta(event, "medium", { device_id: device }),
    };
  },
};
