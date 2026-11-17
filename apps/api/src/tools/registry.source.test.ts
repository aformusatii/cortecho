import { buildSettings, DEFAULT_SETTINGS, type Settings } from '@cortecho/shared';
import { describe, expect, it } from 'vitest';
import { type ToolEntry, ToolRegistry, type ToolSource } from './registry.ts';

const settings: Settings = buildSettings({ ...DEFAULT_SETTINGS });
const signal = new AbortController().signal;

function tool(name: string): ToolEntry {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    source: 'mcp',
    handler: async () => name,
  };
}

describe('ToolRegistry snapshots', () => {
  it('composes plugins and sources, sorted, and freezes the turn', async () => {
    let offered: ToolEntry[] = [tool('b__two')];
    const source: ToolSource = {
      id: 'mcp',
      snapshot: () => offered,
      describe: () => [{ slug: 'b', name: 'B', description: '', available: true }],
    };
    const registry = new ToolRegistry()
      .register({
        name: 'plugin_one',
        description: 'plugin',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'plugin',
      })
      .addSource(source);

    const snapshot = registry.snapshot({ settings, deviceId: null });
    expect(snapshot.definitions().map((definition) => definition.name)).toEqual(['b__two', 'plugin_one']);
    expect(snapshot.connectors()).toEqual([{ slug: 'b', name: 'B', description: '', available: true }]);

    // A source that changes after the snapshot must not change this turn.
    offered = [tool('a__one')];
    expect(snapshot.definitions().map((definition) => definition.name)).toEqual(['b__two', 'plugin_one']);
    const next = registry.snapshot({ settings, deviceId: null });
    expect(next.definitions().map((definition) => definition.name)).toEqual(['a__one', 'plugin_one']);
  });

  it('never lets a plugin name contain the connector separator', () => {
    expect(() =>
      new ToolRegistry().register({
        name: 'bad__name',
        description: 'x',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'x',
      }),
    ).toThrow(/reserved for connectors/);
  });

  it('clamps a connector call to the turn deadline and reports the server', async () => {
    const slow = tool('slow__wait');
    slow.timeoutMs = 5000;
    slow.server = 'slow';
    slow.handler = () => new Promise(() => {});
    const registry = new ToolRegistry().addSource({ id: 'mcp', snapshot: () => [slow] });
    const snapshot = registry.snapshot({ settings, deviceId: null });
    const started = Date.now();
    const result = await snapshot.call('slow__wait', '{}', {
      signal,
      deadlineAtMs: Date.now() + 3500,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timed out/);
    expect(result.server).toBe('slow');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
