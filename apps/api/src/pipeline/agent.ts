import type { Settings, ToolCallRecord } from '@cortecho/shared';
import { createLogger } from '../lib/logger.ts';
import type { FunctionToolDefinition, ToolRegistry } from '../tools/registry.ts';
import type { AgentSession } from './agent-sessions.ts';
import {
  LISTEN_TOOL_NAME,
  type ListenRequest,
  type ListenToolOptions,
  listenToolDefinition,
  listenToolOptions,
  parseListenArguments,
} from './listen-tool.ts';
import { buildInstructions } from './prompt-layers.ts';
import { answerWithCitations } from './search-answer.ts';
import type { Agent, AgentContext, AgentReply } from './services.ts';
import { cleanOutput, speakableText, type TextToolCall } from './text-tool-calls.ts';

const log = createLogger('agent');

/**
 * The slice of the Responses API this agent uses. Typed loosely on purpose:
 * the SDK's types are huge and change often, and tests pass a fake.
 */
export type ResponseItem = Record<string, unknown> & { type?: string };

export type CreateResponseRequest = {
  model: string;
  instructions: string;
  input: ResponseItem[];
  tools: (FunctionToolDefinition | { type: 'web_search'; search_context_size: 'low'; name?: never })[];
  tool_choice?: 'auto';
  max_output_tokens: number;
  store: false;
  include?: string[];
  reasoning?: { effort: string };
};

export type CreateResponseResult = {
  status?: string;
  output: ResponseItem[];
  output_text?: string;
  searchDurations?: Record<string, number>;
};

/** `onTextDelta` gets each piece of answer text as the model writes it. */
export type CreateResponse = (
  request: CreateResponseRequest,
  signal: AbortSignal,
  onTextDelta: ((delta: string) => void) | undefined,
  /** The turn's snapshot: model, key and timeout come from it. */
  settings: Settings,
) => Promise<CreateResponseResult>;

export type ResponsesAgentOptions = {
  createResponse: CreateResponse;
  tools: ToolRegistry;
  now?: () => number;
};

/**
 * A spoken-assistant agent on the OpenAI Responses API with function calling.
 *
 * - `store: false`: nothing is kept on OpenAI's side. The conversation lives
 *   in the session and is replayed on every request, including reasoning
 *   items (with `reasoning.encrypted_content`) so reasoning models keep their
 *   context across tool calls.
 * - Memory, its idle expiry and the session key live in AgentSessions; this
 *   class is stateless between calls.
 * - Every user message comes with the current date and time, so "what time
 *   is it" needs no tool call (a second model request, 1.5 to 2.5 s). It is a
 *   message of its own and not part of the instructions, so the start of the
 *   prompt stays the same from turn to turn.
 * - Tool calls of one round run at the same time.
 * - `listen_for_reply` is answered here, not by the registry. A response
 *   whose only calls are to it is the final answer (no second round): its
 *   text, or the call's `question` when the model wrote none.
 */
export class ResponsesAgent implements Agent {
  private readonly options: ResponsesAgentOptions;

  constructor(options: ResponsesAgentOptions) {
    this.options = options;
  }

  reset(session: AgentSession): void {
    session.history = [];
  }

