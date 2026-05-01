export type KernelResult = {
  rootCode: string;
  confidence: number;
};

const ROOTS: Record<string, string[]> = {
  "FIN:REFUND": ["devolucion", "cobro doble"],
  "SUPPORT:HELP": ["ayuda", "error"],
  "SALES:BUY": ["comprar", "precio"],
};

export function distill(input: string): KernelResult {
  const text = input.toLowerCase();

  for (const root in ROOTS) {
    for (const word of ROOTS[root]) {
      if (text.includes(word)) {
        return { rootCode: root, confidence: 0.9 };
      }
    }
  }

  return { rootCode: "UNKNOWN", confidence: 0.3 };
}
