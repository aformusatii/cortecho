import { z } from 'zod';

// ---------------------------------------------------------------------------
// HTTP contract for the settings API (features/settings/settings.routes.ts).
// Values are validated against the descriptors in settings.registry.ts, so a
// change here carries unknown values on purpose and the route says which
// field failed.
// ---------------------------------------------------------------------------

export const settingsPatchSchema = z.object({
  /** The version the form was loaded with; a stale value gets 409. */
  version: z.number().int().min(0),
  /** key → new value, or null to fall back to the layer below. */
  changes: z.record(z.string(), z.unknown()),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const settingsChangesQuerySchema = z.object({
  limit: z.coerce.number<unknown>().int().min(1).max(200).default(50),
  scope: z.string().max(80).optional(),
});
export type SettingsChangesQuery = z.infer<typeof settingsChangesQuerySchema>;

/** One saved change, newest first. A secret's values are always null (never stored). */
export type SettingsChange = {
  id: number;
  at: string;
  /** 'global' or 'device:<id>'. */
  scope: string;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  version: number;
};

/** GET /api/settings: secrets appear as hasKeys, never as values. */
export type SettingsDocument = {
  version: number;
  /** Global values that differ from the built-in default (secrets omitted). */
  stored: Record<string, unknown>;
  /** The flat, resolved values an Echo without overrides gets (secrets omitted). */
  effective: Record<string, unknown>;
  /** Secret key → whether a value is set. */
  hasKeys: Record<string, boolean>;
};

/** One block of the assembled system prompt. */
export type PromptLayer = {
  layer: 1 | 2 | 3;
  title: string;
  text: string;
};

/** GET /api/settings/instructions: what the next request will send, as sent. */
export type InstructionsDocument = {
  layers: PromptLayer[];
  text: string;
};
