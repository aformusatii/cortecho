import {
  type DeviceSettingsDocument,
  deviceCreateSchema,
  deviceSettingsPatchSchema,
  deviceUpdateSchema,
  type InstructionsDocument,
  isSecretSetting,
} from '@cortecho/shared';
import { Hono } from 'hono';
import { parseApiKey } from '../../esphome/noise.ts';
import { AppError, validationError } from '../../lib/errors.ts';
import { validate } from '../../lib/validation.ts';
import { listenToolOptions } from '../../pipeline/listen-tool.ts';
import { buildInstructions, buildPromptLayers } from '../../pipeline/prompt-layers.ts';
import {
  SettingsValidationError,
  StaleSettingsError,
  UnknownDeviceError,
} from '../settings/settings-store.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';
import { NoReportedDeviceError } from './device-manager.ts';
import { type Device, DuplicateDeviceError } from './devices.repository.ts';
import { checkHost } from './host.ts';

/**
 * The devices API (spec §6). A device key is write-only: every response has
 * `hasKey`, never the key itself. Hosts are checked here and again at each
 * connect (device-manager).
 */
export function createDevicesRoutes(runtime: VoiceRuntime) {
  const { devices: manager, settings: store } = runtime;

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

  return new Hono()
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
      const input = { settings, listenTool: listenToolOptions(settings), device };
      const document: InstructionsDocument = {
        layers: buildPromptLayers(input),
        text: buildInstructions(input),
      };
      return c.json(document);
    });
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