  async reply(
    text: string,
    signal: AbortSignal,
    onText: ((textSoFar: string) => void) | undefined,
    context: AgentContext,
  ): Promise<AgentReply> {
    const { createResponse, tools } = this.options;
    const { settings, session, device } = context;
    const now = this.options.now ?? Date.now;
    const listenTool = listenToolOptions(settings);
    const toolSet = context.toolSet ?? tools.snapshot({ settings, deviceId: context.deviceId ?? null });
    const turnNumber = (session.turnSeq ?? 0) + 1;
    session.turnSeq = turnNumber;
    // Confirm-by-voice troubleshooting: is a yes from this turn expected to run something?
    const pending = session.pendingAction;
    if (pending) {
      const leftS = Math.round((pending.expiresAt - now()) / 1000);
      log.info(`turn ${turnNumber}: an action waits for a spoken yes`, {
        tool: pending.exposedName,
        fromTurn: pending.createdTurn,
        ...(leftS >= 0 ? { expiresInS: leftS } : { expiredSAgo: -leftS }),
      });
    }
    const instructions = buildInstructions({
      settings,
      listenTool,
      device,
      connectors: toolSet.connectors(),
      hasConfirmTools: toolSet.hasConfirmTools(),
    });

    const input: ResponseItem[] = [
      ...session.history,
      { role: 'developer', content: `Current local date and time: ${this.localTime(now(), settings)}.` },
      { role: 'user', content: text },
    ];
    const toolCalls: ToolCallRecord[] = [];
    // Once asked for, listening holds for the turn's final answer, even when
    // the call came in a round with other tools.
    let listen: ListenRequest | null = null;

    for (let round = 0; round <= settings.agent.maxToolRounds; round++) {
      // On the last round tools are withheld, so the model has to answer.
      const offerTools = round < settings.agent.maxToolRounds;
      let written = '';
      const response = await createResponse(
        {
          model: settings.agent.model,
          instructions,
          input,
          tools: offerTools
            ? [
                ...toolSet.definitions(),
                ...(listenTool ? [listenToolDefinition(listenTool)] : []),
                ...(settings.agent.webSearch
                  ? [{ type: 'web_search' as const, search_context_size: 'low' as const }]
                  : []),
              ]
            : [],
          tool_choice: 'auto',
          max_output_tokens: settings.agent.maxOutputTokens,
          store: false,
          ...(settings.agent.reasoningEffort === 'default'
            ? {}
            : { reasoning: { effort: settings.agent.reasoningEffort } }),
          include: ['reasoning.encrypted_content'],
        },
        signal,
        onText &&
          (toolCalls.some((call) => call.name === 'web_search')
            ? undefined
            : (delta) => {
                written += delta;
                onText(speakableText(written));
              }),
        settings,
      );

      if (response.status && response.status !== 'completed') {
        throw new Error(`Response ended with status "${response.status}"`);
      }
      // Tool calls written as text are never spoken, shown or replayed.
      const cleaned = cleanOutput(response.output);
      const output = cleaned.output;

      for (const item of output.filter((item) => item.type === 'web_search_call')) {
        toolCalls.push({
          name: 'web_search',
          arguments: JSON.stringify(item.action ?? {}),
          result: String(item.status ?? 'unknown'),
          ok: item.status === 'completed',
          durationMs: response.searchDurations?.[String(item.id)] ?? 0,
        });
      }
      input.push(...output.map(toInputItem));
      const allCalls = output.filter((item) => item.type === 'function_call');
      // Without listenTool the tool is not offered; a call to it then goes to
      // the registry like any unknown name and comes back as an error.
      const isListen = (call: ResponseItem) => listenTool !== undefined && call.name === LISTEN_TOOL_NAME;
      const listenCalls = allCalls.filter(isListen);
      const calls = allCalls.filter((call) => !isListen(call));

      let listenQuestion = '';
      for (const textCall of cleaned.calls) {
        const asListen = this.textListen(textCall, listenTool);
        if (asListen) {
          listen = { waitMs: asListen.waitMs };
          listenQuestion ||= asListen.question;
        }
        toolCalls.push({
          name: textCall.name ?? (asListen ? LISTEN_TOOL_NAME : 'unknown'),
          arguments: JSON.stringify(textCall.arguments),
          result: asListen
            ? `written as text; listening ${Math.round(asListen.waitMs / 1000)} s after the reply`
            : 'error: written as text, not run',
          ok: asListen !== null,
          durationMs: 0,
        });
      }
      for (const call of listenCalls) {
        const args = String(call.arguments ?? '{}');
        const parsed = parseListenArguments(args, listenTool as ListenToolOptions);
        listen = { waitMs: parsed.waitMs };
        listenQuestion ||= parsed.question;
        log.info(`model asked to listen for ${parsed.waitMs} ms`);
        toolCalls.push({
          name: LISTEN_TOOL_NAME,
          arguments: args,
          result: `listening ${Math.round(parsed.waitMs / 1000)} s after the reply`,
          ok: true,
          durationMs: 0,
        });
        // With store:false every function_call needs its output in the replayed history.
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: 'The microphone opens after your reply is spoken.',
        });
      }

