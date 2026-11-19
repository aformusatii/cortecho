import {
  askRequestSchema,
  type Health,
  type SayResult,
  sayRequestSchema,
  turnsQuerySchema,
} from '@cortecho/shared';
import { Hono } from 'hono';
import { AppError } from '../../lib/errors.ts';
import { createLogger, errorMessage } from '../../lib/logger.ts';
import { validate } from '../../lib/validation.ts';
import { askWeb } from '../../pipeline/ask.ts';
import { NotConfiguredError } from '../../pipeline/services.ts';
import { EchoUnavailableError, type VoicePipeline } from '../../pipeline/voice-pipeline.ts';
import type { Device } from '../devices/devices.repository.ts';
import type { VoiceRuntime } from './voice-runtime.ts';

/** The health document: every Echo, OpenAI config, the last turn. */
export function buildHealth(runtime: VoiceRuntime): Health {
  const { services, tools, turns, startedAt, settings: store, devices } = runtime;
  const { settings, version } = store.current();
  return {
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    devices: devices.list(),
    openai: {
      configured: services.configured,
      sttModel: settings.stt.model,
      agentModel: settings.agent.model,
      ttsModel: settings.tts.model,
    },
    tools: [...tools.names, ...(settings.agent.webSearch ? ['web_search'] : [])],
    connectors: runtime.mcp.health(),
    settingsVersion: version,
    lastTurn: turns.latest(1)[0] ?? null,
  };
}

/** Maps pipeline failures to the standard error body. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof EchoUnavailableError) {
    return new AppError(error.code === 'ECHO_BUSY' ? 409 : 503, error.code, error.message);
  }
  if (error instanceof NotConfiguredError) {
    return new AppError(503, 'UPSTREAM_ERROR', 'OpenAI is not configured (no API key in Settings).');
  }
  return new AppError(502, 'UPSTREAM_ERROR', `The request failed: ${errorMessage(error)}`);
}

/** One Echo's outcome in /api/say: a failure is reported, never thrown. */
async function sayOn(
  device: Device,
  pipeline: VoicePipeline | null,
  text: string,
  voice: Parameters<VoicePipeline['say']>[1],
): Promise<SayResult> {
  const base = { deviceId: device.id, deviceName: device.name };
  if (!device.enabled) {
    return { ...base, ok: false, error: { code: 'ECHO_UNAVAILABLE', message: 'This Echo is disabled.' } };
  }
  if (!pipeline) {
    return { ...base, ok: false, error: { code: 'ECHO_UNAVAILABLE', message: 'This Echo is not running.' } };
  }
  try {
    return { ...base, ok: true, turn: await pipeline.say(text, voice) };
  } catch (error) {
    if (error instanceof EchoUnavailableError) {
      return { ...base, ok: false, error: { code: error.code, message: error.message } };
    }
    if (error instanceof NotConfiguredError) {
      return {
        ...base,
        ok: false,
        error: { code: 'UPSTREAM_ERROR', message: 'OpenAI is not configured (no API key in Settings).' },
      };
    }
    return { ...base, ok: false, error: { code: 'UPSTREAM_ERROR', message: errorMessage(error) } };
  }
}

/** The reply file name: the id from ReplyAudio plus ".wav". */
const REPLY_FILE = /^([A-Za-z0-9_-]{22})\.wav$/;

export function createVoiceRoutes(runtime: VoiceRuntime) {
  const sessionLog = createLogger('session');
  return (
    new Hono()
      // The Echo downloads the spoken reply / announcement here (hassmic plays
      // WAV and MP3 from a URL). One current reply per Echo, by its random id.
      .get('/reply-audio/:file', (c) => {
        const id = REPLY_FILE.exec(c.req.param('file'))?.[1];
        const reply = id ? runtime.replies.get(id) : null;
        if (!reply) throw new AppError(404, 'NOT_FOUND', 'No such reply.');
        const wav = reply.wav();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { value, done } = await wav.next();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          async cancel() {
            await wav.return(undefined);
          },
        });
        return new Response(body, {
          headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
        });
      })
      .get('/turns', validate('query', turnsQuerySchema), (c) => {
        const { limit, deviceId } = c.req.valid('query');
        return c.json(runtime.turns.latest(limit, deviceId === undefined ? {} : { deviceId }));
      })
      .post('/say', validate('json', sayRequestSchema), async (c) => {
        const { text, deviceId, voice } = c.req.valid('json');
        if (deviceId !== undefined) {
          const device = runtime.devices.device(deviceId);
          if (!device) throw new AppError(404, 'NOT_FOUND', `No device #${deviceId}.`);
          const result = await sayOn(device, runtime.devices.pipeline(deviceId), text, voice);
          return c.json({ results: [result] });
        }
        // Neither deviceId nor all: every enabled `echo` device (test devices are left out).
        const targets = runtime.devices
          .listDevices()
          .filter((device) => device.enabled && device.kind === 'echo');
        const results = await Promise.all(
          targets.map((device) => sayOn(device, runtime.devices.pipeline(device.id), text, voice)),
        );
        return c.json({ results });
      })
      .post('/ask', validate('json', askRequestSchema), async (c) => {
        const { text, deviceId } = c.req.valid('json');
        try {
          if (deviceId === undefined) {
            return c.json({
              turn: await askWeb({
                text,
                services: runtime.services,
                turns: runtime.turns,
                sessions: runtime.sessions,
                snapshot: runtime.settings.current(),
                tools: runtime.tools,
              }),
            });
          }
          const device = runtime.devices.device(deviceId);
          if (!device) throw new AppError(404, 'NOT_FOUND', `No device #${deviceId}.`);
          const pipeline = runtime.devices.pipeline(deviceId);
          if (!pipeline) throw new AppError(404, 'NOT_FOUND', `No device #${deviceId}.`);
          return c.json({ turn: await pipeline.ask(text) });
        } catch (error) {
          throw toAppError(error);
        }
      })

      // "Forget conversation" for the web session (/api/ask without a device),
      // the symmetry of POST /api/devices/:id/conversation/reset.
      .post('/conversation/reset', (c) => {
        runtime.sessions.reset('web');
        sessionLog.info('web conversation forgotten');
        return c.body(null, 204);
      })
  );
}
