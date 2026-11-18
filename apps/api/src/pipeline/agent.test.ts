import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import { describe, expect, it } from 'vitest';
import { echoTestTool } from '../tools/plugins/echo-test.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { type CreateResponse, type CreateResponseRequest, ResponsesAgent } from './agent.ts';
import { AgentSessions } from './agent-sessions.ts';

type FakeResponse = Awaited<ReturnType<CreateResponse>> & { deltas?: string[] };

function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  return buildSettings({
    ...DEFAULT_SETTINGS,
    'agent.model': 'test-model',
    'agent.maxOutputTokens': 100,
    'agent.maxToolRounds': 2,
    'agent.webSearch': false,
    'followUp.mode': 'never',
    'assistant.locale': 'en-GB',
    'assistant.timeZone': 'UTC',
    'assistant.sessionIdleMinutes': 1,
    ...overrides,
  });
}

function makeAgent(responses: FakeResponse[], now = () => 0, overrides: Record<string, unknown> = {}) {
  const requests: CreateResponseRequest[] = [];
  const settings = makeSettings(overrides);
  const sessions = new AgentSessions();
  const createResponse: CreateResponse = async (request, _signal, onTextDelta) => {
    requests.push(structuredClone(request));
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    for (const delta of next.deltas ?? []) onTextDelta?.(delta);
    return next;
  };
  const agent = new ResponsesAgent({
    createResponse,
    tools: new ToolRegistry().register(echoTestTool()),
    now,
  });
  /** One call with a fresh (or shared) session, as the pipeline does it. */
  const reply = (text: string, signal: AbortSignal, onText?: (textSoFar: string) => void) => {
    const session = sessions.get('test', settings.assistant.sessionIdleMinutes * 60_000, now());
    return agent.reply(text, signal, onText, { settings, session });
  };
  return { agent, reply, requests, settings };
}

const message = (text: string) => ({
  status: 'completed',
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] }],
});

const signal = new AbortController().signal;

describe('ResponsesAgent', () => {
  it('answers directly when no tool is needed', async () => {
    const { reply, requests } = makeAgent([message('Hello there.')]);
    expect(await reply('hi', signal)).toEqual({ text: 'Hello there.', toolCalls: [] });
    expect(requests[0]).toMatchObject({
      model: 'test-model',
      store: false,
      input: [
        { role: 'developer', content: 'Current local date and time: Thursday, 1 January 1970 at 00:00.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(['echo_test']);
  });

  it('runs a tool call and sends its output back', async () => {
    const { reply, requests } = makeAgent([
      {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'echo_test',
            arguments: '{"text":"ping"}',
          },
        ],
      },
      message('It said ping.'),
    ]);
    const answer = await reply('test the tools', signal);
    expect(answer.text).toBe('It said ping.');
    expect(answer.toolCalls).toEqual([expect.objectContaining({ name: 'echo_test', ok: true })]);
    expect(requests[1]?.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"echoed":"ping"}',
    });
  });

  it('withholds tools on the last round so the model must answer', async () => {
    const call = {
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'c', name: 'echo_test', arguments: '{}' }],
    };
    const { reply, requests } = makeAgent([call, call, message('Done.')]);
    await reply('loop', signal);
    expect(requests.map((r) => r.tools.length)).toEqual([1, 1, 0]);
  });

  it('keeps memory between turns and forgets it after the idle time', async () => {
    let clock = 0;
    const { reply, requests } = makeAgent([message('A'), message('B'), message('C')], () => clock);
    await reply('first', signal);
    clock = 30_000;
    await reply('second', signal);
    expect(requests[1]?.input.map((i) => i.content ?? i.type)).toContainEqual('first');
    clock = 200_000;
    await reply('third', signal);
    expect(requests[2]?.input.map((i) => i.role)).toEqual(['developer', 'user']);
    expect(requests[2]?.input[1]).toEqual({ role: 'user', content: 'third' });
  });

  it('reports the text while it is written, starting again after a tool round', async () => {
    const { reply } = makeAgent([
      {
        status: 'completed',
        deltas: ['Let me ', 'check.'],
        output: [{ type: 'function_call', call_id: 'c', name: 'echo_test', arguments: '{"text":"x"}' }],
      },
      { ...message('It said x. Anything else?'), deltas: ['It said x.', ' Anything else?'] },
    ]);
    const seen: string[] = [];
    await reply('test', signal, (textSoFar) => seen.push(textSoFar));
    expect(seen).toEqual(['Let me ', 'Let me check.', 'It said x.', 'It said x. Anything else?']);
  });

  it('runs the tool calls of one round at the same time and keeps their order', async () => {
    const running: string[] = [];
    const slow = (name: string, ms: number) => ({
      name,
      description: name,
      parameters: { type: 'object' as const, properties: {} },
      handler: async () => {
        running.push(name);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { name, startedWith: [...running] };
      },
    });
    const requests: CreateResponseRequest[] = [];
    const responses: FakeResponse[] = [
      {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'c1', name: 'slow_one', arguments: '{}' },
          { type: 'function_call', call_id: 'c2', name: 'slow_two', arguments: '{}' },
        ],
      },
      message('Both done.'),
    ];
    const settings = makeSettings();
    const session = { history: [], lastTurnAt: 0 };
    const agent = new ResponsesAgent({
      createResponse: async (request) => {
        requests.push(structuredClone(request));
        return responses.shift() as FakeResponse;
      },
      tools: new ToolRegistry().register(slow('slow_one', 40)).register(slow('slow_two', 5)),
    });
    const answer = await agent.reply('do both', signal, undefined, { settings, session });
    expect(answer.toolCalls.map((c) => c.name)).toEqual(['slow_one', 'slow_two']);
    const outputs = requests[1]?.input.filter((i) => i.type === 'function_call_output');
    expect(outputs?.map((o) => o.call_id)).toEqual(['c1', 'c2']);
    // The second tool started before the first one had finished.
    expect(String(outputs?.[0]?.output)).toContain('"startedWith":["slow_one","slow_two"]');
  });

  it('leaves the memory untouched when a turn fails', async () => {
    const { reply, requests } = makeAgent([message('A'), { status: 'incomplete', output: [] }, message('C')]);
    await reply('one', signal);
    await expect(reply('two', signal)).rejects.toThrow(/incomplete/);
    await reply('three', signal);
    const contents = requests[2]?.input.map((i) => i.content).filter(Boolean);
    expect(contents).not.toContain('two');
  });
});

