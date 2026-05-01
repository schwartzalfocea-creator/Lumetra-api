import type { Lang } from "./roots";
import type { RouteDecision } from "./router";

type DeptKey =
  | "Finance"
  | "Logistics"
  | "Security"
  | "Support"
  | "Medical"
  | "Legal"
  | "Escalation";

// ---------------------------------------------------------------------------
// Auto-response templates
//
// Each message follows a three-part structure:
//   Line 1 — Direct answer   (what was done)
//   Line 2 — Short explanation (why that department / what we detected)
//   Line 3 — Optional suggestion (actionable next step for the sender)
//
// Lines are joined with \n so the caller can render them as-is or split them.
// ---------------------------------------------------------------------------

const TEMPLATES: Record<Lang, Record<DeptKey, string>> = {
  en: {
    Finance: [
      "Your billing concern has been sent to Finance.",
      "We spotted a charge or invoice issue that needs a specialist's review.",
      "If you have an order or invoice number, reply with it to speed things up.",
    ].join("\n"),

    Logistics: [
      "Your delivery concern has been sent to Logistics.",
      "We detected a shipment or tracking issue and flagged it for review.",
      "Have a tracking number? Reply with it and we'll check the status right away.",
    ].join("\n"),

    Security: [
      "Your security concern has been flagged and sent to our Security team.",
      "We detected a possible account or access issue that needs immediate attention.",
      "If anything looks suspicious right now, change your password as a precaution.",
    ].join("\n"),

    Support: [
      "Your request has been received and sent to Support.",
      "We'll look into it and get back to you as soon as we can.",
      "Need to add more details? Just reply to this message.",
    ].join("\n"),

    Medical: [
      "Your health-related request has been sent for clinical review.",
      "A healthcare specialist will reach out to you as soon as possible.",
      "If this is an emergency, please call emergency services immediately.",
    ].join("\n"),

    Legal: [
      "Your request has been sent to our Legal team for review.",
      "We detected a compliance or contractual concern that requires specialist attention.",
      "Please hold any related documents — they may be needed during the review.",
    ].join("\n"),

    Escalation: [
      "Your case has been escalated for immediate human review.",
      "We detected an urgent situation that goes beyond automated handling.",
      "A team member will reach out to you as soon as possible — thank you for your patience.",
    ].join("\n"),
  },

  es: {
    Finance: [
      "Tu caso de facturación fue enviado al equipo de Finanzas.",
      "Detectamos un problema con un cobro o factura que requiere revisión.",
      "Si tienes un número de pedido o factura, compártelo para agilizar el proceso.",
    ].join("\n"),

    Logistics: [
      "Tu problema de entrega fue enviado al equipo de Logística.",
      "Detectamos un inconveniente con un envío o seguimiento y lo marcamos para revisión.",
      "¿Tienes un número de rastreo? Compártelo y revisaremos el estado de inmediato.",
    ].join("\n"),

    Security: [
      "Tu alerta de seguridad fue marcada y enviada a nuestro equipo de Seguridad.",
      "Detectamos una posible incidencia con tu cuenta o acceso que requiere atención inmediata.",
      "Si notas algo sospechoso ahora mismo, cambia tu contraseña como precaución.",
    ].join("\n"),

    Support: [
      "Tu solicitud fue recibida y enviada al equipo de Soporte.",
      "La revisaremos y te responderemos lo antes posible.",
      "¿Quieres agregar más detalles? Responde a este mensaje cuando quieras.",
    ].join("\n"),

    Medical: [
      "Tu solicitud relacionada con salud fue enviada para revisión clínica.",
      "Un especialista de salud se pondrá en contacto contigo lo antes posible.",
      "Si es una emergencia, llama a los servicios de emergencias de inmediato.",
    ].join("\n"),

    Legal: [
      "Tu solicitud fue enviada al equipo Legal para revisión.",
      "Detectamos una preocupación de cumplimiento o contractual que requiere atención especializada.",
      "Guarda cualquier documento relacionado — podría ser necesario durante la revisión.",
    ].join("\n"),

    Escalation: [
      "Tu caso fue escalado para revisión humana inmediata.",
      "Detectamos una situación urgente que requiere atención más allá de la automatización.",
      "Un miembro del equipo se pondrá en contacto contigo pronto — gracias por tu paciencia.",
    ].join("\n"),
  },

  pt: {
    Finance: [
      "Sua questão de cobrança foi encaminhada para a equipe Financeira.",
      "Detectamos um problema com uma cobrança ou fatura que precisa de revisão.",
      "Se tiver um número de pedido ou fatura, responda com ele para agilizar o atendimento.",
    ].join("\n"),

    Logistics: [
      "Sua questão de entrega foi encaminhada para Logística.",
      "Detectamos um problema com uma remessa ou rastreamento e sinalizamos para revisão.",
      "Tem um número de rastreamento? Responda com ele e verificamos o status na hora.",
    ].join("\n"),

    Security: [
      "Seu alerta de segurança foi sinalizado e enviado ao nosso time de Segurança.",
      "Detectamos uma possível questão de conta ou acesso que precisa de atenção imediata.",
      "Se algo parecer suspeito agora, troque sua senha como precaução.",
    ].join("\n"),

    Support: [
      "Sua solicitação foi recebida e enviada para o Suporte.",
      "Vamos analisá-la e retornar para você o mais rápido possível.",
      "Precisa adicionar mais detalhes? É só responder esta mensagem.",
    ].join("\n"),

    Medical: [
      "Sua solicitação de saúde foi encaminhada para triagem clínica.",
      "Um especialista de saúde entrará em contato com você o mais breve possível.",
      "Se for uma emergência, ligue para os serviços de emergência imediatamente.",
    ].join("\n"),

    Legal: [
      "Sua solicitação foi encaminhada ao nosso time Jurídico para revisão.",
      "Detectamos uma questão de conformidade ou contratual que requer atenção especializada.",
      "Guarde os documentos relacionados — eles podem ser necessários durante a análise.",
    ].join("\n"),

    Escalation: [
      "Seu caso foi escalado para revisão humana imediata.",
      "Detectamos uma situação urgente que vai além do tratamento automatizado.",
      "Um membro da equipe entrará em contato com você em breve — obrigado pela paciência.",
    ].join("\n"),
  },

  fr: {
    Finance: [
      "Votre demande de facturation a été transmise à l'équipe Finance.",
      "Nous avons détecté un problème de charge ou de facture nécessitant une vérification.",
      "Si vous avez un numéro de commande ou de facture, répondez avec pour accélérer le traitement.",
    ].join("\n"),

    Logistics: [
      "Votre problème de livraison a été transmis à l'équipe Logistique.",
      "Nous avons détecté un problème d'expédition ou de suivi et l'avons signalé pour examen.",
      "Avez-vous un numéro de suivi ? Répondez avec et nous vérifierons le statut immédiatement.",
    ].join("\n"),

    Security: [
      "Votre alerte de sécurité a été signalée et transmise à notre équipe Sécurité.",
      "Nous avons détecté un éventuel problème d'accès ou de compte nécessitant une attention immédiate.",
      "Si quelque chose vous semble suspect, changez votre mot de passe par précaution.",
    ].join("\n"),

    Support: [
      "Votre demande a été reçue et transmise au Support.",
      "Nous l'examinerons et vous répondrons dans les plus brefs délais.",
      "Vous souhaitez ajouter des détails ? Répondez simplement à ce message.",
    ].join("\n"),

    Medical: [
      "Votre demande de santé a été transmise pour triage clinique.",
      "Un spécialiste de santé vous contactera dans les plus brefs délais.",
      "En cas d'urgence, veuillez appeler les services d'urgence immédiatement.",
    ].join("\n"),

    Legal: [
      "Votre demande a été transmise à notre équipe Juridique pour examen.",
      "Nous avons détecté une question de conformité ou contractuelle nécessitant une attention spécialisée.",
      "Conservez tout document connexe — il pourra être utile lors de l'examen.",
    ].join("\n"),

    Escalation: [
      "Votre dossier a été escaladé pour un examen humain immédiat.",
      "Nous avons détecté une situation urgente qui dépasse le traitement automatisé.",
      "Un membre de notre équipe vous contactera dès que possible — merci de votre patience.",
    ].join("\n"),
  },
};

