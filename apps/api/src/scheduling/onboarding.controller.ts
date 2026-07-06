// Onboarding checklist + activation gate — Phase 7 (TASKS.md: "clínica só
// ativa com checklist verde"). The checklist encodes the adoption
// prerequisites that decide whether the pilot works AT ALL (DEPLOYMENT.md
// §6); the activate endpoint is the mechanical gate — no green checklist +
// connected channel, no active clinic, no traffic.
import { BadRequestException, Body, Controller, Get, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ONBOARDING_ITEMS } from '@dalio/shared';
import type { ClinicSettings, OnboardingItem } from '@dalio/shared';
import { ChannelsRepository } from '../channels/channels.repository';
import { ClinicsRepository } from './clinics.repository';

const patchSchema = z.object(
  Object.fromEntries(ONBOARDING_ITEMS.map((k) => [k, z.boolean().optional()])) as Record<
    OnboardingItem,
    z.ZodOptional<z.ZodBoolean>
  >,
);

@Controller('api/v1/clinic')
export class OnboardingController {
  constructor(
    private readonly clinicsRepo: ClinicsRepository,
    private readonly channelsRepo: ChannelsRepository,
  ) {}

  @Get('onboarding')
  async get() {
    const clinic = await this.clinicsRepo.getCurrent();
    return {
      status: clinic.status,
      checklist: checklistOf(clinic.settings),
      complete: missingItems(clinic.settings).length === 0,
    };
  }

  @Put('onboarding')
  async patch(@Body() body: unknown) {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const clinic = await this.clinicsRepo.getCurrent();
    const updated = await this.clinicsRepo.patchSettings({
      onboarding: { ...clinic.settings?.onboarding, ...parsed.data },
    });
    return { checklist: checklistOf(updated.settings) };
  }

  /** The gate: every item true AND a connected channel, or no activation. */
  @Post('activate')
  async activate() {
    const clinic = await this.clinicsRepo.getCurrent();
    const missing = missingItems(clinic.settings);
    if (missing.length > 0) {
      throw new BadRequestException(`Onboarding incomplete: ${missing.join(', ')}`);
    }
    if (!(await this.channelsRepo.findConnectedChannelId(clinic.id))) {
      throw new BadRequestException('No connected WhatsApp channel — pair the session first');
    }
    await this.clinicsRepo.setStatus('active');
    return { ok: true, status: 'active' };
  }
}

function checklistOf(settings: ClinicSettings | null): Record<OnboardingItem, boolean> {
  return Object.fromEntries(
    ONBOARDING_ITEMS.map((k) => [k, settings?.onboarding?.[k] === true]),
  ) as Record<OnboardingItem, boolean>;
}

/** Exported for unit tests — the gate's whole truth. */
export function missingItems(settings: ClinicSettings | null): OnboardingItem[] {
  return ONBOARDING_ITEMS.filter((k) => settings?.onboarding?.[k] !== true);
}
