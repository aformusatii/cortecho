import {
  type DeviceSettingsDocument,
  deviceAdoptSchema,
  deviceCreateSchema,
  deviceProbeSchema,
  deviceSettingsPatchSchema,
  deviceUpdateSchema,
  type InstructionsDocument,
  isSecretSetting,
} from '@cortecho/shared';
import { Hono } from 'hono';
import { parseApiKey } from '../../esphome/noise.ts';
import { AppError, validationError } from '../../lib/errors.ts';
import { createLogger } from '../../lib/logger.ts';
import { validate } from '../../lib/validation.ts';
import { previewPromptInput } from '../../pipeline/prompt-input.ts';
import { buildInstructions, buildPromptLayers } from '../../pipeline/prompt-layers.ts';
import { EchoUnavailableError } from '../../pipeline/voice-pipeline.ts';
import {
  SettingsValidationError,
  StaleSettingsError,
  UnknownDeviceError,
} from '../settings/settings-store.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';
import { DeviceSetupError, NoReportedDeviceError } from './device-manager.ts';
import { type Device, DuplicateDeviceError } from './devices.repository.ts';
import { checkHost } from './host.ts';

/**
 * The devices API (spec §6). A device key is write-only: every response has
 * `hasKey`, never the key itself. Hosts are checked here and again at each
 * connect (device-manager).
 */
