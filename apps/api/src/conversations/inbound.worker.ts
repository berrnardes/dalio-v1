// Inbound worker — SPEC §4.3 `inbound` queue. Everything the webhook handler
// was forbidden to do happens here: resolve channel → clinic, upsert the
// contact, persist the message (dedupe backstop), and feed the debounce
// buffer. Audio detours through the transcription queue and joins the buffer
// from there — the agent must never see '[áudio]' when text was obtainable.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '@dalio/shared';
import type { InboundJob, TranscriptionJob } from '@dalio/shared';
import { ChannelsRepository } from '../channels/channels.repository';
import type { ProviderRegistry } from '../channels/providers/messaging-provider';
import { PROVIDER_REGISTRY } from '../channels/providers/messaging-provider';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { BufferService, DEFAULT_DEBOUNCE_MS } from './buffer.service';
import { ContactsRepository } from './contacts.repository';
import { ConversationsRepository } from './conversations.repository';

@Processor(QUEUES.INBOUND, { concurrency: 10 })
export class InboundWorker extends WorkerHost {
  private readonly logger = new Logger(InboundWorker.name);

  constructor(
    private readonly channelsRepo: ChannelsRepository,
    private readonly contactsRepo: ContactsRepository,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly buffer: BufferService,
    private readonly tenantContext: TenantContextService,
    @Inject(PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @InjectQueue(QUEUES.TRANSCRIPTION)
    private readonly transcriptionQueue: Queue<TranscriptionJob>,
  ) {
    super();
  }

  async process(job: Job<InboundJob>): Promise<void> {
    const event = job.data;

    const channel = await this.channelsRepo.findByExternalId(
      event.provider,
      event.channelExternalId,
    );
    if (!channel) {
      // Unknown session — likely a provisioning gap. Complete (not fail):
      // retrying cannot resolve a channel that isn't registered.
      this.logger.warn(`No channel for ${event.provider}/${event.channelExternalId} — dropping`);
      return;
    }
    if (channel.clinicStatus !== 'active') return;

    // Workers open the tenant scope from resolved data (iron rule #1's
    // worker-side entry point; HTTP uses middleware+guard instead).
    await this.tenantContext.run(
      { clinicId: channel.clinicId, userId: 'system:inbound' },
      async () => {
        const at = new Date(event.timestamp);
        const contact = await this.contactsRepo.upsertByPhone(event.from);
        const convo = await this.conversationsRepo.findOrCreateOpen(contact.id, channel.id);

        const message = await this.conversationsRepo.appendInbound({
          conversationId: convo.id,
          providerMessageId: event.providerMessageId,
          content: event.content,
          at,
        });
        if (!message) return; // dedupe backstop fired — already processed

        await this.conversationsRepo.touchLastInbound(convo.id, at);

        // Audio: buffer entry is created by the transcription worker once
        // text exists; the debounce window opens when that entry lands.
        if (event.content.kind === 'audio') {
          await this.transcriptionQueue.add(
            'transcribe',
            {
              messageId: message.id,
              clinicId: channel.clinicId,
              conversationId: convo.id,
              mediaUrl: event.content.mediaUrl,
            },
            { jobId: `tr-${message.id}` },
          );
          return;
        }

        const text =
          event.content.kind === 'text'
            ? event.content.text
            : (event.content.caption ??
              (event.content.kind === 'image' ? '[imagem recebida]' : '[documento recebido]'));

        const length = await this.buffer.push({
          conversationId: convo.id,
          clinicId: channel.clinicId,
          entry: { messageId: message.id, text, kind: event.content.kind, timestamp: event.timestamp },
          debounceMs: channel.clinicSettings?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
          // A pending structured choice answers instantly — no 7s wait for "1".
          skipDebounce: convo.flowContext?.kind?.startsWith('awaiting') ?? false,
        });

        // Typing indicator once per burst: buys the debounce window for free
        // (humans wait happily for someone visibly typing). Fire-and-forget —
        // a typing failure must never fail message processing.
        if (length === 1) {
          this.providers
            .get(channel.provider)
            .startTyping({ externalId: channel.externalId, host: channel.host }, event.from)
            .catch(() => undefined);
        }
      },
    );
  }
}
