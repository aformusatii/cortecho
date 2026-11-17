import type { Settings } from '@cortecho/shared';
import type { McpToolRow } from '../db/schema.ts';
import type {
  ConnectorPromptLine,
  JsonSchema,
  ToolEntry,
  ToolSnapshotInput,
  ToolSource,
} from '../tools/registry.ts';
import { createConfirmGate } from './confirmations.ts';
import { ConnectorAuthError, ConnectorUnavailableError } from './mcp-connection.ts';
import type { McpManager } from './mcp-manager.ts';
import { effectivePolicy } from './mcp-manager.ts';
import { resultToText, toolDescription, truncateResult, wrapResult } from './tool-mapping.ts';

/**
 * Connector tools as a ToolSource. `snapshot` reads memory and SQLite rows
 * only (no connector I/O): the turn never waits for MCP to answer. A connector
 * that is not connected is left out of this turn; layer 2 still lists it as
 * unavailable so the model can say "I can't reach Gmail right now".
 */
export class McpToolSource implements ToolSource {
  readonly id = 'mcp' as const;
  private readonly manager: McpManager;

  constructor({ manager }: { manager: McpManager }) {
    this.manager = manager;
  }

  snapshot({ settings, deviceId }: ToolSnapshotInput): ToolEntry[] {
    if (!settings.connectors.enabled) return [];
    const entries: ToolEntry[] = [];
    for (const { row } of this.manager.offeredRows(deviceId, settings)) {
      for (const tool of this.manager.repository.tools(row.id)) {
        if (!tool.present) continue;
        const policy = effectivePolicy(tool);
        if (policy === 'off') continue;
        entries.push(this.entry(row, tool, policy === 'confirm' ? 'confirm' : 'auto', settings));
      }
    }
    return entries;
  }

  describe({ settings }: ToolSnapshotInput): ConnectorPromptLine[] {
    if (!settings.connectors.enabled) return [];
    return this.manager.describe(null, settings);
  }

  private entry(
    row: {
      id: number;
      slug: string;
      name: string;
      description: string;
      timeoutMs: number;
      maxResultChars: number;
    },
    tool: McpToolRow,
    policy: 'auto' | 'confirm',
    settings: Settings,
  ): ToolEntry {
    const parameters = parseSchema(tool.inputSchema);
    const listed = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
    };
    const confirmGate =
      policy === 'confirm'
        ? createConfirmGate({
            connectorName: row.name,
            exposedName: tool.exposedName,
            confirmWindowS: settings.connectors.confirmWindowS,
          })
        : undefined;
    return {
      name: tool.exposedName,
      description: toolDescription(row.name, listed, policy),
      parameters,
      source: 'mcp',
      server: row.slug,
      serverName: row.name,
      serverDescription: row.description,
      policy,
      timeoutMs: row.timeoutMs,
      maxResultChars: row.maxResultChars,
      handler: async (args, context) => {
        const deadline = context.deadlineAtMs
          ? Math.max(500, context.deadlineAtMs - Date.now() - 3000)
          : row.timeoutMs;
        const timeout = Math.min(row.timeoutMs, deadline);
        let result: unknown;
        try {
          const connection = this.manager.connection(row.id);
          if (!connection) {
            throw new Error(`the ${row.name} connection is not running`);
          }
          result = await connection.callTool(tool.name, args, timeout);
        } catch (error) {
          if (error instanceof ConnectorAuthError) {
            throw new Error(`the ${row.name} connection needs to be signed in again in Cortecho's settings`);
          }
          if (error instanceof ConnectorUnavailableError) throw new Error(error.message);
          throw error;
        }
        const value = (result ?? {}) as Record<string, unknown>;
        const text = resultToText(value);
        if (value.isError === true) throw new Error(text || `${row.name} returned an error`);
        return wrapResult(row.name, truncateResult(text, row.maxResultChars));
      },
      ...(confirmGate ? { gate: confirmGate } : {}),
    };
  }
}

function parseSchema(raw: string): JsonSchema {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { type: 'object', ...(parsed as Record<string, unknown>) } as JsonSchema;
    }
  } catch {
    // fall through
  }
  return { type: 'object', properties: {} };
}
