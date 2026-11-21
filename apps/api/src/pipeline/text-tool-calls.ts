import type { ResponseItem } from './agent.ts';

/**
 * Tool calls a model wrote as reply TEXT instead of making a real call, e.g.
 * `<tool_call>{"wait_seconds":8,"question":"…"}</tool_call> Do you want …?`.
 * Some models fall back to this format now and then. Without this module the
 * markup is read out loud and the call is lost (2026-11-17: the Echo spoke the
 * JSON and did not keep listening for the answer).
 *
 * A second format leaked on 2026-11-20 (a web /api/ask turn): the model wrote
 * `to=functions.<name>` followed by junk and a JSON object, interleaved with
 * the answer, and it looped one sentence four times:
 *
 *     …build and test. to=functions.runner__get_session 彩票平台招商
 *     {"session":"s_d6436q2q"} {"session":"s_d6436q2q"} to=functions.runner__get_session …
 *
 * Without this module the Echo would read the marker and the JSON out loud and
 * repeat the looped sentence. Here the marker segment (name + junk + JSON) is
 * removed, each call is recorded, and the repeated sentence is collapsed.
 *
 * Text never runs a real tool: only `listen_for_reply` (which changes nothing
 * in the world) is honoured by the agent; every other call is dropped and logged.
 */

const TAGS = 'tool_call|function_call';
const BLOCK = new RegExp(`<(${TAGS})>([\\s\\S]*?)</\\1>`, 'gi');
/** A block that has started but not ended yet (streaming) or never ends. */
const OPEN_BLOCK = new RegExp(`<(?:${TAGS})>[\\s\\S]*$`, 'i');
const OPENING_TAGS = ['<tool_call>', '<function_call>'];

/** The `to=functions.<name>` marker a model may write instead of a real call. */
const MARKER = 'to=functions.';
const MARKER_ESCAPED = MARKER.replace('.', '\\.');
/** A full marker plus its name, anywhere in a text (name runs to the next space). */
const MARKER_RE = new RegExp(`${MARKER_ESCAPED}(\\S+)`, 'g');
/** A marker that has started and runs to the end of the streaming text. */
const OPEN_MARKER = new RegExp(`${MARKER_ESCAPED}[\\s\\S]*$`);

export type TextToolCall = {
  /** `null` when the block holds the arguments only, as in the 2026-11-17 case. */
  name: string | null;
  arguments: Record<string, unknown>;
};

/**
 * The text that may be spoken while the model is still writing: complete
 * blocks and `to=functions.` markers removed, an unfinished block and a
 * half-written opening tag or marker at the end cut off. Applied to the final
 * text it gives the same prefix, so audio started early still matches the
 * answer.
 *
 * One deliberate exception: when a leak marker was found, extractTextToolCalls
 * also collapses sentences repeated back-to-back (the 2026-11-20 model looped
 * one four times). speakableText never collapses, so on a marker leak the
 * early `head` can contain a repeated sentence the final answer drops. That is
 * safe: earlyReply keys its early audio on the *first* sentence (which dedupe
 * always keeps), and take() then gives the rest from the deduped reply — see
 * voice-pipeline.ts. The audio already on its way is still correct; the only
 * difference is a repeated sentence that would otherwise be spoken twice.
 */
export function speakableText(textSoFar: string): string {
  let text = textSoFar.replace(BLOCK, ' ').replace(OPEN_BLOCK, '').replace(OPEN_MARKER, '');
  const tail = /<[a-z_]*$/i.exec(text);
  if (tail && OPENING_TAGS.some((tag) => tag.startsWith(tail[0].toLowerCase()))) {
    text = text.slice(0, tail.index);
  }
  return cutPartialMarker(text);
}

/**
 * A trailing half-written marker (`to=f`, `to=func`…) is cut off, the way the
 * half-written `<tool_` tag is above. Only prefixes of length 4 or more count:
 * `to` is an everyday word and `to=` alone is too common to be a marker.
 */
function cutPartialMarker(text: string): string {
  for (let length = MARKER.length - 1; length >= 4; length--) {
    if (text.endsWith(MARKER.slice(0, length))) return text.slice(0, text.length - length);
  }
  return text;
}

