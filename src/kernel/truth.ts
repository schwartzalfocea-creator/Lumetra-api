// 🧠 LUMETRA TRUTH ENGINE

export type TruthInput = {
  intent: string;
  userRole: string;
  stock?: number;
};

export type TruthResult = {
  execute: boolean;
  reason?: string;
};

export function evaluateTruth(input: TruthInput): TruthResult {
  const { intent, userRole, stock } = input;

  // 1. INTENCIÓN válida
  if (!intent || intent === "UNKNOWN") {
    return { execute: false, reason: "NO_INTENT" };
  }

  // 2. PERMISOS
  const permissions: Record<string, string[]> = {
    owner: ["ALL"],
    admin: ["ALL"],
    agent: ["SALES:BUY"],
  };

  const allowed = permissions[userRole] || [];

  if (!allowed.includes("ALL") && !allowed.includes(intent)) {
    return { execute: false, reason: "NO_PERMISSION" };
  }

  // 3. VALIDACIÓN DE DATOS (ejemplo: stock)
  if (intent === "SALES:BUY") {
    if (!stock || stock <= 0) {
      return { execute: false, reason: "NO_STOCK" };
    }
  }

  return { execute: true };
}
