import { ROOTS, type Lang, type RootEntry, type ModeEntry } from "./roots";
import { detectLanguage } from "./language";

export interface ParsedHit {
  root: string;
  category: string;
  meaning: string;
  matched: string;
}

export interface ParseResult {
  language: Lang;
  mode: string;
  modeEntry: ModeEntry;
  subject: string;
  vectors: string[];
  states: string[];
  objects: string[];
  modifiers: string[];
  time: string;
  hits: ParsedHit[];
  rootsHit: string[];
  semanticCode: string;
  rawTokens: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKeyword(text: string, keywords: string[]): string | null {
  // text is normalised to lowercase and padded with spaces on both ends.
  for (const kw of keywords) {
    const needle = kw.toLowerCase();
    if (needle.length === 0) continue;
    // Multi-word keywords (contain a space) match as substrings — they are
    // already specific enough not to false-positive.
    if (needle.includes(" ")) {
      if (text.includes(needle)) return kw;
      continue;
    }
    // Single-word keywords require word boundaries (any non-letter on each
    // side, including the leading/trailing spaces we padded with). This is
    // unicode-aware so accented characters in es/pt/fr count as letters.
    const re = new RegExp(`(^|[^\\p{L}])${escapeRegex(needle)}([^\\p{L}]|$)`, "u");
    if (re.test(text)) return kw;
  }
  return null;
}

function scanCategory(
  text: string,
  lang: Lang,
  category: string,
  bucket: Record<string, RootEntry>,
  hits: ParsedHit[],
): string[] {
  const matched: string[] = [];
  for (const [root, entry] of Object.entries(bucket)) {
    const keywords = [
      ...(entry.keywords[lang] ?? []),
      ...(lang !== "en" ? entry.keywords.en ?? [] : []),
    ];
    const hit = findKeyword(text, keywords);
    if (hit) {
      matched.push(root);
      hits.push({ root, category, meaning: entry.meaning, matched: hit });
    }
  }
  return matched;
}

function chooseMode(
  text: string,
  lang: Lang,
  hits: ParsedHit[],
): { code: string; entry: ModeEntry } {
  // Priority order: MAI! > SEC: > MED: > LEG: > YU: > OP: > TEK: > KO? > SO:
  const priorityOrder = ["MAI!", "SEC:", "MED:", "LEG:", "YU:", "OP:", "TEK:", "KO?", "SO:"];
  let chosenCode = "KO?";

  for (const code of priorityOrder) {
    const entry = ROOTS.modes[code];
    if (!entry) continue;
    const keywords = [
      ...(entry.keywords[lang] ?? []),
      ...(lang !== "en" ? entry.keywords.en ?? [] : []),
    ];
    const hit = findKeyword(text, keywords);
    if (hit) {
      chosenCode = code;
      hits.push({ root: code, category: "mode", meaning: entry.label, matched: hit });
      break;
    }
  }

  return { code: chosenCode, entry: ROOTS.modes[chosenCode]! };
}

export function parseInput(rawText: string): ParseResult {
  const text = ` ${rawText.toLowerCase()} `;
  const lang = detectLanguage(rawText);
  const hits: ParsedHit[] = [];

  const { code: mode, entry: modeEntry } = chooseMode(text, lang, hits);

  const subjects = scanCategory(text, lang, "subjects", ROOTS.subjects, hits);
  const vectors = scanCategory(text, lang, "vectors", ROOTS.vectors, hits);
  const states = scanCategory(text, lang, "states", ROOTS.states, hits);
  const intents = scanCategory(text, lang, "intents", ROOTS.intents, hits);
  const finance = scanCategory(text, lang, "finance", ROOTS.finance, hits);
  const contract = scanCategory(text, lang, "contract", ROOTS.contract, hits);
  const logistics = scanCategory(text, lang, "logistics", ROOTS.logistics, hits);
  const data = scanCategory(text, lang, "data", ROOTS.data, hits);
  const security = scanCategory(text, lang, "security", ROOTS.security, hits);
  const health = scanCategory(text, lang, "health", ROOTS.health, hits);
  const legal = scanCategory(text, lang, "legal", ROOTS.legal, hits);
  const actions = scanCategory(text, lang, "actions", ROOTS.actions, hits);
  const modifiers = scanCategory(text, lang, "modifiers", ROOTS.modifiers, hits);
  const time = scanCategory(text, lang, "time", ROOTS.time, hits);

  const subject = subjects[0] ?? "MI";
  const timeRoot = time[0] ?? "PRES";

  // Pick most relevant object roots based on mode
  const objects: string[] = [];
  if (mode === "YU:") objects.push(...finance);
  if (mode === "OP:") objects.push(...logistics, ...contract);
  if (mode === "SEC:") objects.push(...security, ...data);
  if (mode === "TEK:") objects.push(...data);
  if (mode === "MED:") objects.push(...health);
  if (mode === "LEG:") objects.push(...legal);

  // Always include cross-cutting hits regardless of mode
  if (security.length > 0 && !objects.some((o) => security.includes(o))) {
    objects.push(...security);
  }
  if (finance.length > 0 && !objects.some((o) => finance.includes(o))) {
    objects.push(...finance);
  }
  if (logistics.length > 0 && !objects.some((o) => logistics.includes(o))) {
    objects.push(...logistics);
  }
  if (contract.length > 0 && !objects.some((o) => contract.includes(o))) {
    objects.push(...contract);
  }
  if (data.length > 0 && !objects.some((o) => data.includes(o))) {
    objects.push(...data);
  }
  if (health.length > 0 && !objects.some((o) => health.includes(o))) {
    objects.push(...health);
  }
  if (legal.length > 0 && !objects.some((o) => legal.includes(o))) {
    objects.push(...legal);
  }
  if (actions.length > 0) objects.push(...actions);

  // Build the semantic code: [MODE] [NAMESPACE]: [SUBJECT] [VECTOR] [OBJECT+MOD] [TIME]
  const parts: string[] = [mode];
  parts.push(subject);

  if (vectors.length > 0) parts.push(vectors[0]!);
  else if (states.includes("NIL")) parts.push("VEN");

  // Object cluster with object-type suffix
  if (objects.length > 0) {
    const head = objects[0]!;
    let suffix = "";
    if (logistics.includes(head) || contract.includes(head)) suffix = "_P";
    else if (data.includes(head) || finance.includes(head) || security.includes(head)) suffix = "_G";
    parts.push(`${head}${suffix}`);
    if (objects[1]) {
      const second = objects[1]!;
      let s2 = "";
      if (logistics.includes(second) || contract.includes(second)) s2 = "_P";
      else if (data.includes(second) || finance.includes(second) || security.includes(second)) s2 = "_G";
      parts.push(`${second}${s2}`);
    }
  }

  if (states.length > 0 && !states.includes("ES")) {
    parts.push(states[0]!);
  }
  if (modifiers.length > 0) {
    parts.push(modifiers[0]!);
  }
  parts.push(timeRoot);

  // Final semantic code formatted with namespace separator
  const head = parts.shift()!;
  const semanticCode = `${head} ${parts.join(" ")}`.trim();

  const rootsHit = Array.from(new Set(hits.map((h) => h.root)));

  return {
    language: lang,
    mode,
    modeEntry,
    subject,
    vectors,
    states,
    objects,
    modifiers,
    time: timeRoot,
    hits,
    rootsHit,
    semanticCode,
    rawTokens: rawText.toLowerCase().split(/\s+/).filter(Boolean),
  };
}
