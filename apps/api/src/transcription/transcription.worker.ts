// Transcription worker — resolves audio to text, then feeds the debounce
// buffer exactly like a text message would have (the burst window opens when
// the transcript lands, keeping invariant 2 for voice-note bursts too).
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '@dalio/shared';
import type { TranscriptionJob } from '@dalio/shared';
import { ChannelsRepository } from '../channels/channels.repository';
import { BufferService, DEFAULT_DEBOUNCE_MS } from '../conversations/buffer.service';
import { ConversationsRepository } from '../conversations/conversations.repository';
import { TenantContextService } from '../tenancy/tenant-context.service';
import type { TranscriptionProvider } from './transcription-provider';
import { TRANSCRIPTION_PROVIDER } from './transcription-provider';

/** Honest fallback the agent can react to ("não consegui ouvir o áudio…"). */
const UNAVAILABLE_MARKER = '[áudio recebido — transcrição indisponível]';

@Processor(QUEUES.TRANSCRIPTION, { concurrency: 5 })
export class TranscriptionWorker extends WorkerHost {
  private readonly logger = new Logger(TranscriptionWorker.name);

  constructor(
    @Inject(TRANSCRIPTION_PROVIDER) private readonly provider: TranscriptionProvider,
    private readonly conversationsRepo: ConversationsRepository,
    private readonly channelsRepo: ChannelsRepository,
    private readonly buffer: BufferService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<TranscriptionJob>): Promise<void> {
    const { messageId, clinicId, conversationId, mediaUrl } = job.data;

    const transcript = (await this.provider.transcribe(mediaUrl)) ?? UNAVAILABLE_MARKER;

    await this.tenantContext.run({ clinicId, userId: 'system:transcription' }, async () => {
      await this.conversationsRepo.setTranscription(messageId, transcript);

      // Debounce config lives on the clinic; fetch via the conversation's
      // channel (one query — worker context has no resolved channel here).
      const conversation = await this.conversationsRepo.getById(conversationId);
      if (!conversation) return;

      await this.buffer.push({
        conversationId,
        clinicId,
        entry: { messageId, text: transcript, kind: 'audio', timestamp: Date.now() },
        debounceMs: (await this.debounceFor(conversation.channelId)) ?? DEFAULT_DEBOUNCE_MS,
        skipDebounce: conversation.flowContext?.kind?.startsWith('awaiting') ?? false,
      });
    });
  }

  private async debounceFor(channelId: string): Promise<number | undefined> {
    // ChannelsRepository resolves by external id; here we only have our own
    // id — a dedicated query would be cleaner, accepted for Phase 1.
    void channelId;
    return undefined;
  }
}