describe('hosted web search', () => {
  it('offers optional search, records multiple actions and replays them alongside local tools', async () => {
    const requests: CreateResponseRequest[] = [];
    const outputs = [
      {
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            id: 'ws1',
            status: 'completed',
            action: { type: 'search', query: 'news' },
          },
          { type: 'function_call', call_id: 'local', name: 'echo_test', arguments: '{}' },
        ],
        searchDurations: { ws1: 32 },
      },
      {
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            id: 'ws2',
            status: 'completed',
            action: { type: 'search', query: 'more news' },
          },
          ...message('Found it.').output,
        ],
      },
      message('Welcome.'),
    ];
    const settings = makeSettings({
      'assistant.householdPrompt': 'Custom instruction.',
      'agent.webSearch': true,
    });
    const session = { history: [], lastTurnAt: 0 };
    const agent = new ResponsesAgent({
      createResponse: async (request) => {
        requests.push(structuredClone(request));
        const next = outputs.shift();
        if (!next) throw new Error('No fake response');
        return next;
      },
      tools: new ToolRegistry().register(echoTestTool()),
    });
    const answer = await agent.reply('Search the news', signal, undefined, { settings, session });
    expect(answer.toolCalls.map((call) => call.name)).toEqual(['web_search', 'echo_test', 'web_search']);
    expect(answer.toolCalls[0]?.durationMs).toBe(32);
    expect(requests[0]).toMatchObject({ tool_choice: 'auto' });
    expect(requests[0]?.tools).toContainEqual({ type: 'web_search', search_context_size: 'low' });
    expect(requests[0]?.instructions).toContain('Answer directly by default');
    expect(requests[0]?.instructions).toContain('Custom instruction.');
    expect(requests[1]?.input).toContainEqual(expect.objectContaining({ type: 'web_search_call' }));
    await agent.reply('Thanks', signal, undefined, { settings, session });
    expect(requests[2]?.input.filter((item) => item.type === 'web_search_call')).toHaveLength(2);
  });
});

