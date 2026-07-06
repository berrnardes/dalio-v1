// Ops alerts — SPEC §8 (Phase 7): "alertas de sessão" become real. One
// webhook (ALERT_WEBHOOK_URL — Slack/Discord/ntfy all accept this shape),
// fire-and-forget with a hard timeout: an alert must never block or fail the
// pipeline that raised it. Payloads carry identifiers and states only —
// message content never leaves the DB/LangSmith (iron rule #7).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AlertEvent =
  | { kind: 'session_failed'; channelExternalId: string; restarted: boolean }
  | { kind: 'number_degraded'; phone: string; score: number }
  | { kind: 'canary_down'; phone: string; state: string; campaignsPaused: number }
  | { kind: 'standby_pool_empty'; bannedPhone: string; clinicId: string };

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly webhookUrl: string | undefined;

  constructor(config: ConfigService) {
    this.webhookUrl = config.get<string>('ALERT_WEBHOOK_URL');
  }

  /**
   * Sends the alert; always also logs (the webhook is best-effort, the log
   * line is the durable trail). Never throws — see file header.
   */
  async raise(event: AlertEvent): Promise<void> {
    const text = render(event);
    this.logger.error(`ALERT ${event.kind}: ${text}`);
    if (!this.webhookUrl) return;

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` covers Slack/Discord-compatible receivers; the structured
        // event rides along for anything smarter.
        body: JSON.stringify({ text: `[dalio] ${text}`, event }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.logger.warn(`Alert webhook delivery failed: ${String(err)}`);
    }
  }
}

function render(event: AlertEvent): string {
  switch (event.kind) {
    case 'session_failed':
      return `WAHA session FAILED for channel ${event.channelExternalId} (auto-restart ${event.restarted ? 'issued' : 'FAILED'}) — clinic unreachable until recovered`;
    case 'number_degraded':
      return `number ${event.phone} degraded (score ${event.score}) — review for replacement`;
    case 'canary_down':
      return `CANARY ${event.phone} went ${event.state} — possible detection wave; ${event.campaignsPaused} campaign(s) paused fleet-wide`;
    case 'standby_pool_empty':
      return `NO STANDBY NUMBER to replace banned ${event.bannedPhone} (clinic ${event.clinicId}) — provision a SIM NOW`;
  }
}
