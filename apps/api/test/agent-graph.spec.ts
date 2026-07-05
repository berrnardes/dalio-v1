// Agent graph regression set — SPEC §5 flows with scripted fake models (no
// network, no tokens). These are the Phase 2 "conjunto de avaliação" for
// FLOW logic: routing, the mandatory medical handoff, the tool loop, and
// opt-out. Real-LLM quality evals are a separate, key-gated concern.
import { describe, expect, it } from 'vitest';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentModels } from '../src/agent/agent-models';
import type { AgentToolDef } from '../src/agent/agent-tools';
import { runAgentGraph } from '../src/agent/agent-graph';
import type { AgentGraphDeps } from '../src/agent/agent-graph';
import { OPT_OUT_REPLY, parseRouterIntent } from '../src/agent/agent-prompts';
import { z } from 'zod';

class FakeModels implements AgentModels {
  readonly configured = true;
  bookingCallMessages: BaseMessage[][] = [];
  faqCalls = 0;

  constructor(
    private readonly script: {
      routerText?: string;
      faqText?: string;
      bookingResponses?: AIMessage[];
    },
  ) {}

  invokeRouter(): Promise<AIMessage> {
    return Promise.resolve(new AIMessage(this.script.routerText ?? '{"intent":"faq"}'));
  }
  invokeFaq(): Promise<AIMessage> {
    this.faqCalls += 1;
    return Promise.resolve(new AIMessage(this.script.faqText ?? 'resposta faq'));
  }
  invokeBooking(messages: BaseMessage[]): Promise<AIMessage> {
    this.bookingCallMessages.push([...messages]);
    const next = this.script.bookingResponses?.shift();
    if (!next) throw new Error('FakeModels: booking script exhausted');
    return Promise.resolve(next);
  }
}

const slotsTool = (result: string): AgentToolDef => ({
  name: 'get_available_slots',
  description: 'slots',
  schema: z.object({ serviceId: z.string(), date: z.string() }),
  execute: () => Promise.resolve(result),
});

function makeDeps(models: AgentModels, tools: AgentToolDef[] = []) {
  const calls = { handoff: [] as string[], optOut: 0 };
  const deps: AgentGraphDeps = {
    models,
    tools,
    systemPrompt: 'system',
    isOpen: true,
    onHandoff: (reason) => {
      calls.handoff.push(reason);
      return Promise.resolve();
    },
    onOptOut: () => {
      calls.optOut += 1;
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

describe('agent graph routing', () => {
  it('faq intent answers with the cheap tier and never touches booking', async () => {
    const models = new FakeModels({ routerText: '{"intent":"faq"}', faqText: 'Custa R$ 180!' });
    const { deps, calls } = makeDeps(models);
    const result = await runAgentGraph(deps, [], 'quanto custa a limpeza?');
    expect(result.intent).toBe('faq');
    expect(result.replies).toEqual([{ kind: 'text', text: 'Custa R$ 180!' }]);
    expect(models.bookingCallMessages).toHaveLength(0);
    expect(calls.handoff).toHaveLength(0);
  });

  it('medical intent is a MANDATORY handoff — no model ever answers it', async () => {
    const models = new FakeModels({ routerText: '{"intent":"medical"}' });
    const { deps, calls } = makeDeps(models);
    const result = await runAgentGraph(deps, [], 'posso fazer botox amamentando?');
    expect(calls.handoff).toEqual(['medical']);
    expect(models.faqCalls).toBe(0);
    expect(models.bookingCallMessages).toHaveLength(0);
    expect(result.replies[0]!.kind).toBe('text');
    expect((result.replies[0] as { text: string }).text).toContain('equipe');
  });

  it('human request pauses the conversation for the team', async () => {
    const models = new FakeModels({ routerText: '{"intent":"human"}' });
    const { deps, calls } = makeDeps(models);
    await runAgentGraph(deps, [], 'quero falar com uma atendente');
    expect(calls.handoff).toEqual(['human']);
  });

  it('opt_out intent registers the opt-out and confirms', async () => {
    const models = new FakeModels({ routerText: '{"intent":"opt_out"}' });
    const { deps, calls } = makeDeps(models);
    const result = await runAgentGraph(deps, [], 'quero parar de receber isso');
    expect(calls.optOut).toBe(1);
    expect(result.replies).toEqual([{ kind: 'text', text: OPT_OUT_REPLY }]);
  });
});

describe('agent graph booking tool loop', () => {
  it('executes tool calls, feeds results back, and returns the final text', async () => {
    const models = new FakeModels({
      routerText: '{"intent":"booking"}',
      bookingResponses: [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'get_available_slots',
              args: { serviceId: 's1', date: '2100-01-04' },
              id: 'call-1',
              type: 'tool_call',
            },
          ],
        }),
        new AIMessage('Tenho 9h ou 11h — qual prefere?'),
      ],
    });
    const { deps } = makeDeps(models, [slotsTool('SLOTS-RESULT')]);
    const result = await runAgentGraph(deps, [], 'quero agendar limpeza segunda');

    expect(result.replies).toEqual([{ kind: 'text', text: 'Tenho 9h ou 11h — qual prefere?' }]);
    // Second model call must carry the ToolMessage with the tool's result.
    const secondCall = models.bookingCallMessages[1]!;
    const toolMsg = secondCall.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe('SLOTS-RESULT');
    expect(toolMsg.tool_call_id).toBe('call-1');
  });

  it('an unknown tool name returns an honest error result, not a crash', async () => {
    const models = new FakeModels({
      routerText: '{"intent":"booking"}',
      bookingResponses: [
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'nope', args: {}, id: 'call-x', type: 'tool_call' }],
        }),
        new AIMessage('desculpe, vou verificar'),
      ],
    });
    const { deps } = makeDeps(models, []);
    await runAgentGraph(deps, [], 'agendar');
    const toolMsg = models.bookingCallMessages[1]!.find(
      (m) => m instanceof ToolMessage,
    ) as ToolMessage;
    expect(String(toolMsg.content)).toContain('Ferramenta desconhecida');
  });

  it('an exhausted tool loop hands off instead of stranding the contact', async () => {
    const loopingCall = () =>
      new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_available_slots', args: { serviceId: 's', date: 'd' }, id: 'c', type: 'tool_call' },
        ],
      });
    const models = new FakeModels({
      routerText: '{"intent":"booking"}',
      bookingResponses: Array.from({ length: 8 }, loopingCall),
    });
    const { deps, calls } = makeDeps(models, [slotsTool('x')]);
    const result = await runAgentGraph(deps, [], 'agendar');
    expect(calls.handoff).toEqual(['tool_loop_exhausted']);
    expect(result.replies).toHaveLength(1);
    expect(models.bookingCallMessages.length).toBeLessThanOrEqual(6);
  });
});

describe('parseRouterIntent', () => {
  it.each([
    ['{"intent":"booking"}', 'booking'],
    ['Claro! {"intent":"medical"} aqui está', 'medical'],
    ['sem json nenhum', 'faq'],
    ['{"intent":"invented"}', 'faq'],
    ['{}', 'faq'],
  ])('parses %s → %s (unparseable degrades to safe faq)', (text, expected) => {
    expect(parseRouterIntent(text)).toBe(expected);
  });
});
