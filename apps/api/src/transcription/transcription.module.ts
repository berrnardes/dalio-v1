// Transcription — SPEC §4.3. Audio is huge in Brazilian WhatsApp; an agent
// that ignores voice notes is broken in this market. Audio messages detour
// here and join the debounce buffer once text exists, so the drain never
// hands the agent an unresolved '[áudio]'.
//
// The provider is a seam: NullTranscriptionProvider until the real engine is
// picked (TASKS.md pending decision: Whisper self-hosted vs API).
import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { ConversationsModule } from '../conversations/conversations.module';
import {
  NullTranscriptionProvider,
  TRANSCRIPTION_PROVIDER,
} from './transcription-provider';
import { TranscriptionWorker } from './transcription.worker';

@Module({
  imports: [ChannelsModule, ConversationsModule],
  providers: [
    TranscriptionWorker,
    { provide: TRANSCRIPTION_PROVIDER, useClass: NullTranscriptionProvider },
  ],
})
export class TranscriptionModule {}
