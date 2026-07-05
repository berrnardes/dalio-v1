// Deterministic opt-out detection — iron rule #4. LGPD compliance cannot
// depend on an LLM's mood: the unambiguous forms are caught by keyword
// BEFORE any model call and enforced mechanically. The router's opt_out
// intent is the second net for phrasings this misses.
//
// Precision matters as much as recall: "cancelar" alone must NOT trigger
// (clients cancel appointments), and "sair" only counts as a whole message
// (campaigns instruct "responda SAIR") — "vou sair do trabalho às 18h" is
// small talk, not an opt-out.
const EXACT_MESSAGES = new Set(['sair', 'pare', 'parar', 'stop', 'descadastrar']);

const PHRASES = [
  'nao quero receber',
  'nao quero mais receber',
  'nao quero mais mensagens',
  'pare de mandar',
  'pare de me mandar',
  'parar de receber',
  'me tira da lista',
  'remover meu numero',
  'descadastrar',
];

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

export function detectOptOut(text: string): boolean {
  const normalized = normalize(text);
  if (EXACT_MESSAGES.has(normalized)) return true;
  return PHRASES.some((phrase) => normalized.includes(phrase));
}
