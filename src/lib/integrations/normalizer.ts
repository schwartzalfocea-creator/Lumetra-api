// ---------------------------------------------------------------------------
// Integration Normalizer — dispatcher
//
// Receives a RawSystemEvent, selects the correct adapter, and returns a
// NormalizedEvent ready for processIntake().
// ---------------------------------------------------------------------------

import { posAdapter } from "./adapters/pos";
import { databaseAdapter } from "./adapters/database";
import { apiAdapter } from "./adapters/api";
import { iotAdapter } from "./adapters/iot";
import { erpAdapter } from "./adapters/erp";
import type { IntegrationAdapter, RawSystemEvent, NormalizedEvent } from "./types";

const ADAPTERS: IntegrationAdapter[] = [
  posAdapter,
  databaseAdapter,
  apiAdapter,
  iotAdapter,
  erpAdapter,
];

export class UnsupportedSystemError extends Error {
  constructor(system: string) {
    super(`No adapter registered for system "${system}"`);
    this.name = "UnsupportedSystemError";
  }
}

/**
 * Normalize a raw system event into Lumetra intake format.
 * Throws UnsupportedSystemError if no adapter matches.
 */
export function normalizeEvent(event: RawSystemEvent): NormalizedEvent {
  const adapter = ADAPTERS.find((a) => a.supports(event));
  if (!adapter) throw new UnsupportedSystemError(event.system);
  return adapter.normalize(event);
}

/**
 * Discovery: return the list of supported systems with provider and event-type
 * information, suitable for the GET /api/integrations response.
 */
export function listSupportedSystems(): Array<{
  system: string;
  providers: string[];
  event_types: string[];
}> {
  return ADAPTERS.map((a) => ({
    system: a.system,
    providers: a.providers,
    event_types: a.eventTypes,
  }));
}