export function createDevicesRoutes(runtime: VoiceRuntime) {
  const { devices: manager, settings: store } = runtime;
  const sessionLog = createLogger('session');

  function deviceOr404(id: number): Device {
    const device = manager.device(id);
    if (!device) throw new AppError(404, 'NOT_FOUND', `No device #${id}.`);
    return device;
  }

  async function assertHostAllowed(host: string): Promise<void> {
    const result = await checkHost(host);
    if (!result.ok) throw validationError({ host: result.message });
  }

  function parseKey(value: string): string {
    try {
      parseApiKey(value);
      return value.trim();
    } catch {
      throw validationError({ apiKey: 'The key must be the base64 encoding of exactly 32 bytes.' });
    }
  }

  return (
    new Hono()
      .get('/devices', (c) => c.json(manager.list()))

      .post('/devices', validate('json', deviceCreateSchema), async (c) => {
        const body = c.req.valid('json');
        await assertHostAllowed(body.host);
        try {
          const created = manager.repository.create({
            name: body.name,
            kind: body.kind,
            host: body.host,
            port: body.port,
            apiKey: body.apiKey ? parseKey(body.apiKey) : null,
            enabled: body.enabled,
            prompt: body.prompt,
          });
          await manager.add(created);
          return c.json(manager.status(created), 201);
        } catch (error) {
          throw toAppError(error);
        }
      })

      // Setup wizard: what answers at an address (spec §7.3), and adoption (§7.4).
      .post('/devices/probe', validate('json', deviceProbeSchema), async (c) => {
        const body = c.req.valid('json');
        try {
          const result = await manager.probe({
            host: body.host,
            port: body.port,
            apiKey: body.apiKey ? parseKey(body.apiKey) : null,
          });
          return c.json(result);
        } catch (error) {
          throw toAppError(error);
        }
      })

      .post('/devices/adopt', validate('json', deviceAdoptSchema), async (c) => {
        const body = c.req.valid('json');
        try {
          const created = await manager.adopt({
            host: body.host,
            port: body.port,
            name: body.name,
            kind: body.kind,
            // A pasted key is validated by the manager (ECHO_KEY_INVALID when it does not match).
            apiKey: body.apiKey?.trim() || null,
          });
          // Adopting the first Echo finishes the first launch too (§5.1): the
          // owner may close the browser on the flow's last step. Only a real
          // Echo counts (`hasEcho` ignores test devices).
          if (created.kind === 'echo') runtime.setup.completeOnboarding();
          return c.json(manager.status(created), 201);
        } catch (error) {
          throw toAppError(error);
        }
      })

      .patch('/devices/:id', validate('json', deviceUpdateSchema), async (c) => {
        const id = deviceId(c.req.param('id'));
        const before = deviceOr404(id);
        const body = c.req.valid('json');
        const host = body.host ?? before.host;
        if (body.host !== undefined && body.host !== before.host) await assertHostAllowed(host);
        const apiKey =
          body.apiKey === undefined ? before.apiKey : body.apiKey === null ? null : parseKey(body.apiKey);
        try {
          const after = manager.repository.update(id, {
            name: body.name ?? before.name,
            kind: body.kind ?? before.kind,
            host,
            port: body.port ?? before.port,
            apiKey,
            enabled: body.enabled ?? before.enabled,
            prompt: body.prompt ?? before.prompt,
          });
          if (!after) throw new AppError(404, 'NOT_FOUND', `No device #${id}.`);
          await manager.update(before, after);
          return c.json(manager.status(after));
        } catch (error) {
          throw toAppError(error);
        }
      })

      .delete('/devices/:id', async (c) => {
        const id = deviceId(c.req.param('id'));
        deviceOr404(id);
        await manager.remove(id);
        manager.repository.remove(id);
        return c.body(null, 204);
      })

      .post('/devices/:id/reconnect', async (c) => {
        const id = deviceId(c.req.param('id'));
        deviceOr404(id);
        await manager.reconnect(id);
        return c.body(null, 204);
      })

      // "Secure now" (spec §7.4): the adoption key step for an existing unkeyed row.
      .post('/devices/:id/secure', async (c) => {
        const id = deviceId(c.req.param('id'));
        try {
          return c.json(manager.status(await manager.secure(id)));
        } catch (error) {
          throw toAppError(error);
        }
      })

      // The setup wizard's test sound (spec §7.5): plays the bundled chime and
      // reports whether the Echo downloaded and played it. No OpenAI call.
      .post('/devices/:id/test-sound', async (c) => {
        const id = deviceId(c.req.param('id'));
        const device = deviceOr404(id);
        const pipeline = manager.pipeline(id);
        if (!pipeline || !device.enabled) {
          throw new AppError(409, 'ECHO_UNAVAILABLE', 'This Echo is not connected.');
        }
        try {
          return c.json(await pipeline.testSound());
        } catch (error) {
          if (error instanceof EchoUnavailableError) {
            throw new AppError(409, error.code, error.message);
          }
          throw error;
        }
      })

      // "Forget conversation": drop the Echo's session (and any pending confirm).
      // Idempotent; a turn already running keeps its snapshot, as every change does.
      .post('/devices/:id/conversation/reset', (c) => {
        const id = deviceId(c.req.param('id'));
        deviceOr404(id);
        runtime.sessions.reset(`device:${id}`);
        sessionLog.info(`device ${id} conversation forgotten`);
        return c.body(null, 204);
      })

      .post('/devices/:id/accept-device', async (c) => {
        const id = deviceId(c.req.param('id'));
        deviceOr404(id);
        try {
          const accepted = await manager.acceptDevice(id);
          return c.json(manager.status(accepted));
        } catch (error) {
          if (error instanceof NoReportedDeviceError) throw new AppError(409, 'CONFLICT', error.message);
          throw error;
        }
      })

      .get('/devices/:id/settings', (c) => {
        const id = deviceId(c.req.param('id'));
        deviceOr404(id);
        return c.json(deviceSettingsDocument(runtime, id));
      })

      .patch('/devices/:id/settings', validate('json', deviceSettingsPatchSchema), (c) => {
        const id = deviceId(c.req.param('id'));
        deviceOr404(id);
        const { version, changes } = c.req.valid('json');
        try {
          store.applyDevice(id, changes, version);
        } catch (error) {
          throw toAppError(error);
        }
        return c.json(deviceSettingsDocument(runtime, id));
      })

      .get('/devices/:id/instructions', (c) => {
        const id = deviceId(c.req.param('id'));
        const device = deviceOr404(id);
        const { settings } = store.forDevice(id);
        const input = previewPromptInput({
          settings,
          device,
          deviceId: id,
          tools: runtime.tools,
        });
        const document: InstructionsDocument = {
          layers: buildPromptLayers(input),
          text: buildInstructions(input),
        };
        return c.json(document);
      })
  );
}

/** GET/PATCH /api/devices/:id/settings: the overrides and the resolved values, secrets stripped. */
function deviceSettingsDocument(runtime: VoiceRuntime, id: number): DeviceSettingsDocument {
  const { version } = runtime.settings.current();
  const effective: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(runtime.settings.effectiveValues(id))) {
    if (!isSecretSetting(key)) effective[key] = value;
  }
  return { version, overrides: runtime.settings.deviceOverrides(id), effective };
}

function deviceId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'NOT_FOUND', 'No such device.');
  return id;
}

function toAppError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof DeviceSetupError) {
    return new AppError(error.status, error.code, error.message, error.fields);
  }
  if (error instanceof SettingsValidationError) return validationError(error.fields);
  if (error instanceof StaleSettingsError) {
    return new AppError(409, 'CONFLICT', error.message, { _root: `Current version: ${error.version}.` });
  }
  if (error instanceof UnknownDeviceError) return new AppError(404, 'NOT_FOUND', error.message);
  if (error instanceof DuplicateDeviceError) {
    return new AppError(409, 'CONFLICT', error.message, { [error.field]: error.message });
  }
  return error;
}
