// ---------------------------------------------------------------------------
// Language Normalization Helpers
//
// Used by the batch edit endpoint to:
//   1. Parse number words to integers (English + Spanish)
//   2. Detect vague/ambiguous quantities that require clarification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Number word → integer tables
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  // Spanish
  cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciséis: 16, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
};

// Vague quantities that cannot be resolved without clarification
const VAGUE_QUANTITY_WORDS = new Set([
  // English
  "some", "many", "few", "several", "multiple", "various", "lots", "bunch",
  // Spanish
  "unos", "varios", "varias", "muchos", "muchas", "pocos", "pocas", "bastantes",
  "unas", "alguno", "alguna", "algunos", "algunas",
]);

// "a couple" → 2 (exact enough to apply)
const EXACT_PHRASES: Array<{ pattern: RegExp; value: number }> = [
  { pattern: /\ba couple(\s+of)?\b/i, value: 2 },
  { pattern: /\bun par\b/i, value: 2 },
  { pattern: /\ba dozen\b/i, value: 12 },
  { pattern: /\buna docena\b/i, value: 12 },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParsedQuantity {
  /** The resolved integer value, or null if ambiguous/unknown */
  value: number | null;
  /** Set when the word is recognized but maps to an ambiguous range */
  ambiguous: boolean;
  /** User-readable clarification question (set when ambiguous=true or value=null) */
  clarification: string | null;
}

/**
 * Attempt to parse a token (digit string or number word) to an integer.
 * Returns clarification instructions when the quantity is vague or unknown.
 */
export function parseQuantity(token: string): ParsedQuantity {
  const t = token.trim().toLowerCase();

  // Pure digit
  if (/^\d+$/.test(t)) {
    return { value: parseInt(t, 10), ambiguous: false, clarification: null };
  }

  // Exact phrases first (highest confidence)
  for (const { pattern, value } of EXACT_PHRASES) {
    if (pattern.test(t)) {
      return { value, ambiguous: false, clarification: null };
    }
  }

  // Vague words → clarification required
  if (VAGUE_QUANTITY_WORDS.has(t)) {
    return {
      value: null,
      ambiguous: true,
      clarification: `"${token}" is ambiguous. Please specify an exact number (e.g. "eran 3 jeans").`,
    };
  }

  // Number words
  if (t in NUMBER_WORDS) {
    return { value: NUMBER_WORDS[t], ambiguous: false, clarification: null };
  }

  // Unknown token
  return {
    value: null,
    ambiguous: false,
    clarification: `Could not understand quantity "${token}". Please use a number (e.g. 3) or a number word (e.g. "tres").`,
  };
}

// ---------------------------------------------------------------------------
// Edit message parser
// Supports digit or word quantities in all recognized patterns.
// ---------------------------------------------------------------------------

export type EditAction = "set" | "add" | "subtract";

export interface ParsedEditMessage {
  action: EditAction;
  quantity: number;
  productHint: string;
}

export interface ParseEditResult {
  parsed: ParsedEditMessage | null;
  /** When set, the caller should return this to the user without applying changes */
  clarification: string | null;
}

// Flexible token: digit string OR word
const QTY_TOKEN = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")}|a couple(?: of)?|un par)`;

const EDIT_PATTERNS: Array<{ re: RegExp; action: EditAction }> = [
  // set / eran / son
  { re: new RegExp(`^(?:eran|son|set|actualizar a|cambiar a)\\s+${QTY_TOKEN}\\s+(.+)$`, "i"), action: "set" },
  // add / agregar
  { re: new RegExp(`^(?:agregar?|a[ñn]adir|add|sumar|más|mas)\\s+${QTY_TOKEN}\\s+(.+)$`, "i"), action: "add" },
  // subtract / quitar
  { re: new RegExp(`^(?:quitar?|remover?|remove|subtract|restar|menos)\\s+${QTY_TOKEN}\\s+(.+)$`, "i"), action: "subtract" },
];

/**
 * Parse a natural-language edit message into a structured edit instruction.
 *
 * If the message contains a vague quantity or unrecognized structure,
 * returns `{ parsed: null, clarification: "..." }` — the caller MUST surface
 * the clarification to the user and NOT apply any changes.
 */
export function parseEditMessage(message: string): ParseEditResult {
  const msg = message.trim();

  // Check for vague quantity words anywhere in the message (early exit)
  const words = msg.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (VAGUE_QUANTITY_WORDS.has(word)) {
      return {
        parsed: null,
        clarification: `"${word}" is too vague. Please specify an exact number — for example: "eran 3 jeans" or "agregar 2 remeras".`,
      };
    }
  }

  for (const { re, action } of EDIT_PATTERNS) {
    const m = msg.match(re);
    if (!m) continue;

    const qtyToken = m[1];
    // product hint is the last capture group (skip "of" in "a couple of")
    const productHint = m[m.length - 1].toLowerCase().trim();

    const qty = parseQuantity(qtyToken);
    if (qty.clarification || qty.value === null) {
      return { parsed: null, clarification: qty.clarification ?? `Could not parse quantity "${qtyToken}".` };
    }
    if (qty.value < 0) {
      return { parsed: null, clarification: "Quantity cannot be negative." };
    }

    return { parsed: { action, quantity: qty.value, productHint }, clarification: null };
  }

  return {
    parsed: null,
    clarification:
      'Edit command not recognized. Try: "eran 3 jeans", "agregar 2 remeras", or "quitar 1 jeans".',
  };
}
