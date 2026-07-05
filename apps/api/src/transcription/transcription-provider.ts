// Transcription provider seam. Kept minimal on purpose: the engine choice
// (Whisper self-hosted vs API — LGPD weighs here too, audio contains health
// data) is a deferred decision; the pipeline shape is not.
import { Injectable } from '@nestjs/common';

export interface TranscriptionProvider {
  /** Returns the transcript, or null when transcription is unavailable. */
  transcribe(mediaUrl: string): Promise<string | null>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');

/** Placeholder: pipeline works end-to-end, agent sees an honest marker. */
@Injectable()
export class NullTranscriptionProvider implements TranscriptionProvider {
  transcribe(_mediaUrl: string): Promise<string | null> {
    return Promise.resolve(null);
  }
}
