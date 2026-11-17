import type { SettingsSnapshot } from '../features/settings/settings-store.ts';
import type { TurnsRepository } from '../features/turns/turns.repository.ts';
import { errorMessage } from '../lib/logger.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentSessions } from './agent-sessions.ts';
import type { PromptDevice } from './prompt-layers.ts';
import type { VoiceServices } from './services.ts';

/**
 * /api/ask without a device: the `web` conversation and the global settings.
 * A device's ask runs on that device's pipeline instead, so it sees the
 * Echo's prompt, overrides and memory.
 */
export async function askWeb({
  text,
  services,
  turns,
  sessions,
  snapshot,
  tools,
}: {
  text: string;
  services: VoiceServices;
  turns: TurnsRepository;
  sessions: AgentSessions;
  snapshot: SettingsSnapshot;
  tools: ToolRegistry;
}): Promise<import('@cortecho/shared').Turn> {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const abort = new AbortController();
  const device: PromptDevice | null = null;
  try {
    const session = sessions.get('web', snapshot.settings.assistant.sessionIdleMinutes * 60_000);
    const reply = await services.agent.reply(text, abort.signal, undefined, {
      settings: snapshot.settings,
      session,
      device,
      toolSet: tools.snapshot({ settings: snapshot.settings, deviceId: null }),
      deviceId: null,
      deadlineAtMs: null,
    });
    return turns.insert({
      source: 'ask',
      outcome: 'answered',
      startedAt,
      deviceId: null,
      settingsVersion: snapshot.version,
      transcript: text,
      reply: reply.text,
      displayText: reply.displayText,
      citations: reply.citations,
      toolCalls: reply.toolCalls,
      timings: { agentDoneMs: Date.now() - startedAtMs },
    });
  } catch (error) {
    try {
      turns.insert({
        source: 'ask',
        outcome: 'error',
        startedAt,
        deviceId: null,
        settingsVersion: snapshot.version,
        transcript: text,
        error: errorMessage(error),
        timings: { agentDoneMs: Date.now() - startedAtMs },
      });
    } catch {
      // Losing a history row must never hide the real error.
    }
    throw error;
  }
}
