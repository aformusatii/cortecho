import { describe, expect, it } from 'vitest';
import { echoTestTool } from './plugins/echo-test.ts';
import { httpRequestTool } from './plugins/http-request.ts';
import { type Tool, ToolRegistry } from './registry.ts';

const destructiveTool: Tool = {
  name: 'switch_light',
  description: 'Switches a light.',
  destructive: true,
  parameters: { type: 'object', properties: {} },
  handler: async () => 'done',
};

describe('ToolRegistry', () => {
  it('lists definitions in the Responses API shape', () => {
    const registry = new ToolRegistry().register(echoTestTool());
    expect(registry.definitions()).toEqual([
      expect.objectContaining({ type: 'function', name: 'echo_test', strict: false }),
    ]);
  });

  it('runs a tool and returns its JSON result', async () => {
    const result = await new ToolRegistry().register(echoTestTool()).call('echo_test', '{"text":"hi"}');
    expect(result).toMatchObject({ ok: true, output: '{"echoed":"hi"}' });
  });

  it('reports unknown tools, bad JSON and handler errors as results, never throws', async () => {
    const failing: Tool = {
      ...echoTestTool(),
      name: 'boom',
      handler: async () => Promise.reject(new Error('kaput')),
    };
    const registry = new ToolRegistry().register(echoTestTool()).register(failing);
    expect((await registry.call('nope', '{}')).output).toMatch(/unknown tool/);
    expect((await registry.call('echo_test', '[1]')).output).toMatch(/not a JSON object/);
    expect(await registry.call('boom', '{}')).toMatchObject({
      ok: false,
      output: 'error: kaput',
      // The status page shows the stack when the call is opened.
      errorDetail: expect.stringContaining('kaput'),
    });
  });

  it('times out slow tools', async () => {
    const slow: Tool = { ...echoTestTool(), name: 'slow', handler: () => new Promise(() => {}) };
    const result = await new ToolRegistry({ timeoutMs: 50 }).register(slow).call('slow', '{}');
    expect(result).toMatchObject({ ok: false, output: 'error: timed out after 50 ms' });
  });

  it('hides and refuses destructive tools unless allow-listed', async () => {
    const locked = new ToolRegistry().register(destructiveTool);
    expect(locked.definitions()).toEqual([]);
    expect((await locked.call('switch_light', '{}')).output).toMatch(/TOOLS_ALLOW_DESTRUCTIVE/);

    const allowed = new ToolRegistry({ allowDestructive: ['switch_light'] }).register(destructiveTool);
    expect(allowed.definitions()).toHaveLength(1);
    expect((await allowed.call('switch_light', '{}')).ok).toBe(true);
  });

  it('rejects duplicate and badly named tools, and ignores null plugins', () => {
    expect(() => new ToolRegistry().register(echoTestTool()).register(echoTestTool())).toThrow(/twice/);
    expect(() => new ToolRegistry().register({ ...echoTestTool(), name: 'Bad-Name' })).toThrow(/snake_case/);
    expect(new ToolRegistry().register(null).names).toEqual([]);
  });
});

describe('plugins', () => {
  it('http_request is only registered with endpoints and treats POST as destructive', () => {
    expect(httpRequestTool({})).toBeNull();
    expect(httpRequestTool({ a: { url: 'http://x/a' } })?.destructive).toBe(false);
    expect(httpRequestTool({ a: { url: 'http://x/a', method: 'POST' } })?.destructive).toBe(true);
    expect(() => httpRequestTool({ a: { url: 'file:///etc/passwd' } })).toThrow(/http/);
  });
});
