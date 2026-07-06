// Campaign API — SPEC §7: CRUD, start/pause, and the segment preview with
// suppressions (the clinic sees WHO would receive and WHY others won't,
// before committing to two weeks of drip).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { REACTIVATION_TEMPLATE_KEY } from '@dalio/shared';
import { CampaignsRepository } from './campaigns.repository';
import { SegmentBuilder } from './segment.builder';

const segmentSchema = z
  .object({
    serviceIds: z.array(z.string().uuid()).optional(),
    overdueDaysMin: z.number().int().min(0).optional(),
    overdueDaysMax: z.number().int().min(0).optional(),
  })
  .optional();

const createCampaignSchema = z.object({
  name: z.string().min(1),
  templateKey: z.string().min(1).default(REACTIVATION_TEMPLATE_KEY),
  segment: segmentSchema,
  // ≤50/day per number is the reactivation ceiling (DOCUMENTO-EXECUTIVO §3.3).
  dailyCap: z.number().int().min(1).max(50).default(20),
});

@Controller('api/v1/campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsRepo: CampaignsRepository,
    private readonly segments: SegmentBuilder,
  ) {}

  @Get()
  list() {
    return this.campaignsRepo.list();
  }

  @Post()
  async create(@Body() body: unknown) {
    const parsed = createCampaignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.campaignsRepo.create({
      name: parsed.data.name,
      templateKey: parsed.data.templateKey,
      segment: parsed.data.segment ?? null,
      dailyCap: parsed.data.dailyCap,
    });
  }

  /** Dry-run: the segment as it would be snapshotted right now. */
  @Post('preview')
  async preview(@Body() body: unknown) {
    const parsed = segmentSchema.safeParse((body as { segment?: unknown })?.segment ?? body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const members = await this.segments.build(parsed.data ?? null);
    return {
      eligibleCount: members.filter((m) => m.suppressedReason === null).length,
      suppressedByReason: countBy(members.flatMap((m) => m.suppressedReason ?? [])),
      members,
    };
  }

  /**
   * Start = snapshot the segment into campaign_recipients (suppressions
   * recorded, not dropped) + flip to running. The 1/min dispatcher takes it
   * from here at drip pace.
   */
  @Post(':id/start')
  async start(@Param('id') id: string) {
    const campaign = await this.campaignsRepo.getById(id);
    if (!campaign) throw new NotFoundException();
    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      throw new BadRequestException(`Cannot start a ${campaign.status} campaign`);
    }

    // Paused → running is a resume: the snapshot already exists.
    if (campaign.status === 'draft') {
      const members = await this.segments.build(campaign.segment);
      await this.campaignsRepo.insertRecipients(
        members.map((m) => ({
          campaignId: campaign.id,
          contactId: m.contactId,
          serviceId: m.serviceId,
          suppressedReason: m.suppressedReason,
        })),
      );
    }
    const updated = await this.campaignsRepo.setStatus(id, campaign.status, 'running', {
      startedAt: campaign.startedAt ?? new Date(),
    });
    if (!updated) throw new BadRequestException('Campaign changed state concurrently');
    return updated;
  }

  @Post(':id/pause')
  async pause(@Param('id') id: string) {
    const updated = await this.campaignsRepo.setStatus(id, 'running', 'paused');
    if (!updated) throw new NotFoundException('No running campaign with this id');
    return updated;
  }
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
