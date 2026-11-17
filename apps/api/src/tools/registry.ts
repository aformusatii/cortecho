import type { Settings, ToolCallRecord } from '@cortecho/shared';
import { errorMessage } from '../lib/logger.ts';

/** JSON Schema for a tool's arguments (an object schema). */
export type JsonSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

/** Where a tool came from: the compiled plugins or one MCP connector. */
export type ToolSourceId = 'plugins' | 'mcp';

/** The state a tool call runs with (the turn's frozen snapshot). */
export type ToolRunContext = {
  /** Aborted when the turn is cancelled or the tool times out. */
  signal: AbortSignal;
  /** The speaker's conversation, for the confirm-by-voice barrier. */
  session?: import('../pipeline/agent-sessions.ts').AgentSession;
  /** This reply's position in the session: a pending action must come from an earlier one. */
  turnNumber?: number;
  /** Wall-clock deadline of the turn, for clamping a connector's own timeout. */
  deadlineAtMs?: number | null;
  /** The Echo or `web` speaker (for per-Echo availability decisions). */
  deviceId?: number | null;
};

/**
 * One action the agent can take. A plugin is one file that exports a
 * function returning a Tool (or null when its config is missing).
 */
export type Tool = {
  /** snake_case, unique; this is what the model calls. */
  name: string;
  /** Tells the model WHEN to use the tool. */
  description: string;
  parameters: JsonSchema;
  /**
   * Changes something in the real world (switches a light, runs a script).
   * Destructive plugin tools run only when listed in TOOLS_ALLOW_DESTRUCTIVE.
   */
  destructive?: boolean;
  /** Returns a JSON-serialisable result. Throw to report an error to the model. */
  handler: (args: Record<string, unknown>, context: ToolRunContext) => Promise<unknown>;
};

/**
 * A tool plus where it came from and the connector policy that governs it.
 * `gate` is the confirm-by-voice barrier: when it refuses, the handler never
 * runs and the model gets the gate's output instead.
 */
export type ToolEntry = Tool & {
  source: ToolSourceId;
  /** The connector slug (MCP tools only). */
  server?: string;
  /** The connector's display name, for the prompt's connected-services line. */
  serverName?: string;
  /** The connector's account note, for the prompt's connected-services line. */
  serverDescription?: string;
  policy?: 'auto' | 'confirm';
  /** Overrides the registry's default per-call timeout. */
  timeoutMs?: number;
  /** Overrides the registry's default result truncation. */
  maxResultChars?: number;
  gate?: (
    args: Record<string, unknown>,
    argumentsJson: string,
    context: ToolRunContext,
  ) => Promise<ToolGateResult>;
};

export type ToolGateResult =
  | { allow: true }
  | { allow: false; output: string; ok?: boolean; pending?: boolean };

export type ToolSnapshotInput = {
  settings: Settings;
  deviceId: number | null;
};

/**
 * A composable source of tools. `snapshot` is called once per turn and must
 * read memory only (no I/O): the turn must not wait for a connector.
 */
export type ToolSource = {
  id: ToolSourceId;
  snapshot(input: ToolSnapshotInput): ToolEntry[];
  /** Every configured connector for the prompt, including unavailable ones. */
  describe?(input: ToolSnapshotInput): ConnectorPromptLine[];
};

/** The shape the OpenAI Responses API expects in `tools`. */
export type FunctionToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: false;
};

export type ConnectorPromptLine = {
  slug: string;
  name: string;
  description: string;
  available: boolean;
  /** The server's own instructions, when the owner enabled them (≤ 500 chars). */
  instructions?: string;
};

const MAX_RESULT_CHARS = 4000;
/** A tool never eats the last seconds of a voice turn. */
const DEADLINE_RESERVE_MS = 3000;

/**
 * The tools offered for one turn, frozen at its start. The agent asks this
 * object for definitions and calls, so a connector that changes mid-turn
 * cannot change the turn.
 */
export class ToolSet {
  private readonly byName: Map<string, ToolEntry>;
  private readonly allowDestructive: Set<string>;
  private readonly defaultTimeoutMs: number;
  private readonly described: ConnectorPromptLine[];
  readonly names: string[];

