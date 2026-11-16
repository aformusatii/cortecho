import type { SettingDescriptor } from '@cortecho/shared';
import { displayValue, type FormValues } from '../draft.ts';
import { SettingField } from './SettingField.tsx';

export type SettingsFieldsProps = {
  descriptors: readonly SettingDescriptor[];
  values: FormValues;
  errors: Record<string, string>;
  models: readonly string[];
  hasKeys: Record<string, boolean>;
  onChange: (key: string, value: unknown) => void;
  /** Global form: every field offers "changed ↺" back to the built-in default. */
  onResetToDefault?: (key: string) => void;
  disabled?: boolean;
  /** The Advanced section itself does not nest another "Advanced" disclosure. */
  advancedDisclosure?: boolean;
};

/**
 * The fields of one or more sections, non-advanced first and the rest under an
 * "Advanced" disclosure. Without extra descriptors this is also the whole
 * per-Echo tuning form.
 */
export function SettingsFields({
  descriptors,
  values,
  errors,
  models,
  hasKeys,
  onChange,
  onResetToDefault,
  disabled = false,
  advancedDisclosure = true,
}: SettingsFieldsProps) {
  const normal = descriptors.filter((descriptor) => !descriptor.advanced || !advancedDisclosure);
  const advanced = advancedDisclosure ? descriptors.filter((descriptor) => descriptor.advanced) : [];

  const field = (descriptor: SettingDescriptor) => (
    <SettingField
      key={descriptor.key}
      descriptor={descriptor}
      value={displayValue(values, descriptor)}
      error={errors[descriptor.key]}
      suggestions={suggestionsFor(descriptor, models)}
      secretSet={hasKeys[descriptor.key]}
      onResetToDefault={onResetToDefault ? () => onResetToDefault(descriptor.key) : undefined}
      disabled={disabled}
      onChange={(value) => onChange(descriptor.key, value)}
    />
  );

  return (
    <>
      <div className="divide-y">{normal.map(field)}</div>
      {advanced.length > 0 && (
        <details className="mt-1 rounded-lg border px-3">
          <summary className="cursor-pointer py-3 text-sm font-medium select-none">Advanced</summary>
          <div className="divide-y">{advanced.map(field)}</div>
        </details>
      )}
    </>
  );
}

function suggestionsFor(descriptor: SettingDescriptor, models: readonly string[]): readonly string[] {
  if (descriptor.suggestFrom === 'openai-models') return models;
  return descriptor.options ?? [];
}
