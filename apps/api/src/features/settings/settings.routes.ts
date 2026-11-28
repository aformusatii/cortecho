import {
  type InstructionsDocument,
  isSecretSetting,
  SECRET_SETTING_KEYS,
  type SettingsDocument,
  settingsChangesQuerySchema,
  settingsPatchSchema,
} from '@cortecho/shared';
import { Hono } from 'hono';
import { AppError, validationError } from '../../lib/errors.ts';
import { validate } from '../../lib/validation.ts';
import { previewPromptInput } from '../../pipeline/prompt-input.ts';
import { buildInstructions, buildPromptLayers } from '../../pipeline/prompt-layers.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';
import { SettingsValidationError, StaleSettingsError } from './effective.ts';

/** How long the OpenAI model list is cached for the pickers. */
const MODELS_TTL_MS = 10 * 60_000;
let modelsCache: { at: number; models: string[] } | null = null;

/**
 * The settings API. Values are validated against the shared descriptors;
 * secrets are write-only (GET returns hasKeys, never a value).
 */
export function createSettingsRoutes(runtime: VoiceRuntime) {
  return new Hono()
    .get('/settings', (c) => c.json(settingsDocument(runtime)))
    .patch('/settings', validate('json', settingsPatchSchema), (c) => {
      const { version, changes } = c.req.valid('json');
      try {
        runtime.settings.apply(changes, version);
      } catch (error) {
        throw toAppError(error);
      }
      return c.json(settingsDocument(runtime));
    })
    .get('/settings/changes', validate('query', settingsChangesQuerySchema), (c) => {
      const { limit, scope } = c.req.valid('query');
      return c.json(runtime.settings.history(limit, scope));
    })
    .post('/settings/changes/:id/revert', (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'NOT_FOUND', 'No such change.');
      try {
        runtime.settings.revert(id);
      } catch (error) {
        if (error instanceof Error && error.message === 'No such change.') {
          throw new AppError(404, 'NOT_FOUND', 'No such change.');
        }
        throw toAppError(error);
      }
      return c.json(settingsDocument(runtime));
    })
    .get('/settings/instructions', (c) => {
      const { settings } = runtime.settings.current();
      const input = previewPromptInput({ settings, deviceId: null, tools: runtime.tools });
      const document: InstructionsDocument = {
        layers: buildPromptLayers(input),
        text: buildInstructions(input),
      };
      return c.json(document);
    })
    .get('/openai/models', async (c) => {
      return c.json({ models: await listModels(runtime) });
    });
}

/** The GET body: stored and resolved values with every secret stripped. */
function settingsDocument(runtime: VoiceRuntime): SettingsDocument {
  const { version } = runtime.settings.current();
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(runtime.settings.storedValues())) {
    if (!isSecretSetting(key)) stored[key] = value;
  }
  const effective: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(runtime.settings.resolvedValues())) {
    if (!isSecretSetting(key)) effective[key] = value;
  }
  const hasKeys: Record<string, boolean> = {};
  for (const key of SECRET_SETTING_KEYS) hasKeys[key] = runtime.settings.hasSecret(key);
  return { version, stored, effective, hasKeys };
}

function toAppError(error: unknown): AppError {
  if (error instanceof SettingsValidationError) {
    return validationError(error.fields);
  }
  if (error instanceof StaleSettingsError) {
    return new AppError(409, 'CONFLICT', error.message, { _root: `Current version: ${error.version}.` });
  }
  throw error;
}

/**
 * OpenAI's current model ids for the model pickers. On any failure the list is
 * empty: the fields stay free-text, so nothing depends on this call.
 */
async function listModels(runtime: VoiceRuntime): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
  const key = runtime.settings.current().settings.openai.apiKey;
  if (!key) return [];
  try {
    const response = await fetch(`${runtime.config.openai.baseUrl ?? 'https://api.openai.com/v1'}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();
    modelsCache = { at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}
