import { buildSettings, DEFAULT_SETTINGS, SETTING_BY_KEY, type Settings } from '@cortecho/shared';

// ---------------------------------------------------------------------------
// Validation and resolution for settings: the only place that decides whether
// a set of values is acceptable. Everything is checked on the resolved
// snapshot at save time, so a turn never discovers an invalid combination.
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;

/** Thrown for values the descriptors reject; the route turns it into 400 + fields. */
export class SettingsValidationError extends Error {
  readonly fields: FieldErrors;
  constructor(fields: FieldErrors) {
    super('Some settings are not valid.');
    this.name = 'SettingsValidationError';
    this.fields = fields;
  }
}

/** Thrown when a PATCH carries an old version (another tab saved first). */
export class StaleSettingsError extends Error {
  readonly version: number;
  constructor(version: number) {
    super('The settings changed in another tab. Reload and try again.');
    this.name = 'StaleSettingsError';
    this.version = version;
  }
}

/** The defaults ⊕ the stored values ⊕ one device's overrides. Null = not set. */
export function resolveSettings(
  stored: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): Settings {
  return buildSettings({ ...DEFAULT_SETTINGS, ...withoutNulls(stored), ...withoutNulls(overrides) });
}

function withoutNulls(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Checks one value against its descriptor and returns it. Unknown keys are a
 * field error (the UI may only send keys the registry knows).
 */
export function validateValue(key: string, value: unknown): unknown {
  const descriptor = SETTING_BY_KEY.get(key);
  if (!descriptor) throw new SettingsValidationError({ [key]: 'Unknown setting.' });
  // null is always allowed: it means "back to the default" / "inherit".
  if (value === null) return null;
  const parsed = descriptor.schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SettingsValidationError({
      [key]: issue?.message ?? 'This value is not valid.',
    });
  }
  return parsed.data;
}

/** Validates a whole change map; returns the normalised values. */
export function validateChanges(changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: FieldErrors = {};
  const normalised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    try {
      normalised[key] = validateValue(key, value);
    } catch (error) {
      if (error instanceof SettingsValidationError) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  if (Object.keys(fields).length > 0) throw new SettingsValidationError(fields);
  return normalised;
}

/**
 * Cross-field rules. hassmic ends a listening phase after 30 s (PIPELINE_TIMEOUT),
 * so no single wait may outlast it, and the follow-up bounds must nest.
 */
export function crossFieldErrors(settings: Settings): FieldErrors {
  const fields: FieldErrors = {};
  if (settings.followUp.minWaitMs > settings.followUp.maxWaitMs) {
    fields['followUp.maxWaitMs'] = 'The longest wait must not be shorter than the shortest one.';
  }
  if (settings.followUp.maxWaitMs > 20000) {
    fields['followUp.maxWaitMs'] = 'hassmic stops listening after 30 s; keep this at 20 s or less.';
  }
  if (settings.vad.noSpeechTimeoutMs > 30000) {
    fields['vad.noSpeechTimeoutMs'] = 'hassmic stops listening after 30 s.';
  }
  if (settings.vad.maxUtteranceMs > 30000) {
    fields['vad.maxUtteranceMs'] = 'hassmic stops listening after 30 s.';
  }
  if (settings.echo.reconnectMinMs > settings.echo.reconnectMaxMs) {
    fields['echo.reconnectMaxMs'] = 'The longest reconnect delay must not be shorter than the shortest one.';
  }
  if (settings.echo.pingIntervalMs >= settings.echo.pingTimeoutMs) {
    fields['echo.pingTimeoutMs'] = 'The ping timeout must be longer than the ping interval.';
  }
  return fields;
}

/** Throws when the resolved snapshot breaks a cross-field rule. */
export function assertValidSettings(settings: Settings): void {
  const fields = crossFieldErrors(settings);
  if (Object.keys(fields).length > 0) throw new SettingsValidationError(fields);
}
