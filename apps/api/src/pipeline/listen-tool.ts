import type { Settings } from '@cortecho/shared';
import type { FunctionToolDefinition } from '../tools/registry.ts';

/**
 * `listen_for_reply`: the model's explicit way to keep the Echo listening
 * after its reply (INTENT_END with continue_conversation=1), instead of the
 * old guess from a trailing "?". It is built into the agent rather than a
 * ToolRegistry plugin because it changes nothing in the world and must not
 * cost a model round trip: when the model writes its reply and calls this in
 * the same response, that response is the answer (pipeline/agent.ts).
 */
export const LISTEN_TOOL_NAME = 'listen_for_reply';

export type ListenToolOptions = {
  /** Used when the model leaves out wait_seconds. */
  defaultWaitMs: number;
  minWaitMs: number;
  /** hassmic gives up after 30 s of listening (PIPELINE_TIMEOUT), so this stays well below. */
  maxWaitMs: number;
};

/**
 * The tool's settings, or undefined when FOLLOW_UP_MODE is not `tool` (then
 * the model is not offered the tool or told about it). Without wait_seconds
 * the wait is the usual no-speech timeout, within the bounds.
 */
export function listenToolOptions(settings: Settings): ListenToolOptions | undefined {
  const { followUp } = settings;
  if (followUp.mode !== 'tool') return undefined;
  return {
    defaultWaitMs: Math.min(followUp.maxWaitMs, Math.max(followUp.minWaitMs, settings.vad.noSpeechTimeoutMs)),
    minWaitMs: followUp.minWaitMs,
    maxWaitMs: followUp.maxWaitMs,
  };
}

/** What the model asked for: the Echo listens this long for the user to start talking. */
export type ListenRequest = { waitMs: number };

export function listenToolDefinition({ minWaitMs, maxWaitMs }: ListenToolOptions): FunctionToolDefinition {
  return {
    type: 'function',
    name: LISTEN_TOOL_NAME,
    description:
      'Keep the microphone open after your spoken reply, so the user can answer without the wake word. ' +
      'Call it in the same response as your reply text, only when the reply asks something you need answered.',
    parameters: {
      type: 'object',
      properties: {
        wait_seconds: {
          type: 'integer',
          minimum: Math.ceil(minWaitMs / 1000),
          maximum: Math.floor(maxWaitMs / 1000),
          description: 'How long to wait for the user to start answering.',
        },
        question: {
          type: 'string',
          description: 'Only if you wrote no reply text: the question to speak, as plain spoken words.',
        },
      },
      required: ['wait_seconds'],
      additionalProperties: false,
    },
    strict: false,
  };
}

/**
 * The Echo's interaction model, for the instructions. It lives here, next to
 * the tool, so the prompt can never describe a tool that is not offered.
 */
export function listenPolicy({ minWaitMs, maxWaitMs }: ListenToolOptions): string {
  const min = Math.ceil(minWaitMs / 1000);
  const max = Math.floor(maxWaitMs / 1000);
  return [
    'How the speaker works: the user says the wake word, the light ring turns on and the microphone listens until they stop talking, then your reply is spoken.',
    `After your reply the ring goes off and the microphone stays closed, so the user would have to say the wake word again, unless you call ${LISTEN_TOOL_NAME}.`,
    `Call ${LISTEN_TOOL_NAME} whenever your reply needs an answer from the user: a clarifying question, a choice between options, or an offer they would answer with yes or no.`,
    'Call it in the same response as your reply text, never in a response of its own, and make the question the last sentence of your reply.',
    'Do not call it after a complete answer, a statement or a confirmation that something was done, and do not end such replies with a question just to keep talking.',
    `Choose wait_seconds (${min} to ${max}) by how long the user needs before they start answering: about 5 for yes or no, about 8 to pick one of the options you named or give a short fact, up to ${max} when they have to think, look something up or decide.`,
    'If they say nothing in that time, the speaker stops listening quietly.',
  ].join(' ');
}

/** Turns the model's arguments into a wait, clamped to the allowed range. Never throws. */
export function parseListenArguments(
  argumentsJson: string,
  { defaultWaitMs, minWaitMs, maxWaitMs }: ListenToolOptions,
): ListenRequest & { question: string } {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      args = parsed as Record<string, unknown>;
  } catch {
    // A malformed call still means "listen": the default wait is the safe reading.
  }
  const seconds = Number(args.wait_seconds);
  const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : defaultWaitMs;
  return {
    waitMs: Math.min(maxWaitMs, Math.max(minWaitMs, waitMs)),
    question: typeof args.question === 'string' ? args.question.trim() : '',
  };
}
