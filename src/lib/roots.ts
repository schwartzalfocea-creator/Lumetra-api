import rootsData from "../data/roots.json" with { type: "json" };

export type Lang = "en" | "es" | "pt" | "fr";

export interface RootEntry {
  meaning: string;
  keywords: Record<Lang, string[]>;
}

export interface ModeEntry extends RootEntry {
  label: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  department: string;
}

interface RootsShape {
  modes: Record<string, ModeEntry>;
  modifiers: Record<string, RootEntry>;
  time: Record<string, RootEntry>;
  objects: Record<string, string>;
  subjects: Record<string, RootEntry>;
  states: Record<string, RootEntry>;
  vectors: Record<string, RootEntry>;
  intents: Record<string, RootEntry>;
  finance: Record<string, RootEntry>;
  contract: Record<string, RootEntry>;
  logistics: Record<string, RootEntry>;
  data: Record<string, RootEntry>;
  security: Record<string, RootEntry>;
  health: Record<string, RootEntry>;
  /** Legal roots — maps to the Legal department. */
  legal: Record<string, RootEntry>;
  actions: Record<string, RootEntry>;
}

export const ROOTS: RootsShape = rootsData as unknown as RootsShape;

export const ALL_CATEGORIES = [
  "subjects",
  "states",
  "vectors",
  "intents",
  "finance",
  "contract",
  "logistics",
  "data",
  "security",
  "health",
  "legal",
  "actions",
] as const;

export type RootCategory = (typeof ALL_CATEGORIES)[number];
