import type { Lang } from "./roots";

const HINTS: Record<Lang, string[]> = {
  es: [
    " el ", " la ", " los ", " las ", " mi ", " un ", " una ", " que ",
    " porque ", " cómo ", " como ", " qué ", " cuándo ", " dónde ", " no ",
    " sí ", " soy ", " es ", " está ", " está ", " esta ", " son ", " hola ",
    " gracias ", " ayuda ", " enviado ", " ñ ", "¿", "¡", " años ", " días ",
  ],
  pt: [
    " o ", " a ", " os ", " as ", " um ", " uma ", " meu ", " minha ",
    " você ", " voce ", " que ", " porque ", " como ", " quando ", " onde ",
    " não ", " nao ", " sim ", " sou ", " é ", " estou ", " obrigado ",
    " ajuda ", " encomenda ", " ç ", " ã ", " õ ",
  ],
  fr: [
    " le ", " la ", " les ", " un ", " une ", " mon ", " ma ", " mes ",
    " vous ", " votre ", " je ", " est ", " sont ", " que ", " comment ",
    " pourquoi ", " quand ", " où ", " non ", " oui ", " bonjour ", " merci ",
    " aide ", " ç ", " é ", " è ", " ê ", " à ",
  ],
  en: [
    " the ", " a ", " an ", " is ", " are ", " was ", " were ", " my ",
    " your ", " our ", " we ", " you ", " they ", " this ", " that ",
    " what ", " when ", " where ", " how ", " why ", " not ", " no ",
    " yes ", " hello ", " thanks ", " help ", " please ",
  ],
};

const SPECIAL_CHARS: Record<Lang, RegExp> = {
  es: /[ñ¿¡]/i,
  pt: /[ãõ]|ção|são|não/i,
  fr: /[àâçéèêëîïôûùüÿœæ]|l'|d'|j'|n'|qu'|s'|c'/i,
  en: /^$/,
};

export function detectLanguage(text: string): Lang {
  const padded = ` ${text.toLowerCase()} `;
  const scores: Record<Lang, number> = { en: 0, es: 0, pt: 0, fr: 0 };

  for (const lang of ["en", "es", "pt", "fr"] as Lang[]) {
    for (const hint of HINTS[lang]) {
      if (padded.includes(hint)) scores[lang] += 1;
    }
    if (SPECIAL_CHARS[lang].test(text)) scores[lang] += 3;
  }

  let best: Lang = "en";
  let bestScore = -1;
  for (const lang of ["en", "es", "pt", "fr"] as Lang[]) {
    if (scores[lang] > bestScore) {
      best = lang;
      bestScore = scores[lang];
    }
  }
  return best;
}
