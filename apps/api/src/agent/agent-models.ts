// Model seam — SPEC §5 + DOCUMENTO-EXECUTIVO §5 (LLM tiering is the real
// unit economics): a cheap router (Haiku 4.5, $1/$5 per MTok) classifies and
// answers FAQ; the strong model (Opus 4.8, $5/$25) runs only the booking
// negotiation — the node where the money is. Behind a DI token so graph
// tests inject scripted fakes and never touch the network.
import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentToolDef } from './agent-tools';
import { UsageService } from './usage.service';

export interface AgentModels {
  /** False when ANTHROPIC_API_KEY is absent — turns are skipped, not failed. */
  readonly configured: boolean;
  invokeRouter(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage>;
  invokeFaq(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage>;
  invokeBooking(
    messages: BaseMessage[],
    tools: AgentToolDef[],
    config?: RunnableConfig,
  ): Promise<AIMessage>;
}

export const AGENT_MODELS = Symbol('AGENT_MODELS');

/** USD per MTok — used to estimate per-clinic cost cents (usage_counters). */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
};

export class AnthropicAgentModels implements AgentModels {
  readonly configured = true;
  private readonly router: ChatAnthropic;
  private readonly booking: ChatAnthropic;
  private readonly routerModel: string;
  private readonly bookingModel: string;

  constructor(
    params: { apiKey: string; routerModel: string; bookingModel: string },
    private readonly usage: UsageService,
  ) {
    this.routerModel = params.routerModel;
    this.bookingModel = params.bookingModel;
    // No temperature/top_p and no thinking config: Opus 4.8 rejects sampling
    // params (400), and thinking stays off for WhatsApp latency — the system
    // prompt carries a final-answer-only instruction instead (per the
    // Opus 4.8 migration guidance).
    this.router = new ChatAnthropic({
      apiKey: params.apiKey,
      model: params.routerModel,
      maxTokens: 1024,
    });
    this.booking = new ChatAnthropic({
      apiKey: params.apiKey,
      model: params.bookingModel,
      maxTokens: 1024,
    });
  }

  async invokeRouter(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage> {
    const response = await this.router.invoke(messages, config);
    await this.record(this.routerModel, response);
    return response;
  }

  async invokeFaq(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage> {
    // FAQ runs on the cheap tier by design (catalog answers don't need Opus).
    const response = await this.router.invoke(messages, config);
    await this.record(this.routerModel, response);
    return response;
  }

  async invokeBooking(
    messages: BaseMessage[],
    tools: AgentToolDef[],
    config?: RunnableConfig,
  ): Promise<AIMessage> {
    const bound = this.booking.bindTools(
      tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
    );
    const response = (await bound.invoke(messages, config)) as AIMessage;
    await this.record(this.bookingModel, response);
    return response;
  }

  /** Iron-rule-adjacent metering: every LLM call lands in usage_counters. */
  private async record(model: string, response: AIMessage): Promise<void> {
    const usage = response.usage_metadata;
    if (!usage) return;
    const price = PRICING[model] ?? { input: 5, output: 25 };
    const costCents = Math.ceil(
      ((usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000) * 100,
    );
    await this.usage
      .recordLlm(usage.input_tokens, usage.output_tokens, costCents)
      .catch(() => undefined); // metering must never fail a turn
  }
}

/** Dev fallback when no API key is configured: turns are skipped with a
 *  warning instead of crashing the worker into BullMQ retries. */
@Injectable()
export class UnconfiguredAgentModels implements AgentModels {
  readonly configured = false;
  private readonly logger = new Logger(UnconfiguredAgentModels.name);

  invokeRouter(): Promise<AIMessage> {
    return this.reject();
  }
  invokeFaq(): Promise<AIMessage> {
    return this.reject();
  }
  invokeBooking(): Promise<AIMessage> {
    return this.reject();
  }

  private reject(): Promise<AIMessage> {
    this.logger.error('ANTHROPIC_API_KEY not configured — agent invocation rejected');
    return Promise.reject(new Error('Agent models not configured (ANTHROPIC_API_KEY missing)'));
  }
}
