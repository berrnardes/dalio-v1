// Opt-out detector — iron rule #4. Recall AND precision are load-bearing:
// a missed opt-out is an LGPD violation; a false positive silently
// unsubscribes a client who was cancelling an appointment.
import { describe, expect, it } from 'vitest';
import { detectOptOut } from '../src/agent/opt-out.detector';

describe('detectOptOut', () => {
  it.each([
    'SAIR',
    ' sair ',
    'Pare',
    'não quero mais receber mensagens',
    'nao quero receber isso',
    'pare de me mandar mensagem',
    'quero parar de receber as promoções',
    'me tira da lista por favor',
  ])('detects opt-out: %s', (text) => {
    expect(detectOptOut(text)).toBe(true);
  });

  it.each([
    'quero cancelar meu horário de quinta',
    'vou sair do trabalho às 18h, tem horário depois?',
    'pode parar o procedimento se doer?',
    'quero receber mais informações',
    'oi, tudo bem?',
  ])('does NOT flag normal conversation: %s', (text) => {
    expect(detectOptOut(text)).toBe(false);
  });
});
