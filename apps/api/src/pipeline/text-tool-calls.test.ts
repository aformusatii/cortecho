import { describe, expect, it } from 'vitest';
import { cleanOutput, extractTextToolCalls, speakableText } from './text-tool-calls.ts';

// The reply spoken on 2026-11-17 at 23:01, markup and all.
const LEAKED =
  '<tool_call>{"wait_seconds":8,"question":"Do you want the exact count?"}</tool_call> ' +
  'I found at least 100 emails this month. Do you want the exact count?';

// The reply written on 2026-11-20: `to=functions.` markers, junk, JSON, and a
// sentence the model looped four times.
const INCIDENT =
  'I’m still waiting for the runner to finish the build and test.         ' +
  'I’m still waiting for the runner to finish the build and test.   ' +
  'I’m still waiting for the runner to finish the build and test.  ' +
  'I’m still waiting for the runner to finish the build and test. ' +
  'to=functions.runner__get_session 彩票平台招商\n' +
  '{"session":"s_d6436q2q"} {"session":"s_d6436q2q"} to=functions.runner__get_session  天天爱彩票提现json\n' +
  '{"session":"s_d6436q2q"} ' +
  'I’ve started the runner session to build, test, and stop the Hello World Node.js app, ' +
  'but I’m not able to retrieve its completion status from here right now.';

describe('tool calls written as text', () => {
  it('removes the block and returns its arguments', () => {
    expect(extractTextToolCalls(LEAKED)).toEqual({
      text: 'I found at least 100 emails this month. Do you want the exact count?',
      calls: [{ name: null, arguments: { wait_seconds: 8, question: 'Do you want the exact count?' } }],
    });
  });

  it('reads the wrapped {name, arguments} form, also with arguments as a JSON string', () => {
    const text =
      'Sure. <tool_call>{"name":"listen_for_reply","arguments":"{\\"wait_seconds\\":5}"}</tool_call>' +
      '<function_call>{"name":"gmail__send","parameters":{"to":"x"}}</function_call>';
    expect(extractTextToolCalls(text)).toEqual({
      text: 'Sure.',
      calls: [
        { name: 'listen_for_reply', arguments: { wait_seconds: 5 } },
        { name: 'gmail__send', arguments: { to: 'x' } },
      ],
    });
  });

  it('drops an unclosed block and survives broken JSON', () => {
    expect(extractTextToolCalls('Okay. <tool_call>{"wait_seconds":')).toEqual({
      text: 'Okay.',
      calls: [{ name: null, arguments: {} }],
    });
  });

  it('leaves ordinary text alone', () => {
    expect(extractTextToolCalls('Use a < b, not <b>.')).toEqual({ text: 'Use a < b, not <b>.', calls: [] });
  });

  it('never streams markup: open blocks and half-written tags are held back', () => {
    expect(speakableText('<tool_c')).toBe('');
    expect(speakableText('<tool_call>{"wait_sec')).toBe('');
    expect(speakableText(`${LEAKED.slice(0, 80)}`).trim()).toBe('');
    expect(speakableText(LEAKED).trim()).toBe(extractTextToolCalls(LEAKED).text);
    expect(speakableText('Two < three')).toBe('Two < three');
  });

  it('removes the to=functions. marker, its junk and JSON, and collapses the looped sentence', () => {
    expect(extractTextToolCalls(INCIDENT)).toEqual({
      text:
        'I’m still waiting for the runner to finish the build and test. ' +
        'I’ve started the runner session to build, test, and stop the Hello World Node.js app, ' +
        'but I’m not able to retrieve its completion status from here right now.',
      calls: [
        { name: 'runner__get_session', arguments: { session: 's_d6436q2q' } },
        { name: 'runner__get_session', arguments: { session: 's_d6436q2q' } },
      ],
    });
  });

  it('removes a marker with no JSON and records an empty-arguments call', () => {
    expect(extractTextToolCalls('Calling to=functions.runner__get_session now.')).toEqual({
      text: 'Calling',
      calls: [{ name: 'runner__get_session', arguments: {} }],
    });
  });

  it('never streams a to=functions. marker or a half-written one', () => {
    expect(speakableText('to=f')).toBe('');
    expect(speakableText('to=func')).toBe('');
    expect(speakableText('Still waiting. to=functions.runner__get_session')).toBe('Still waiting. ');
    expect(speakableText('Still waiting. to=functions.')).toBe('Still waiting. ');
  });

  it('leaves text that merely mentions "to" alone', () => {
    expect(extractTextToolCalls('the ratio a to b')).toEqual({ text: 'the ratio a to b', calls: [] });
    expect(speakableText('the ratio a to b')).toBe('the ratio a to b');
  });

  it('cleans message items and drops their now-wrong citations', () => {
    const item = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: LEAKED, annotations: [{ type: 'url_citation' }] }],
    };
    const call = { type: 'function_call', name: 'x' };
    const { output, calls } = cleanOutput([item, call]);
    expect(calls).toHaveLength(1);
    expect(output[1]).toBe(call);
    expect(output[0]).toMatchObject({
      content: [
        { text: 'I found at least 100 emails this month. Do you want the exact count?', annotations: [] },
      ],
    });
    const plain = { type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] };
    expect(cleanOutput([plain]).output[0]).toBe(plain);
  });
});