  constructor(
    entries: ToolEntry[],
    { allowDestructive = [], timeoutMs = 8000 }: { allowDestructive?: string[]; timeoutMs?: number } = {},
    described: ConnectorPromptLine[] = [],
  ) {
    this.allowDestructive = new Set(allowDestructive);
    this.defaultTimeoutMs = timeoutMs;
    this.described = described;
    const entriesNow = entries.sort((a, b) => a.name.localeCompare(b.name));
    this.byName = new Map(entriesNow.map((entry) => [entry.name, entry]));
    this.names = [...this.byName.keys()];
  }

  definitions(): FunctionToolDefinition[] {
    return [...this.byName.values()]
      .filter((entry) => this.isAllowed(entry))
      .map((entry) => ({
        type: 'function',
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
        strict: false,
      }));
  }

  /** The connectors behind this turn's tools, sorted, for prompt layer 2. */
  connectors(): ConnectorPromptLine[] {
    const bySlug = new Map<string, ConnectorPromptLine>();
    for (const line of this.described) bySlug.set(line.slug, line);
    for (const entry of this.byName.values()) {
      if (!entry.server) continue;
      const existing = bySlug.get(entry.server);
      bySlug.set(entry.server, {
        slug: entry.server,
        name: existing?.name ?? entry.serverName ?? entry.server,
        description: existing?.description ?? entry.serverDescription ?? '',
        available: true,
      });
    }
    return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  hasConfirmTools(): boolean {
    return [...this.byName.values()].some((entry) => entry.policy === 'confirm');
  }

  /**
   * Runs one call from the model. Never throws: errors become a result the
   * model can read ("error: ..."), so it can tell the user what went wrong.
   */
  async call(
    name: string,
    argumentsJson: string,
    context: Partial<ToolRunContext> = {},
  ): Promise<ToolCallRecord & { output: string }> {
    const started = Date.now();
    const tool = this.byName.get(name);
    const finish = (ok: boolean, output: string, extra: { pending?: boolean } = {}) => {
      const limit = tool?.maxResultChars ?? MAX_RESULT_CHARS;
      const truncated = output.length > limit ? `${output.slice(0, limit)}…` : output;
      return {
        name,
        arguments: argumentsJson,
        result: truncated,
        output: truncated,
        ok,
        durationMs: Date.now() - started,
        ...(tool?.server ? { server: tool.server } : {}),
        ...(extra.pending ? { pending: true } : {}),
      };
    };

    if (!tool) return finish(false, `error: unknown tool "${name}"`);
    if (!this.isAllowed(tool)) {
      return finish(false, `error: tool "${name}" is destructive and not in TOOLS_ALLOW_DESTRUCTIVE`);
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = argumentsJson.trim() === '' ? {} : JSON.parse(argumentsJson);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not an object');
      args = parsed as Record<string, unknown>;
    } catch (error) {
      return finish(false, `error: arguments are not a JSON object (${errorMessage(error)})`);
    }

    const runContext: ToolRunContext = {
      signal: context.signal ?? new AbortController().signal,
      ...(context.session ? { session: context.session } : {}),
      ...(context.turnNumber !== undefined ? { turnNumber: context.turnNumber } : {}),
      ...(context.deadlineAtMs !== undefined ? { deadlineAtMs: context.deadlineAtMs } : {}),
      ...(context.deviceId !== undefined ? { deviceId: context.deviceId } : {}),
    };

    if (tool.gate) {
      try {
        const gate = await tool.gate(args, argumentsJson, runContext);
        if (!gate.allow) return finish(gate.ok ?? true, gate.output, gate.pending ? { pending: true } : {});
      } catch (error) {
        return finish(false, `error: ${errorMessage(error)}`);
      }
    }

    const budget = this.budgetFor(tool, runContext);
    if (budget !== null && budget <= 0) return finish(false, 'error: the turn is out of time');
    const timeout =
      budget === null ? AbortSignal.timeout(this.defaultTimeout(tool)) : AbortSignal.timeout(budget);
    const combined = AbortSignal.any([runContext.signal, timeout]);
    const waitMs = budget ?? this.defaultTimeout(tool);
    try {
      const result = await Promise.race([
        tool.handler(args, { ...runContext, signal: combined }),
        new Promise<never>((_, reject) => {
          combined.addEventListener(
            'abort',
            () => reject(new Error(timeout.aborted ? `timed out after ${waitMs} ms` : 'cancelled')),
            { once: true },
          );
        }),
      ]);
      return finish(true, typeof result === 'string' ? result : JSON.stringify(result ?? null));
    } catch (error) {
      return finish(false, `error: ${errorMessage(error)}`);
    }
  }

  private defaultTimeout(tool: ToolEntry): number {
    return tool.timeoutMs ?? this.defaultTimeoutMs;
  }

  /** min(the tool's timeout, time left before the turn deadline − 3 s). */
  private budgetFor(tool: ToolEntry, context: ToolRunContext): number | null {
    const own = this.defaultTimeout(tool);
    if (!context.deadlineAtMs) return null;
    return Math.min(own, context.deadlineAtMs - Date.now() - DEADLINE_RESERVE_MS);
  }

  private isAllowed(tool: ToolEntry): boolean {
    return !tool.destructive || this.allowDestructive.has(tool.name);
  }
}

/**
 * The tool registry: compiled plugins plus any number of `ToolSource`s
 * (today: connectors). `snapshot()` is the per-turn API; `definitions()` and
 * `call()` remain for the plugin-only callers and tests.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly sources: ToolSource[] = [];
  private readonly allowDestructive: string[];
  private readonly timeoutMs: number;

  constructor({
    allowDestructive = [],
    timeoutMs = 8000,
  }: { allowDestructive?: string[]; timeoutMs?: number } = {}) {
    this.allowDestructive = allowDestructive;
    this.timeoutMs = timeoutMs;
  }

  register(tool: Tool | null): this {
    if (!tool) return this;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      throw new Error(`Tool name "${tool.name}" must be snake_case (a-z, 0-9, _)`);
    }
    // Connector tools always contain "__", so a plugin can never collide.
    if (tool.name.includes('__')) {
      throw new Error(`Plugin tool name "${tool.name}" must not contain "__" (reserved for connectors)`);
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is registered twice`);
    this.tools.set(tool.name, tool);
    return this;
  }

  addSource(source: ToolSource): this {
    this.sources.push(source);
    return this;
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /** The plugin-only definitions (kept for existing callers and tests). */
  definitions(): FunctionToolDefinition[] {
    return this.snapshotEntries({ settings: null, deviceId: null }, true).definitions();
  }