/** The text without tool-call markup, and the calls that were in it. */
export function extractTextToolCalls(text: string): { text: string; calls: TextToolCall[] } {
  if (!/<(?:tool_call|function_call)>/i.test(text) && !text.includes(MARKER)) {
    return { text, calls: [] };
  }
  const calls: TextToolCall[] = [];
  const block = extractBlockCalls(text);
  calls.push(...block.calls);
  const marker = extractMarkerCalls(block.text);
  calls.push(...marker.calls);
  let cleaned = normalize(marker.text);
  // The 2026-11-20 model looped a sentence: only collapse repeats when a leak
  // marker was actually found, so ordinary text is left untouched.
  if (text.includes(MARKER)) cleaned = collapseRepeatedSentences(cleaned);
  return { text: cleaned, calls };
}

/** Removes `<tool_call>`/`<function_call>` blocks and returns the calls in them. */
function extractBlockCalls(text: string): { text: string; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  for (const match of text.matchAll(BLOCK)) calls.push(parseBlock(match[2] ?? ''));
  const open = OPEN_BLOCK.exec(text.replace(BLOCK, ' '));
  if (open) calls.push(parseBlock(open[0].replace(/^<[^>]+>/, '')));
  return { text: text.replace(BLOCK, ' ').replace(OPEN_BLOCK, ''), calls };
}

/**
 * Removes `to=functions.<name>` segments and returns one call per marker. A
 * segment runs from the marker through the end of the JSON object(s) that
 * follow it (or the end of the line when there is none): the model put the
 * junk after the name on the marker's own line, then the JSON on later lines.
 */
function extractMarkerCalls(text: string): { text: string; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  const removed: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const start = match.index;
    const last = removed[removed.length - 1];
    // A marker written inside an earlier segment's junk is already gone.
    if (last && start < last.end) continue;
    const segment = markerSegment(text, start + match[0].length);
    removed.push({ start, end: segment.end });
    calls.push({ name: match[1] ?? '', arguments: segment.arguments });
  }
  if (removed.length === 0) return { text, calls };
  let cleaned = '';
  let from = 0;
  for (const segment of removed) {
    cleaned += text.slice(from, segment.start);
    from = segment.end;
  }
  return { text: cleaned + text.slice(from), calls };
}

/** The end of a marker's segment, and the first JSON object that follows it. */
function markerSegment(text: string, nameEnd: number): { end: number; arguments: Record<string, unknown> } {
  const newline = text.indexOf('\n', nameEnd);
  const lineEnd = newline === -1 ? text.length : newline;
  let end = lineEnd;
  let firstArgs: Record<string, unknown> = {};
  let position = skipWhitespace(text, lineEnd);
  let first = true;
  while (position < text.length && text.charAt(position) === '{') {
    const object = parseJsonObject(text, position);
    if (!object) break;
    if (first) {
      firstArgs = object.value;
      first = false;
    }
    end = object.end;
    position = skipWhitespace(text, object.end);
  }
  return { end, arguments: firstArgs };
}

/** The index after any whitespace starting at `from`. */
function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text.charAt(index))) index++;
  return index;
}

/** A balanced `{…}` object at `start`, parsed; or null when it does not parse. */
function parseJsonObject(
  text: string,
  start: number,
): { value: Record<string, unknown>; end: number } | null {
  if (text.charAt(start) !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return {
            value:
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {},
            end: index + 1,
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Collapses runs of whitespace to one space and trims. */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

/** Drops a sentence that is written again immediately after itself. */
function collapseRepeatedSentences(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return text;
  const kept: string[] = [];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (kept.length === 0 || trimmed !== kept[kept.length - 1]) kept.push(trimmed);
  }
  return kept.join(' ').trim();
}

/**
 * Splits on `.!?…` (plus any closing quotes/brackets) only when followed by
 * whitespace or the end, so `Node.js` and `3.14` are not cut in two. The
 * whitespace between sentences stays at the front of the next one and is
 * trimmed by the caller.
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const end = /[.!?…]["'”’»)\]]*(?=\s|$)/g;
  for (const match of text.matchAll(end)) {
    const next = match.index + match[0].length;
    sentences.push(text.slice(start, next));
    start = next;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
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
