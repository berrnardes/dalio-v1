// Session health — SPEC §4.3. Dropped WAHA sessions are the #1 operational
// incident in WAHA products (DOCUMENTO-EXECUTIVO §6): this worker keeps
// channels.status truthful, attempts an automatic restart on FAILED, and is
// where paging/alerting hooks in (Phase 7 wires real alerts).
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '@dalio/shared';
import type { SessionHealthJob } from '@dalio/shared';
import { NumbersService } from '../numbers/numbers.service';
import { ChannelsRepository } from './channels.repository';
import { WahaApiClient } from './providers/waha-api.client';

/** WAHA session states → our channel_status enum. */
const STATUS_MAP: Record<string, 'pairing' | 'connected' | 'disconnected' | 'failed'> = {
  STARTING: 'pairing',
  SCAN_QR_CODE: 'pairing',
  WORKING: 'connected',
  STOPPED: 'disconnected',
  FAILED: 'failed',
};

@Processor(QUEUES.SESSION_HEALTH)
export class SessionHealthWorker extends WorkerHost {
  private readonly logger = new Logger(SessionHealthWorker.name);

  constructor(
    private readonly channelsRepo: ChannelsRepository,
    private readonly wahaApi: WahaApiClient,
    private readonly numbers: NumbersService,
  ) {
    super();
  }

  async process(job: Job<SessionHealthJob>): Promise<void> {
    const { provider, channelExternalId, status } = job.data;
    const mapped = STATUS_MAP[status];
    if (!mapped) {
      this.logger.warn(`Unknown session status '${status}' for ${channelExternalId}`);
      return;
    }

    await this.channelsRepo.updateStatusByExternalId(provider, channelExternalId, mapped);

    if (mapped === 'failed') {
      // Loud on purpose: a failed session means a clinic is unreachable on
      // WhatsApp right now. Auto-restart is the first response; if WAHA needs
      // re-pairing the restart lands in SCAN_QR_CODE and the ops runbook
      // takes over (company SIMs — pairing is our job, not the clinic's).
      this.logger.error(`Session FAILED for channel ${channelExternalId} — restarting`);
      const channel = await this.channelsRepo.findByExternalId(provider, channelExternalId);
      // Ban-detection signal (Phase 6): a failed session hits the number's
      // quality score hard; repeated failures degrade it and page ops (and a
      // failing CANARY pauses all campaigns — see NumbersService).
      if (channel) await this.numbers.recordSessionFailure(channel.id).catch(() => undefined);
      try {
        await this.wahaApi.post(
          `/api/sessions/${channelExternalId}/restart`,
          {},
          channel?.host,
        );
      } catch (err) {
        this.logger.error(`Auto-restart failed for ${channelExternalId}: ${String(err)}`);
      }
    }
  }
}