// ---------------------------------------------------------------------------
// Combined Finance + Logistics response
// ---------------------------------------------------------------------------

const COMBINED: Record<Lang, string> = {
  en: [
    "Your case has been sent to both Finance and Logistics.",
    "We detected both a billing concern and a shipment issue in your message.",
    "A coordinator will handle both together to avoid any back-and-forth.",
  ].join("\n"),

  es: [
    "Tu caso fue enviado a Finanzas y a Logística.",
    "Detectamos tanto un problema de facturación como un inconveniente de envío en tu mensaje.",
    "Un coordinador gestionará ambos juntos para evitar demoras.",
  ].join("\n"),

  pt: [
    "Seu caso foi encaminhado para o Financeiro e para Logística.",
    "Detectamos uma questão de cobrança e um problema de envio na sua mensagem.",
    "Um coordenador vai tratar ambos juntos para evitar idas e vindas.",
  ].join("\n"),

  fr: [
    "Votre dossier a été transmis aux équipes Finance et Logistique.",
    "Nous avons détecté à la fois une question de facturation et un problème d'expédition dans votre message.",
    "Un coordinateur traitera les deux ensemble pour éviter les allers-retours.",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateResponse(
  language: Lang,
  decision: RouteDecision,
): string {
  if (
    decision.departments.includes("Finance") &&
    decision.departments.includes("Logistics")
  ) {
    return COMBINED[language];
  }

  const primary = decision.departments[0] as DeptKey | undefined;
  if (!primary) return TEMPLATES[language].Support;

  const lang = TEMPLATES[language] ?? TEMPLATES.en;
  return lang[primary] ?? lang.Support;
}
