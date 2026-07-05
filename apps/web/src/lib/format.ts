// Presentation helpers for the inbox — pt-BR copy lives here, never in the
// API (the api renders WhatsApp copy; the dashboard renders dashboard copy).
import { format, formatDistanceToNow, isToday } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { MessageSource } from '@dalio/shared';
import type { Message } from './types';

export function contactLabel(name: string | null, phone: string): string {
  return name?.trim() || phone;
}

/** "14:32" today, "12 jun 14:32" otherwise. */
export function messageTime(iso: string): string {
  const date = new Date(iso);
  return isToday(date) ? format(date, 'HH:mm') : format(date, "d MMM HH:mm", { locale: ptBR });
}

export function relativeTime(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
}

export const SOURCE_LABELS: Record<MessageSource, string> = {
  contact: 'Cliente',
  agent: 'Agente',
  human: 'Equipe',
  reminder: 'Lembrete',
  campaign: 'Campanha',
  system: 'Sistema',
};

/**
 * Text to render for a message bubble. Outbound rows only get body.text at
 * send time (outbox pattern), so queued/draft rows render from the intent.
 */
export function messageText(message: Message): string {
  if (message.body.text) return message.body.text;
  if (message.transcription) return message.transcription;
  if (message.body.caption) return message.body.caption;
  if (message.intent) {
    switch (message.intent.kind) {
      case 'text':
        return message.intent.text;
      case 'choice':
        return `${message.intent.prompt}\n${message.intent.options
          .map((o, i) => `${i + 1}. ${o.label}`)
          .join('\n')}`;
      case 'media':
        return message.intent.caption ?? '[mídia]';
      case 'template':
        return `[template: ${message.intent.templateKey}]`;
    }
  }
  switch (message.kind) {
    case 'audio':
      return '[áudio]';
    case 'image':
      return '[imagem]';
    case 'document':
      return '[documento]';
    default:
      return '[mensagem]';
  }
}

export function isPaused(pausedUntil: string | null): boolean {
  return pausedUntil !== null && new Date(pausedUntil) > new Date();
}
