import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { createVoiceServices } from './voice-services.ts';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
  toFile: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function testSettings(): Settings {
  return buildSettings({
    ...DEFAULT_SETTINGS,
    'openai.apiKey': 'test-key',
    'agent.webSearch': true,
  });
}

function services() {
  const settings = testSettings();
  return createVoiceServices(loadConfig(), new ToolRegistry(), () => settings);
}

function context() {
  return { settings: testSettings(), session: { history: [], lastTurnAt: 0 } };
}

describe('search streaming', () => {
  it('buffers searched text and returns speech without citations', async () => {
    create.mockImplementation(async function* () {
      yield { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws' } };
      yield { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws' } };
      yield { type: 'response.output_text.delta', delta: 'Fact. [1]' };
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            { type: 'web_search_call', id: 'ws', status: 'completed', action: { type: 'search' } },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Fact. [1]',
                  annotations: [
                    {
                      type: 'url_citation',
                      start_index: 6,
                      end_index: 9,
                      url: 'https://example.com',
                      title: 'Source',
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    });
    const onText = vi.fn();
    const reply = await services().agent.reply('Search', new AbortController().signal, onText, context());
    expect(onText).not.toHaveBeenCalled();
    expect(reply.text).toBe('Fact.');
    expect(reply.citations).toHaveLength(1);
    expect(reply.toolCalls[0]).toMatchObject({ name: 'web_search', ok: true });
  });

  it('keeps ordinary streaming and forwards the cancellation signal', async () => {
    create.mockImplementation(async function* () {
      yield { type: 'response.output_text.delta', delta: 'Hello.' };
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello.' }] }],
        },
      };
    });
    const onText = vi.fn();
    const controller = new AbortController();
    await services().agent.reply('Hi', controller.signal, onText, context());
    expect(onText).toHaveBeenCalledWith('Hello.');
    expect(create.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it('propagates failed hosted requests', async () => {
    create.mockImplementation(async function* () {
      yield { type: 'response.failed', response: { status: 'failed', output: [] } };
    });
    await expect(
      services().agent.reply('Search', new AbortController().signal, undefined, context()),
    ).rejects.toThrow('failed');
  });
});
