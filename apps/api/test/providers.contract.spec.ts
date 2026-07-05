// Provider contract tests — SPEC §4.5: the shared behavioral contract both
// adapters must honor so per-tenant provider routing (and the emergency
// migration path) stays safe. Runs against WahaProvider (fake HTTP) and
// CloudApiProvider (stub) alike wherever behavior must match.
import { describe, expect, it, vi } from 'vitest';
import type { ChoiceIntent } from '@dalio/shared';
import { CloudApiProvider } from '../src/channels/providers/cloud-api.provider';
import type { MessagingProvider } from '../src/channels/providers/messaging-provider';
import type { WahaApiClient } from '../src/channels/providers/waha-api.client';
import { WahaProvider, toChatId } from '../src/channels/providers/waha.provider';

const confirmIntent: ChoiceIntent = {
  kind: 'choice',
  prompt: 'Seu horário é amanhã às 15h.',
  options: [
    { id: 'confirm', label: 'Confirmar' },
    { id: 'reschedule', label: 'Remarcar' },
  ],
};

function fakeWahaApi() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = {
    post: vi.fn(async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      return { id: 'true_5511999998888@c.us_SENT1' };
    }),
  };
  return { api: api as unknown as WahaApiClient, calls };
}

// ── Contract shared by every adapter ──────────────────────────────────────
function itBehavesLikeAProvider(name: string, make: () => MessagingProvider) {
  describe(`${name} (shared contract)`, () => {
    it.each([
      ['digit', '1', 'confirm'],
      ['digit with punctuation', '2)', 'reschedule'],
      ['option id', 'confirm', 'confirm'],
      ['label case/accent-insensitive', 'REMARCAR', 'reschedule'],
    ])('choice reply round-trip: %s', (_label, reply, expected) => {
      const parsed = make().parseInboundReply(reply, confirmIntent);
      expect(parsed).toEqual({ kind: 'choice', optionId: expected });
    });

    it('never guesses: unclear reply is freeform', () => {
      expect(make().parseInboundReply('pode ser sim', confirmIntent)).toEqual({
        kind: 'freeform',
      });
      expect(make().parseInboundReply('9', confirmIntent)).toEqual({ kind: 'freeform' });
    });

    it('without a pending choice, everything is freeform', () => {
      expect(make().parseInboundReply('1')).toEqual({ kind: 'freeform' });
    });
  });
}

itBehavesLikeAProvider('WahaProvider', () => new WahaProvider(fakeWahaApi().api));
itBehavesLikeAProvider('CloudApiProvider', () => new CloudApiProvider());

// ── WAHA-specific rendering ───────────────────────────────────────────────
describe('WahaProvider', () => {
  const channel = { externalId: 'clinic-a', host: null };

  it('renders choice intents as numbered text (no buttons on unofficial API)', async () => {
    const { api, calls } = fakeWahaApi();
    await new WahaProvider(api).send(channel, '+5511999998888', confirmIntent);
    expect(calls[0]!.path).toBe('/api/sendText');
    expect(calls[0]!.body.text).toBe(
      'Seu horário é amanhã às 15h.\n\n1. Confirmar\n2. Remarcar',
    );
    expect(calls[0]!.body.chatId).toBe('5511999998888@c.us');
  });

  it('returns the provider message id from the WAHA response', async () => {
    const { api } = fakeWahaApi();
    const result = await new WahaProvider(api).send(channel, '+5511999998888', {
      kind: 'text',
      text: 'olá',
    });
    expect(result.providerMessageId).toBe('true_5511999998888@c.us_SENT1');
  });

  it('refuses unresolved template intents (must be rendered upstream)', async () => {
    const { api } = fakeWahaApi();
    await expect(
      new WahaProvider(api).send(channel, '+5511999998888', {
        kind: 'template',
        templateKey: 'reactivation_lash',
        variables: {},
      }),
    ).rejects.toThrow(/rendered before/);
  });

  it('has no messaging window', () => {
    expect(new WahaProvider(fakeWahaApi().api).canSendFreeform(null)).toBe(true);
  });

  it('normalizes E.164 to WAHA chat ids', () => {
    expect(toChatId('+55 (11) 99999-8888')).toBe('5511999998888@c.us');
  });
});

// ── Cloud-specific: the 24h window math is the real logic kept alive ──────
describe('CloudApiProvider', () => {
  it('freeform allowed only within 24h of last inbound', () => {
    const provider = new CloudApiProvider();
    expect(provider.canSendFreeform(null)).toBe(false);
    expect(provider.canSendFreeform(new Date(Date.now() - 23 * 3_600_000))).toBe(true);
    expect(provider.canSendFreeform(new Date(Date.now() - 25 * 3_600_000))).toBe(false);
  });

  it('send is an explicit stub — the insurance adapter must fail loudly', async () => {
    await expect(
      new CloudApiProvider().send({ externalId: 'x' }, '+55', { kind: 'text', text: 'a' }),
    ).rejects.toThrow(/stub/);
  });
});
