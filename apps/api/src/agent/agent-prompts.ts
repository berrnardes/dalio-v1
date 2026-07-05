// Prompt construction — SPEC §5: catalog/persona injected per clinic (no
// RAG; a clinic's catalog is 1–2k tokens), pt-BR WhatsApp style, and the
// non-negotiable medical guardrail restated where the model can't miss it.
import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import type { ClinicRow } from '../scheduling/clinics.repository';

export interface CatalogService {
  id: string;
  name: string;
  priceCents: number;
  durationMin: number;
}

const WEEKDAYS_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const formatPrice = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/** True when "now" falls inside the clinic's working hours — decides the
 *  handoff branch: real humans soon vs. honest "amanhã a partir das 9h". */
export function isOpenNow(clinic: ClinicRow, now = new Date()): boolean {
  const tz = clinic.timezone;
  const local = new TZDate(now, tz);
  const hours = clinic.settings?.workingHours?.[local.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6];
  if (!hours) return false;
  const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  return hhmm >= hours.open && hhmm < hours.close;
}

export function buildSystemPrompt(clinic: ClinicRow, services: CatalogService[]): string {
  const tz = clinic.timezone;
  const now = new TZDate(new Date(), tz);
  const today = `${WEEKDAYS_PT[now.getDay()]}, ${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;

  const catalog = services
    .map((s) => `- ${s.name} — ${formatPrice(s.priceCents)} — ${s.durationMin}min — id: ${s.id}`)
    .join('\n');

  const hours = Object.entries(clinic.settings?.workingHours ?? {})
    .map(([dow, h]) => `- ${WEEKDAYS_PT[Number(dow)]}: ${h.open} às ${h.close}`)
    .join('\n');

  const persona =
    clinic.settings?.agentPersonaPrompt ??
    `Você é a assistente virtual da ${clinic.name}, simpática, acolhedora e objetiva.`;

  return `${persona}

Você atende clientes da clínica pelo WhatsApp. Seu objetivo é responder dúvidas sobre os serviços e AGENDAR horários — você tem acesso à agenda real através das ferramentas.

## Catálogo de serviços
${catalog}

## Horário de funcionamento
${hours || '- (não configurado)'}

## Regras (invioláveis)
1. NUNCA dê conselhos médicos, clínicos ou de saúde (contraindicações, gravidez, medicamentos, reações, dores). Se perguntarem, diga com carinho que a equipe especializada vai responder e que você já encaminhou a dúvida.
2. Para agendar: use get_available_slots para ver horários reais e SÓ confirme com book_appointment depois que o cliente escolher serviço, data e horário explicitamente.
3. Nunca invente horários, preços ou serviços que não estão no catálogo ou nas ferramentas.
4. Estilo WhatsApp: mensagens curtas, calorosas, sem formalidade excessiva. No máximo 2-3 frases por resposta, sem markdown.
5. Responda sempre em português brasileiro.
6. Responda apenas com a mensagem final ao cliente — sem raciocínio visível, sem meta-comentários.

Hoje é ${today} (fuso ${tz}). Interprete "amanhã", "sexta que vem" etc. a partir de hoje.`;
}

export const ROUTER_SYSTEM_PROMPT = `Você classifica a última mensagem de um cliente de clínica de estética no WhatsApp, considerando o histórico da conversa.

Responda APENAS com JSON válido neste formato: {"intent": "<valor>"}

Valores possíveis:
- "booking": quer agendar, remarcar, cancelar ou consultar horários/agenda
- "faq": pergunta sobre serviços, preços, duração, endereço, funcionamento
- "medical": QUALQUER pergunta clínica ou de saúde (contraindicações, gravidez, amamentação, medicamentos, dor, reações, pele sensível, procedimentos serem seguros)
- "human": pede explicitamente para falar com uma pessoa/atendente
- "opt_out": pede para parar de receber mensagens
- "smalltalk": saudações e conversa social sem pedido concreto

Na dúvida entre "medical" e outra intenção, escolha "medical" — segurança vem primeiro.`;

const intentSchema = z.object({
  intent: z.enum(['booking', 'faq', 'medical', 'human', 'opt_out', 'smalltalk']),
});
export type RouterIntent = z.infer<typeof intentSchema>['intent'];

/** Tolerant JSON extraction — a JSON-only prompt still occasionally arrives
 *  wrapped in prose; anything unparseable degrades to 'faq' (safe default:
 *  the FAQ node answers politely and never books or advises). */
export function parseRouterIntent(text: string): RouterIntent {
  const match = /\{[^{}]*\}/.exec(text);
  if (!match) return 'faq';
  try {
    return intentSchema.parse(JSON.parse(match[0])).intent;
  } catch {
    return 'faq';
  }
}

export function handoffReply(params: { open: boolean; medical: boolean }): string {
  if (params.medical) {
    return params.open
      ? 'Essa é uma ótima pergunta para a nossa equipe especializada! Já encaminhei sua dúvida e alguém te responde por aqui em breve, tá bom? 💚'
      : 'Essa é uma ótima pergunta para a nossa equipe especializada! Já deixei sua dúvida registrada — te respondemos assim que a clínica abrir. 💚';
  }
  return params.open
    ? 'Claro! Já chamei alguém da equipe para continuar o atendimento por aqui. Só um instante! 💚'
    : 'Nossa equipe não está na clínica agora, mas já registrei seu pedido — te respondemos assim que abrirmos. Se quiser, posso adiantar algo ou já deixar um horário agendado!';
}

export const OPT_OUT_REPLY =
  'Tudo bem! Você não vai mais receber mensagens nossas. Se mudar de ideia, é só mandar um oi por aqui. 💚';
