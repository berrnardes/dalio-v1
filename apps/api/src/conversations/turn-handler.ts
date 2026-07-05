// Agent-turn seam between the pipeline (Phase 1) and the LangGraph agent
// (Phase 2). The pipeline guarantees WHEN a turn runs (coalesced, serialized,
// none lost); the handler decides WHAT the turn does. Phase 2 binds a
// LangGraph implementation to TURN_HANDLER; storm tests bind recorders.
import { Injectable, Logger } from '@nestjs/common';
import type { BufferedMessage } from '@dalio/shared';

export interface TurnInput {
  clinicId: string;
  conversationId: string;
  /** The coalesced burst, in arrival order. */
  messages: BufferedMessage[];
}

export interface TurnHandler {
  handleTurn(input: TurnInput): Promise<void>;
}

export const TURN_HANDLER = Symbol('TURN_HANDLER');

/**
 * Phase 1 default: observes, never replies. Deliberately silent — a canned
 * auto-reply wired by default could reach a real WhatsApp contact the moment
 * a channel is paired, before the real agent exists.
 */
@Injectable()
export class LoggingTurnHandler implements TurnHandler {
  private readonly logger = new Logger(LoggingTurnHandler.name);

  handleTurn(input: TurnInput): Promise<void> {
    // Message COUNT only — content in application logs violates iron rule #7.
    this.logger.log(
      `Turn: conversation=${input.conversationId} clinic=${input.clinicId} messages=${input.messages.length}`,
    );
    return Promise.resolve();
  }
}
