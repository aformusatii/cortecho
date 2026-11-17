import type { DoctorReport } from '@cortecho/shared';
import type { Config } from '../../config.ts';
import type { McpManager } from '../../mcp/mcp-manager.ts';
import type { AgentSessions } from '../../pipeline/agent-sessions.ts';
import type { ReplyAudioStore } from '../../pipeline/reply-audio.ts';
import type { VoiceServices } from '../../pipeline/services.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { DeviceManager } from '../devices/device-manager.ts';
import type { SettingsStore } from '../settings/settings-store.ts';
import type { TurnsRepository } from '../turns/turns.repository.ts';

/** Everything the HTTP routes need from the voice side, built in server.ts. */
export type VoiceRuntime = {
  config: Config;
  replies: ReplyAudioStore;
  services: VoiceServices;
  tools: ToolRegistry;
  turns: TurnsRepository;
  /** Connector runtime: one MCP connection per server row. */
  mcp: McpManager;
  /** Global settings plus every device's overrides. */
  settings: SettingsStore;
  /** Conversation memory for every speaker (device:<id> and web). */
  sessions: AgentSessions;
  /** One runtime per Echo; starts and stops links, holds the identity checks. */
  devices: DeviceManager;
  /** Read-only diagnostics shared by GET /api/doctor and the CLI. */
  doctor: () => Promise<DoctorReport>;
  startedAt: Date;
};
