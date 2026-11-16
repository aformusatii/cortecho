import type { ToolCallRecord } from '@cortecho/shared';
import { errorMessage } from '../lib/logger.ts';

/** JSON Schema for a tool's arguments (an object schema). */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolContext = {
  /** Aborted when the turn is cancelled or the tool times out. */
  signal: AbortSignal;
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
   * Destructive tools run only when listed in TOOLS_ALLOW_DESTRUCTIVE.
   */
  destructive?: boolean;
  /** Returns a JSON-serialisable result. Throw to report an error to the model. */
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
};

/** The shape the OpenAI Responses API expects in `tools`. */
export type FunctionToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: false;
};

const MAX_RESULT_CHARS = 4000;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly allowDestructive: Set<string>;
  private readonly timeoutMs: number;

  constructor({
    allowDestructive = [],
    timeoutMs = 8000,
  }: { allowDestructive?: string[]; timeoutMs?: number } = {}) {
    this.allowDestructive = new Set(allowDestructive);
    this.timeoutMs = timeoutMs;
  }

  register(tool: Tool | null): this {
    if (!tool) return this;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      throw new Error(`Tool name "${tool.name}" must be snake_case (a-z, 0-9, _)`);
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is registered twice`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Definitions sent to the model. Destructive tools that are not allowed
   * are left out entirely, so the model cannot even try them.
   */
  definitions(): FunctionToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => this.isAllowed(tool))
      .map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      }));
  }

  /**
   * Runs one call from the model. Never throws: errors become a result the
   * model can read ("error: ..."), so it can tell the user what went wrong.
   */
  async call(
    name: string,
    argumentsJson: string,
    signal?: AbortSignal,
  ): Promise<ToolCallRecord & { output: string }> {
    const started = Date.now();
    const finish = (ok: boolean, output: string) => {
      const truncated = output.length > MAX_RESULT_CHARS ? `${output.slice(0, MAX_RESULT_CHARS)}…` : output;
      return {
        name,
        arguments: argumentsJson,
        result: truncated,
        output: truncated,
        ok,
        durationMs: Date.now() - started,
      };
    };

    const tool = this.tools.get(name);
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

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await Promise.race([
        tool.handler(args, { signal: combined }),
        new Promise<never>((_, reject) => {
          combined.addEventListener(
            'abort',
            () => reject(new Error(timeout.aborted ? `timed out after ${this.timeoutMs} ms` : 'cancelled')),
            {
              once: true,
            },
          );
        }),
      ]);
      return finish(true, typeof result === 'string' ? result : JSON.stringify(result ?? null));
    } catch (error) {
      return finish(false, `error: ${errorMessage(error)}`);
    }
  }

  private isAllowed(tool: Tool): boolean {
    return !tool.destructive || this.allowDestructive.has(tool.name);
  }
}
