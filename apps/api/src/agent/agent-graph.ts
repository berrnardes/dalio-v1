// The agent graph — SPEC §5: router (cheap model) → { book (strong model +
// tools) | answer (FAQ) | handoff | opt-out }. Built per turn as closures
// over the tenant context; turns run to completion, so the durable state is
// the messages table + flowContext, not a graph checkpointer (deliberate
// divergence from the original SPEC — noted there; checkpointing joins if
// interrupts/HITL ever do).
import { Logger } from '@nestjs/common';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { OutboundIntent } from '@dalio/shared';
import type { AgentModels } from './agent-models';
import type { AgentToolDef } from './agent-tools';
import {
  OPT_OUT_REPLY,
  ROUTER_SYSTEM_PROMPT,
  handoffReply,
  parseRouterIntent,
} from './agent-prompts';
import type { RouterIntent } from './agent-prompts';

const logger = new Logger('AgentGraph');

/** Hard bound on the tool loop: a model stuck re-calling tools must hand off
 *  gracefully, not burn tokens forever (the lock TTL is also watching). */
const MAX_TOOL_ROUNDS = 6;

export interface AgentGraphDeps {
  models: AgentModels;
  tools: AgentToolDef[];
  systemPrompt: string;
  /** Decides the honest handoff message (DOCUMENTO-EXECUTIVO §3.4: out of
   *  hours there is no human — say so and keep doing what the agent CAN do). */
  isOpen: boolean;
  /** Pauses the conversation for the human team. Reason lands in logs only. */
  onHandoff(reason: string): Promise<void>;
  /** Stamps contacts.optOutAt — mechanical LGPD enforcement (iron rule #4). */
  onOptOut(): Promise<void>;
}

export interface AgentTurnOutput {
  intent: RouterIntent;
  replies: OutboundIntent[];
}

const AgentState = Annotation.Root({
  intent: Annotation<RouterIntent>({ reducer: (_a, b) => b, default: () => 'faq' }),
  replies: Annotation<OutboundIntent[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

/** LangChain message content can be a string or content blocks. */
function textOf(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export async function runAgentGraph(
  deps: AgentGraphDeps,
  history: BaseMessage[],
  userText: string,
  config?: RunnableConfig,
): Promise<AgentTurnOutput> {
  const userTurn = new HumanMessage(userText);

  const graph = new StateGraph(AgentState)
    .addNode('router', async () => {
      const response = await deps.models.invokeRouter(
        [new SystemMessage(ROUTER_SYSTEM_PROMPT), ...history, userTurn],
        config,
      );
      return { intent: parseRouterIntent(textOf(response)) };
    })
    .addNode('answer', async () => {
      const response = await deps.models.invokeFaq(
        [new SystemMessage(deps.systemPrompt), ...history, userTurn],
        config,
      );
      const text = textOf(response).trim();
      return { replies: text ? [{ kind: 'text' as const, text }] : [] };
    })
    .addNode('book', async () => {
      // Hand-rolled tool loop (not prebuilt ToolNode): explicit control over
      // rounds, error-to-string conversion, and trivially fakeable in tests.
      const messages: BaseMessage[] = [
        new SystemMessage(deps.systemPrompt),
        ...history,
        userTurn,
      ];
      const toolMap = new Map(deps.tools.map((t) => [t.name, t]));

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await deps.models.invokeBooking(messages, deps.tools, config);
        const toolCalls = (response as AIMessage).tool_calls ?? [];

        if (toolCalls.length === 0) {
          const text = textOf(response).trim();
          return { replies: text ? [{ kind: 'text' as const, text }] : [] };
        }

        messages.push(response);
        for (const call of toolCalls) {
          const tool = toolMap.get(call.name);
          const result = tool
            ? await tool.execute(call.args).catch((err: Error) => `Erro na ferramenta: ${err.message}`)
            : `Ferramenta desconhecida: ${call.name}`;
          messages.push(new ToolMessage({ content: result, tool_call_id: call.id ?? call.name }));
        }
      }

      // Loop exhausted — never strand the contact silently.
      logger.warn('Booking tool loop exhausted — handing off');
      await deps.onHandoff('tool_loop_exhausted');
      return { replies: [{ kind: 'text' as const, text: handoffReply({ open: deps.isOpen, medical: false }) }] };
    })
    .addNode('handoff', async (state) => {
      await deps.onHandoff(state.intent);
      return {
        replies: [
          { kind: 'text' as const, text: handoffReply({ open: deps.isOpen, medical: state.intent === 'medical' }) },
        ],
      };
    })
    .addNode('optout', async () => {
      await deps.onOptOut();
      return { replies: [{ kind: 'text' as const, text: OPT_OUT_REPLY }] };
    })
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state) => {
      switch (state.intent) {
        case 'booking':
          return 'book';
        case 'medical': // guardrail: mandatory handoff route (SPEC §5)
        case 'human':
          return 'handoff';
        case 'opt_out':
          return 'optout';
        default:
          return 'answer';
      }
    })
    .addEdge('answer', END)
    .addEdge('book', END)
    .addEdge('handoff', END)
    .addEdge('optout', END)
    .compile();

  const result = await graph.invoke({}, config);
  return { intent: result.intent, replies: result.replies };
}
