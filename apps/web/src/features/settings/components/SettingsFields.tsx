import type {
  ElevenLabsVoice,
  ElevenLabsVoiceSource,
  ProviderListReason,
  SettingDescriptor,
  VoicePreview,
} from '@cortecho/shared';
import { displayValue, type FormValues, isFieldVisible } from '../draft.ts';
import { SettingField } from './SettingField.tsx';

export type SettingsFieldsProps = {
  descriptors: readonly SettingDescriptor[];
  values: FormValues;
  errors: Record<string, string>;
  models: readonly string[];
  /** ElevenLabs model ids for the `elevenlabs-models` combobox. */
  elevenLabsModels?: readonly string[];
  /** The account's ElevenLabs voices, for the picker and its samples. */
  voices?: readonly ElevenLabsVoice[];
  /** Why that list is empty. */
  voicesReason?: ProviderListReason;
  /** Whether those voices are the account's or ElevenLabs' defaults. */
  voicesSource?: ElevenLabsVoiceSource;
  /** Why the ElevenLabs model list is empty (static suggestions remain). */
  modelsReason?: ProviderListReason;
  /** The draft voice, for "Listen here" on the voice fields. */
  listenPreview?: VoicePreview;
  /** The values `showWhen` reads (the per-Echo form passes the resolved provider). */
  providerValues?: FormValues;
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
 * per-Echo tuning form. Provider-only fields are hidden by `showWhen`; their
 * values stay in the draft.
 */
export function SettingsFields({
  descriptors,
  values,
  errors,
  models,
  elevenLabsModels = [],
  voices = [],
  voicesReason,
  voicesSource,
  modelsReason,
  listenPreview,
  providerValues,
  hasKeys,
  onChange,
  onResetToDefault,
  disabled = false,
  advancedDisclosure = true,
}: SettingsFieldsProps) {
  const visible = descriptors.filter((descriptor) => isFieldVisible(descriptor, providerValues ?? values));
  const normal = visible.filter((descriptor) => !descriptor.advanced || !advancedDisclosure);
  const advanced = advancedDisclosure ? visible.filter((descriptor) => descriptor.advanced) : [];

  const field = (descriptor: SettingDescriptor) => (
    <SettingField
      key={descriptor.key}
      descriptor={descriptor}
      value={displayValue(values, descriptor)}
      error={errors[descriptor.key]}
      suggestions={suggestionsFor(descriptor, models, elevenLabsModels)}
      voices={voices}
      voicesReason={voicesReason}
      voicesSource={voicesSource}
      modelsReason={modelsReason}
      listenPreview={listenPreview}
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

function suggestionsFor(
  descriptor: SettingDescriptor,
  models: readonly string[],
  elevenLabsModels: readonly string[],
): readonly string[] {
  if (descriptor.suggestFrom === 'openai-models') return models;
  if (descriptor.suggestFrom === 'elevenlabs-models') {
    return elevenLabsModels.length > 0 ? elevenLabsModels : (descriptor.options ?? []);
  }
  return descriptor.options ?? [];
}
