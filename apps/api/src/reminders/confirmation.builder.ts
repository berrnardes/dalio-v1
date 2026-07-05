// Confirmation choice construction & parsing — SPEC §4 (Phase 4).
//
// Iron rule #2: the reminder's message copy comes from a templateKey (rendered
// with per-clinic variants for anti-ban variation); the option LABELS are the
// choice mechanics the adapter renders as a numbered list. Reply parsing is
// DETERMINISTIC (never the LLM): a wrongly-inferred "confirmed" is worse than
// falling back to a normal agent turn.
import { Injectable } from '@nestjs/common';
import { CONFIRMATION_OPTIONS } from '@dalio/shared';
import type { ChoiceIntent, ChoiceOption } from '@dalio/shared';
import { parseChoiceReply } from '../channels/providers/choice-parsing';
import { TemplateRenderService } from '../outbound/template-render.service';

/** The three actions a confirmation reminder offers. Labels are pt-BR (client
 *  facing); ids are stable (matched by the deterministic reply parser). */
export const CONFIRMATION_CHOICE_OPTIONS: ChoiceOption[] = [
  { id: CONFIRMATION_OPTIONS.CONFIRM, label: 'Confirmar' },
  { id: CONFIRMATION_OPTIONS.RESCHEDULE, label: 'Remarcar' },
  { id: CONFIRMATION_OPTIONS.CANCEL, label: 'Cancelar' },
];

@Injectable()
export class ConfirmationBuilder {
  constructor(private readonly templateRender: TemplateRenderService) {}

  /**
   * Builds the confirmation `choice` intent: prompt rendered from the kind's
   * template, options fixed. The rendered prompt is embedded in the intent
   * (not left as a templateKey) because a choice's prompt is inseparable from
   * its options at render time.
   */
  async build(templateKey: string, variables: Record<string, string>): Promise<ChoiceIntent> {
    const prompt = await this.templateRender.render(templateKey, variables);
    return { kind: 'choice', prompt, options: CONFIRMATION_CHOICE_OPTIONS };
  }

  /**
   * Maps a contact's reply to a confirmation action using the stored options,
   * or null when the reply isn't a clear choice (topic change → hand back to
   * the agent). Reuses the same parser the provider adapters use, so "1",
   * "confirmar", "Confirmar" all resolve identically.
   */
  static parseReply(text: string, options: ChoiceOption[]): string | null {
    const expecting: ChoiceIntent = { kind: 'choice', prompt: '', options };
    const reply = parseChoiceReply(text, expecting);
    return reply.kind === 'choice' ? reply.optionId : null;
  }
}