  /** The tools offered now: plugins plus every source, frozen in one snapshot. */
  snapshot(input: ToolSnapshotInput): ToolSet {
    return this.snapshotEntries(input, false);
  }

  /** Runs one plugin call; connector tools go through `snapshot().call()`. */
  async call(
    name: string,
    argumentsJson: string,
    signal?: AbortSignal,
  ): Promise<ToolCallRecord & { output: string }> {
    return this.snapshotEntries({ settings: null, deviceId: null }, true).call(name, argumentsJson, {
      signal,
    });
  }

  private snapshotEntries(
    input: { settings: Settings | null; deviceId: number | null },
    pluginsOnly: boolean,
  ) {
    const entries: ToolEntry[] = [...this.tools.values()].map((tool) => ({
      ...tool,
      source: 'plugins' as const,
    }));
    const described: ConnectorPromptLine[] = [];
    if (!pluginsOnly) {
      for (const source of this.sources) {
        try {
          const snapshotInput = {
            settings: input.settings as Settings,
            deviceId: input.deviceId,
          };
          entries.push(...source.snapshot(snapshotInput));
          if (source.describe) described.push(...source.describe(snapshotInput));
        } catch {
          // A misbehaving source must not break the whole turn.
        }
      }
    }
    return new ToolSet(
      entries,
      {
        allowDestructive: this.allowDestructive,
        timeoutMs: this.timeoutMs,
      },
      described,
    );
  }
}
