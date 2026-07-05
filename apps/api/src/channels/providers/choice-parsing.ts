// Shared choice-reply parsing for provider adapters.
// Both adapters accept the same human answers to a rendered choice: the
// option number ("2", "2)", "2."), the option id, or the label (accent- and
// case-insensitive) — clinics' clients answer in every one of these forms.
import type { ChoiceIntent, NormalizedReply } from '@dalio/shared';

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

export function parseChoiceReply(text: string, expecting?: ChoiceIntent): NormalizedReply {
  if (!expecting) return { kind: 'freeform' };

  const trimmed = text.trim();

  const numberMatch = /^(\d{1,2})\s*[).>.]?$/.exec(trimmed);
  if (numberMatch) {
    const index = Number(numberMatch[1]) - 1;
    const option = expecting.options[index];
    if (option) return { kind: 'choice', optionId: option.id };
  }

  const normalized = normalize(trimmed);
  const byIdOrLabel = expecting.options.find(
    (o) => normalize(o.id) === normalized || normalize(o.label) === normalized,
  );
  if (byIdOrLabel) return { kind: 'choice', optionId: byIdOrLabel.id };

  // Anything else goes to the agent as a free answer — never guess a choice
  // the contact didn't clearly make (a wrong "confirm" is worse than a turn).
  return { kind: 'freeform' };
}

/** WAHA rendering of a choice: numbered list the contact can answer by digit. */
export function renderChoiceAsText(intent: ChoiceIntent): string {
  const lines = intent.options.map((o, i) => `${i + 1}. ${o.label}`);
  return `${intent.prompt}\n\n${lines.join('\n')}`;
}
