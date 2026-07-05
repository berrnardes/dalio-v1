// WAHA webhook endpoint — SPEC §4.4 invariant 1. Thin by design: the
// controller only extracts transport details (raw body for HMAC, header) and
// delegates; all decisions live in WebhookIngestService. Always 200 except
// auth failures (401 → operator misconfig) and Redis outages (500 → we WANT
// WAHA's redelivery, it's the only case a retry helps).
import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import { WebhookIngestService } from './webhook-ingest.service';

@AllowAnonymous()
@Controller('webhooks/waha')
export class WahaWebhookController {
  constructor(private readonly ingest: WebhookIngestService) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-hmac') hmac: string | undefined,
  ) {
    const outcome = await this.ingest.ingest(req.rawBody, hmac, req.body);
    return { ok: true, outcome };
  }
}
