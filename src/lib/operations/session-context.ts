// ---------------------------------------------------------------------------
// Short-Term Session Context
//
// Tracks per-session state for the edit endpoint so the system can resolve
// contextual product references ("add 2 more", "quitar 1 mismo") and
// switch users to guided mode after repeated failures.
//
// Storage: in-memory Map — no DB involved (context is ephemeral by design).
// Sessions expire after SESSION_TTL_MS of inactivity.
// ---------------------------------------------------------------------------

export interface SessionContext {
  /** SKU or lower-cased product name from the last SUCCESSFUL edit */
  lastProductHint: string | null;
  /** Display name of the last product for clarity messages */
  lastProductName: string | null;
  /** Batch the last product reference was applied to */
  lastBatchId: string | null;
  /** Consecutive failed edit attempts in this session */
  failureCount: number;
  /** Unix-ms timestamp of last activity */
  lastActivity: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map<string, SessionContext>();

function fresh(): SessionContext {
  return {
    lastProductHint: null,
    lastProductName: null,
    lastBatchId: null,
    failureCount: 0,
    lastActivity: Date.now(),
  };
}

function touch(ctx: SessionContext): SessionContext {
  ctx.lastActivity = Date.now();
  return ctx;
}

/** Retrieve (or create) context for a session ID. */
export function getContext(sessionId: string): SessionContext {
  const ctx = store.get(sessionId);
  if (!ctx || Date.now() - ctx.lastActivity > SESSION_TTL_MS) {
    const next = fresh();
    store.set(sessionId, next);
    return next;
  }
  return touch(ctx);
}

/** Record a successful edit; resets failure counter and saves product reference. */
export function recordSuccess(
  sessionId: string,
  batchId: string,
  productHint: string,
  productName?: string,
): void {
  const ctx = getContext(sessionId);
  ctx.lastProductHint = productHint;
  ctx.lastProductName = productName ?? productHint;
  ctx.lastBatchId = batchId;
  ctx.failureCount = 0;
}

/** Record a failed edit attempt; increments the failure counter. */
export function recordFailure(sessionId: string): void {
  const ctx = getContext(sessionId);
  ctx.failureCount += 1;
}

/** Reset failure counter (e.g. after a successful non-edit action). */
export function resetFailures(sessionId: string): void {
  const ctx = getContext(sessionId);
  ctx.failureCount = 0;
}

// ---------------------------------------------------------------------------
// Words that mean "the same product as last time"
// ---------------------------------------------------------------------------

const CONTEXT_WORDS = new Set([
  // English
  "more", "same", "it", "that", "those", "them",
  // Spanish
  "más", "mas", "mismo", "misma", "eso", "ese", "esa", "ellos", "esas",
  "lo mismo", "el mismo", "la misma",
]);

/**
 * Returns true if the entire productHint is a reference to context
 * (e.g. "more", "más", "mismo") rather than a real product identifier.
 */
export function isContextWord(hint: string): boolean {
  return CONTEXT_WORDS.has(hint.trim().toLowerCase());
}

/**
 * Strip a leading context word from a compound hint like "más jeans" → "jeans".
 * Returns the stripped hint if a context prefix is found, otherwise the original.
 */
export function stripContextPrefix(hint: string): string {
  const lower = hint.toLowerCase().trim();
  for (const word of CONTEXT_WORDS) {
    if (lower.startsWith(word + " ")) {
      return hint.slice(word.length).trim();
    }
  }
  return hint;
}

// ---------------------------------------------------------------------------
// Stale session cleanup — runs every 5 minutes
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [id, ctx] of store) {
    if (now - ctx.lastActivity > SESSION_TTL_MS) {
      store.delete(id);
    }
  }
}, 5 * 60 * 1000).unref(); // .unref() so the timer doesn't keep the process alive
