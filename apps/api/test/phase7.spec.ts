// Phase 7 unit tests — the beta-hardening rules that are pure logic: the
// LGPD consent gate (a campaign reaching a non-consented contact is a legal
// problem, not a bug), the CSV import parser (a bad phone is an unreachable
// contact forever), the onboarding gate, and the alert webhook contract.
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { CanContactService } from '../src/outbound/can-contact.service';
import type { ContactRow } from '../src/conversations/contacts.repository';
import { ContactsController } from '../src/conversations/contacts.controller';
import type { ContactsRepository } from '../src/conversations/contacts.repository';
import { missingItems } from '../src/scheduling/onboarding.controller';
import { AlertsService } from '../src/alerts/alerts.service';

const contact = (over: Partial<ContactRow> = {}): ContactRow =>
  ({
    id: 'c1',
    clinicId: 'cl1',
    phone: '+5511999998888',
    optOutAt: null,
    consentAt: null,
    ...over,
  }) as ContactRow;

describe('canContact — LGPD gates (iron rule #4)', () => {
  const svc = new CanContactService();

  it('campaigns REQUIRE consent; reminders ride the appointment relationship', () => {
    expect(svc.check(contact(), 'campaign')).toEqual({ allowed: false, reason: 'no_consent' });
    expect(svc.check(contact({ consentAt: new Date() }), 'campaign')).toEqual({ allowed: true });
    expect(svc.check(contact(), 'reminder')).toEqual({ allowed: true });
  });

  it('opt-out beats everything, consent included', () => {
    const optedOut = contact({ optOutAt: new Date(), consentAt: new Date() });
    expect(svc.check(optedOut, 'campaign')).toEqual({ allowed: false, reason: 'opt_out' });
    expect(svc.check(optedOut, 'reminder')).toEqual({ allowed: false, reason: 'opt_out' });
  });

  it('conversational replies are never gated (the contact initiated)', () => {
    expect(svc.check(contact({ optOutAt: new Date() }), 'agent')).toEqual({ allowed: true });
  });
});

describe('contacts CSV import parsing', () => {
  function makeController() {
    const calls: Array<{ rows: unknown; consented: boolean }> = [];
    const repo = {
      importMany: (rows: unknown, consented: boolean) => {
        calls.push({ rows, consented });
        return Promise.resolve((rows as unknown[]).length);
      },
    } as unknown as ContactsRepository;
    return { controller: new ContactsController(repo), calls };
  }

  it('parses phone[,name] lines, skips headers/blanks/invalid phones', async () => {
    const { controller, calls } = makeController();
    const result = await controller.import({
      csv: 'telefone,nome\n+5511999990001,Ana\n\n+5511999990002\n11 99999-0003,Bia\nabc,Caio',
      consent: true,
    });

    expect(result.imported).toBe(2);
    expect(result.skipped).toEqual(['11 99999-0003,Bia', 'abc,Caio']);
    expect(calls[0]!.rows).toEqual([
      { phone: '+5511999990001', name: 'Ana' },
      { phone: '+5511999990002', name: null },
    ]);
    expect(calls[0]!.consented).toBe(true);
  });

  it('rejects a payload without the consent assertion', async () => {
    const { controller } = makeController();
    await expect(controller.import({ csv: '+5511999990001' })).rejects.toThrow();
  });
});

describe('onboarding activation gate', () => {
  it('lists every unchecked item; complete checklist yields none', () => {
    expect(missingItems(null)).toHaveLength(4);
    expect(missingItems({ onboarding: { redirectInBio: true, inboxTrained: true } })).toEqual([
      'adsUpdated',
      'catalogFilled',
    ]);
    expect(
      missingItems({
        onboarding: { redirectInBio: true, adsUpdated: true, inboxTrained: true, catalogFilled: true },
      }),
    ).toEqual([]);
  });
});

describe('AlertsService', () => {
  const makeConfig = (url: string | undefined) =>
    ({ get: () => url }) as unknown as ConfigService;

  it('POSTs a text+event payload to the webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await new AlertsService(makeConfig('https://hooks.example/x')).raise({
        kind: 'standby_pool_empty',
        bannedPhone: '+5511888887777',
        clinicId: 'cl1',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
        text: string;
        event: { kind: string };
      };
      expect(body.text).toContain('NO STANDBY NUMBER');
      expect(body.event.kind).toBe('standby_pool_empty');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is a silent no-op without a webhook URL and never throws on failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await new AlertsService(makeConfig(undefined)).raise({
        kind: 'number_degraded',
        phone: '+55',
        score: 0.4,
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // Webhook down: raise() must swallow it (alerts never break the raiser).
      await expect(
        new AlertsService(makeConfig('https://hooks.example/x')).raise({
          kind: 'number_degraded',
          phone: '+55',
          score: 0.4,
        }),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