      if (calls.length === 0) {
        const written = (
          cleaned.calls.length > 0 ? extractText(output) : (response.output_text ?? extractText(output))
        ).trim();
        const reply = written || listenQuestion;
        // Only a listen call and no words at all: one more round for the reply text.
        if (!reply && listenCalls.length > 0) continue;
        session.history = input;
        return {
          ...(written ? answerWithCitations(written, output) : { text: reply }),
          toolCalls,
          ...(listen ? { listen } : {}),
        };
      }

      log.debug(`turn ${turnNumber} round ${round}: ${calls.length} tool call(s)`, {
        tools: calls.map((call) => String(call.name)),
      });
      // tools.call never throws, so one failing tool does not stop the others.
      const records = await Promise.all(
        calls.map((call) =>
          toolSet.call(String(call.name), String(call.arguments ?? '{}'), {
            signal,
            session,
            turnNumber,
            deadlineAtMs: context.deadlineAtMs ?? null,
            deviceId: context.deviceId ?? null,
          }),
        ),
      );
      for (const [index, record] of records.entries()) {
        // "pending" is not a success: the tool did not run (confirm-by-voice).
        const status = record.pending
          ? 'pending (waits for a spoken yes, not run)'
          : record.ok
            ? 'ok'
            : 'failed';
        log.info(`tool ${record.name} ${status} in ${record.durationMs} ms`, { turn: turnNumber, round });
        if (!record.ok) log.debug(`tool ${record.name} error`, { result: record.result.slice(0, 300) });
        toolCalls.push({
          name: record.name,
          arguments: record.arguments,
          result: record.result,
          ok: record.ok,
          durationMs: record.durationMs,
          ...(record.server ? { server: record.server } : {}),
          ...(record.pending ? { pending: true } : {}),
        });
        input.push({ type: 'function_call_output', call_id: calls[index]?.call_id, output: record.output });
      }
    }

    throw new Error(`No answer after ${settings.agent.maxToolRounds} tool rounds`);
  }

  /**
   * A listen call the model wrote as text: `listen_for_reply` by name, or a
   * bare `{wait_seconds, question}` object. Anything else is logged and dropped.
   */
  private textListen(
    call: TextToolCall,
    listenTool: ListenToolOptions | undefined,
  ): (ListenRequest & { question: string }) | null {
    const looksLikeListen =
      call.name === LISTEN_TOOL_NAME ||
      (call.name === null && ('wait_seconds' in call.arguments || 'question' in call.arguments));
    if (!looksLikeListen || !listenTool) {
      log.warn(`model wrote a tool call as text; dropped (not run)`, {
        tool: call.name ?? 'unnamed',
        keys: Object.keys(call.arguments),
      });
      return null;
    }
    const parsed = parseListenArguments(JSON.stringify(call.arguments), listenTool);
    log.warn(`model wrote ${LISTEN_TOOL_NAME} as text; treated as a call, listening ${parsed.waitMs} ms`);
    return parsed;
  }

  private localTime(nowMs: number, settings: Settings): string {
    const { locale, timeZone } = settings.assistant;
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(nowMs));
  }
}

/**
 * Output items go back into `input` unchanged, minus read-only fields the
 * API rejects on input (`status` on messages and function calls is fine to
 * omit; `id` of unstored items must be dropped with store:false).
 */
function toInputItem(item: ResponseItem): ResponseItem {
  const { id: _id, status: _status, ...rest } = item;
  // Reasoning items must keep their id to pair with encrypted_content.
  if (item.type === 'reasoning') return { ...rest, id: item.id };
  return rest;
}

function extractText(output: ResponseItem[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[]) {
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      if (part.type === 'refusal' && typeof part.refusal === 'string') parts.push(part.refusal);
    }
  }
  return parts.join(' ');
}
