import { DEFAULT_SETTINGS, SETTING_DESCRIPTORS, type SettingDescriptor } from '@cortecho/shared';

// The settings forms are generated from the descriptors. These helpers are the
// only place that decides what "changed", "default", a field id and a display
// value mean, so the global Settings page and an Echo's Tuning tab agree.

export type FormValues = Record<string, unknown>;

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys whose draft value differs from what the form loaded. */
export function changedKeys(draft: FormValues, baseline: FormValues): string[] {
  const keys = new Set([...Object.keys(draft), ...Object.keys(baseline)]);
  return [...keys].filter((key) => !sameValue(draft[key], baseline[key]));
}

/** The value a control shows: the draft, else the built-in default. */
export function displayValue(values: FormValues, descriptor: SettingDescriptor): unknown {
  const value = values[descriptor.key];
  return value === undefined ? DEFAULT_SETTINGS[descriptor.key] : value;
}

/** Client-side validation of one draft: server field errors always win later. */
export function validateForm(
  descriptors: readonly SettingDescriptor[],
  draft: FormValues,
  keys: readonly string[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const key of keys) {
    const descriptor = descriptors.find((candidate) => candidate.key === key);
    if (!descriptor) continue;
    const value = draft[key];
    if (value === null || value === undefined) continue;
    const parsed = descriptor.schema.safeParse(value);
    if (!parsed.success) errors[key] = parsed.error.issues[0]?.message ?? 'This value is not valid.';
  }
  return errors;
}

export function fieldId(key: string): string {
  return `setting-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Focus the first field with an error (the caller sorts errors by page order). */
export function focusField(key: string): void {
  const element = document.getElementById(fieldId(key));
  element?.focus();
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** ms as the design shows them: seconds for sliders, ms for plain numbers. */
export function formatMilliseconds(ms: number): string {
  if (ms === 0) return '0 s';
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatValue(value: unknown, descriptor: SettingDescriptor): string {
  if (typeof value !== 'number') return String(value ?? '');
  switch (descriptor.unit) {
    case 'ms':
      return descriptor.control === 'slider' ? formatMilliseconds(value) : `${value} ms`;
    case 's':
      return `${value} s`;
    case '×':
      return `${value}×`;
    case 'dB':
      return `${value} dB`;
    case 'tokens':
      return `${value} tokens`;
    case 'chars':
      return `${value} characters`;
    default:
      return String(value);
  }
}

/** The bounds line under a field, in the same unit as the value. */
export function formatBounds(descriptor: SettingDescriptor): string {
  const { min, max, unit, control } = descriptor;
  if (typeof min !== 'number' || typeof max !== 'number') return '';
  const body =
    unit === 'ms' && control === 'slider'
      ? `${formatMilliseconds(min)} – ${formatMilliseconds(max)}`
      : `${min} – ${max}`;
  return unit ? `${body} ${unit === 'ms' && control === 'slider' ? '' : unit}`.trim() : body;
}

/** All descriptors of one section, in registry order. */
export function descriptorsOfSection(section: string): SettingDescriptor[] {
  return SETTING_DESCRIPTORS.filter((descriptor) => descriptor.section === section);
}
