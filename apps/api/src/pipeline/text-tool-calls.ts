import type { ResponseItem } from './agent.ts';

/**
 * Tool calls a model wrote as reply TEXT instead of making a real call, e.g.
 * `<tool_call>{"wait_seconds":8,"question":"…"}</tool_call> Do you want …?`.
 * Some models fall back to this format now and then. Without this module the
 * markup is read out loud and the call is lost (2026-11-17: the Echo spoke the
 * JSON and did not keep listening for the answer).
 *
 * Text never runs a real tool: only `listen_for_reply` (which changes nothing
 * in the world) is honoured by the agent; every other call is dropped and logged.
 */

const TAGS = 'tool_call|function_call';
const BLOCK = new RegExp(`<(${TAGS})>([\\s\\S]*?)</\\1>`, 'gi');
/** A block that has started but not ended yet (streaming) or never ends. */
const OPEN_BLOCK = new RegExp(`<(?:${TAGS})>[\\s\\S]*$`, 'i');
const OPENING_TAGS = ['<tool_call>', '<function_call>'];

export type TextToolCall = {
  /** `null` when the block holds the arguments only, as in the 2026-11-17 case. */
  name: string | null;
  arguments: Record<string, unknown>;
};

/**
 * The text that may be spoken while the model is still writing: complete
 * blocks removed, an unfinished block and a half-written opening tag at the
 * end cut off. Applied to the final text it gives the same prefix, so audio
 * started early still matches the answer.
 */
export function speakableText(textSoFar: string): string {
  let text = textSoFar.replace(BLOCK, ' ').replace(OPEN_BLOCK, '');
  const tail = /<[a-z_]*$/i.exec(text);
  if (tail && OPENING_TAGS.some((tag) => tag.startsWith(tail[0].toLowerCase()))) {
    text = text.slice(0, tail.index);
  }
  return text;
}

/** The text without tool-call markup, and the calls that were in it. */
export function extractTextToolCalls(text: string): { text: string; calls: TextToolCall[] } {
  if (!/<(?:tool_call|function_call)>/i.test(text)) return { text, calls: [] };
  const calls: TextToolCall[] = [];
  for (const match of text.matchAll(BLOCK)) calls.push(parseBlock(match[2] ?? ''));
  const open = OPEN_BLOCK.exec(text.replace(BLOCK, ' '));
  if (open) calls.push(parseBlock(open[0].replace(/^<[^>]+>/, '')));
  const cleaned = text
    .replace(BLOCK, ' ')
    .replace(OPEN_BLOCK, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
  return { text: cleaned, calls };
}

function parseBlock(body: string): TextToolCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return { name: null, arguments: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { name: null, arguments: {} };
  const object = parsed as Record<string, unknown>;
  // `{"name": "...", "arguments": {...}}` (or a JSON string of them) is the common wrapped form.
  if (typeof object.name === 'string') {
    const inner = object.arguments ?? object.parameters ?? {};
    return { name: object.name, arguments: asObject(inner) };
  }
  return { name: null, arguments: object };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The model's output with tool-call markup removed from its message text, and
 * the calls found. The cleaned items are what gets spoken, shown and replayed
 * as history, so the model does not see (and copy) the format next turn.
 * Citations on a cleaned part are dropped: their offsets no longer fit.
 */
export function cleanOutput(output: ResponseItem[]): { output: ResponseItem[]; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  const cleaned = output.map((item) => {
    if (item.type !== 'message' || !Array.isArray(item.content)) return item;
    let changed = false;
    const content = (item.content as Record<string, unknown>[]).map((part) => {
      if (part.type !== 'output_text' || typeof part.text !== 'string') return part;
      const found = extractTextToolCalls(part.text);
      if (found.calls.length === 0 && found.text === part.text) return part;
      changed = true;
      calls.push(...found.calls);
      return { ...part, text: found.text, annotations: [] };
    });
    return changed ? { ...item, content } : item;
  });
  return { output: cleaned, calls };
}