describe('listen_for_reply (follow-up questions)', () => {
  const listenCall = (args: string, callId = 'l1') => ({
    type: 'function_call',
    id: 'fc_l',
    call_id: callId,
    name: 'listen_for_reply',
    arguments: args,
  });

  function makeListeningAgent(responses: FakeResponse[], options: { listen?: boolean } = {}) {
    return makeAgent(responses, () => 0, {
      'followUp.mode': options.listen === false ? 'never' : 'tool',
      'followUp.minWaitMs': 4000,
      'followUp.maxWaitMs': 20000,
      'vad.noSpeechTimeoutMs': 8000,
    });
  }

  it('is offered and explained only when enabled', async () => {
    const on = makeListeningAgent([message('Hi.')]);
    await on.reply('hi', signal);
    expect(on.requests[0]?.tools.map((t) => t.name)).toEqual(['echo_test', 'listen_for_reply']);
    expect(on.requests[0]?.tools[1]).toMatchObject({
      parameters: { properties: { wait_seconds: { minimum: 4, maximum: 20 } } },
    });
    expect(on.requests[0]?.instructions).toContain('the ring goes off');
    expect(on.requests[0]?.instructions).toContain('same response as your reply text');

    const off = makeListeningAgent([message('Hi.')], { listen: false });
    await off.reply('hi', signal);
    expect(off.requests[0]?.tools.map((t) => t.name)).toEqual(['echo_test']);
    expect(off.requests[0]?.instructions).not.toContain('listen_for_reply');
  });

  it('text and the call in one response are the answer: no second model request', async () => {
    const { reply, requests } = makeListeningAgent([
      {
        status: 'completed',
        deltas: ['Which room, ', 'kitchen or bedroom?'],
        output: [...message('Which room, kitchen or bedroom?').output, listenCall('{"wait_seconds":6}')],
      },
      message('Kitchen light is on.'),
    ]);
    const seen: string[] = [];
    const answer = await reply('turn on the light', signal, (t) => seen.push(t));
    expect(answer).toMatchObject({ text: 'Which room, kitchen or bedroom?', listen: { waitMs: 6000 } });
    expect(answer.toolCalls).toEqual([expect.objectContaining({ name: 'listen_for_reply', ok: true })]);
    expect(seen.at(-1)).toBe('Which room, kitchen or bedroom?');
    expect(requests).toHaveLength(1);

    // The call is answered in the history, as the API requires with store:false.
    const next = await reply('kitchen', signal);
    expect(next.listen).toBeUndefined();
    expect(requests[1]?.input).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'l1' }),
    );
  });

  it('speaks the question argument when the model wrote no text, still in one request', async () => {
    const { reply, requests } = makeListeningAgent([
      { status: 'completed', output: [listenCall('{"wait_seconds":5,"question":"Shall I turn it off?"}')] },
    ]);
    const answer = await reply('the heater is on', signal);
    expect(answer).toMatchObject({ text: 'Shall I turn it off?', listen: { waitMs: 5000 } });
    expect(requests).toHaveLength(1);
  });

  it('asks once more for the text when the call came alone and without a question', async () => {
    const { reply, requests } = makeListeningAgent([
      { status: 'completed', output: [listenCall('{"wait_seconds":10}')] },
      message('What should I call the list?'),
    ]);
    const answer = await reply('make a list', signal);
    expect(answer).toMatchObject({ text: 'What should I call the list?', listen: { waitMs: 10000 } });
    expect(requests).toHaveLength(2);
  });

  it('keeps listening when the call came with another tool, and clamps the wait', async () => {
    const { reply } = makeListeningAgent([
      {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'c', name: 'echo_test', arguments: '{"text":"x"}' },
          listenCall('{"wait_seconds":90}'),
        ],
      },
      message('It said x. Again?'),
    ]);
    const answer = await reply('test', signal);
    expect(answer.listen).toEqual({ waitMs: 20000 });
    expect(answer.toolCalls.map((c) => c.name)).toEqual(['listen_for_reply', 'echo_test']);
  });

  it('uses the default wait for missing or broken arguments, and the minimum for tiny ones', async () => {
    const { reply } = makeListeningAgent([
      { status: 'completed', output: [...message('Yes or no?').output, listenCall('not json')] },
      { status: 'completed', output: [...message('Ready?').output, listenCall('{"wait_seconds":1}')] },
    ]);
    expect((await reply('a', signal)).listen).toEqual({ waitMs: 8000 });
    expect((await reply('b', signal)).listen).toEqual({ waitMs: 4000 });
  });

  it('honours a listen call written as text and never speaks or replays the markup', async () => {
    const leaked =
      '<tool_call>{"wait_seconds":8,"question":"Shall I keep counting?"}</tool_call> ' +
      'I found at least 100 emails. Shall I keep counting?';
    const { reply, requests } = makeListeningAgent([
      { ...message(leaked), deltas: [leaked.slice(0, 30), leaked.slice(30)] },
      message('Okay.'),
    ]);
    const seen: string[] = [];
    const answer = await reply('how many emails', signal, (t) => seen.push(t));
    expect(answer).toMatchObject({
      text: 'I found at least 100 emails. Shall I keep counting?',
      listen: { waitMs: 8000 },
    });
    expect(answer.toolCalls).toEqual([expect.objectContaining({ name: 'listen_for_reply', ok: true })]);
    expect(seen.some((t) => t.includes('<tool'))).toBe(false);
    expect(requests).toHaveLength(1);

    await reply('yes', signal);
    expect(JSON.stringify(requests[1]?.input)).not.toContain('tool_call');
  });

  it('drops any other tool call written as text without running it', async () => {
    const { reply } = makeListeningAgent([
      message('Done. <tool_call>{"name":"echo_test","arguments":{"text":"x"}}</tool_call>'),
    ]);
    const answer = await reply('x', signal);
    expect(answer.text).toBe('Done.');
    expect(answer.listen).toBeUndefined();
    expect(answer.toolCalls).toEqual([
      expect.objectContaining({ name: 'echo_test', ok: false, result: 'error: written as text, not run' }),
    ]);
  });

  it('treats the call as an unknown tool when listening is off', async () => {
    const { reply, requests } = makeListeningAgent(
      [{ status: 'completed', output: [listenCall('{"wait_seconds":5}')] }, message('Okay.')],
      { listen: false },
    );
    const answer = await reply('x', signal);
    expect(answer.listen).toBeUndefined();
    expect(answer.toolCalls[0]).toMatchObject({ name: 'listen_for_reply', ok: false });
    expect(requests).toHaveLength(2);
  });
});
