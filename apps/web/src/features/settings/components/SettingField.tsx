import type {
  ElevenLabsVoice,
  ElevenLabsVoiceSource,
  ProviderListReason,
  SettingDescriptor,
  VoicePreview,
} from '@cortecho/shared';
import { RotateCcwIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Combobox } from '@/components/ui/combobox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { fieldId, formatBounds, formatValue } from '../draft.ts';
import { VoicePicker } from './VoicePicker.tsx';
import { VoiceSampleButton } from './VoiceSampleButton.tsx';

export type SettingFieldProps = {
  descriptor: SettingDescriptor;
  value: unknown;
  error?: string;
  /** Global form: shows "default" or "changed ↺" (reset to the built-in default). */
  onResetToDefault?: () => void;
  /** Model ids for a `suggestFrom` combobox (free text still allowed). */
  suggestions?: readonly string[];
  /** The account's voices, for `suggestFrom: 'elevenlabs-voices'`. */
  voices?: readonly ElevenLabsVoice[];
  /** Why the voice list is empty, so the one helper line can say it. */
  voicesReason?: ProviderListReason;
  /** Whether the shown voices are the account's or ElevenLabs' defaults. */
  voicesSource?: ElevenLabsVoiceSource;
  /** Why the model list is empty (the static suggestions still work). */
  modelsReason?: ProviderListReason;
  /** The draft voice, for "Listen here" on the voice fields (both providers). */
  listenPreview?: VoicePreview;
  /** Shown instead of a control when the value is inherited from the global layer. */
  inherited?: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
  /** Overrides the descriptor's own label (the tuning rows keep it). */
  label?: string;
  /** For a secret: whether the API has a value stored (the value itself never reaches the browser). */
  secretSet?: boolean;
  /** A control in the label row (the tuning form's Override switch). */
  headerAction?: ReactNode;
  /** One line under the label (e.g. the global value in the tuning form). */
  caption?: string;
};

/**
 * One setting, rendered from its descriptor: control, unit, bounds, help and
 * the default/changed marker. Labels are tied to inputs and help/error text is
 * linked with aria-describedby, so a screen reader reads the whole row.
 */
export function SettingField({
  descriptor,
  value,
  error,
  onResetToDefault,
  suggestions = [],
  voices = [],
  voicesReason,
  voicesSource,
  modelsReason,
  listenPreview,
  inherited,
  disabled = false,
  onChange,
  label,
  secretSet = false,
  headerAction,
  caption,
}: SettingFieldProps) {
  const id = fieldId(descriptor.key);
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [helpId, error ? errorId : null].filter(Boolean).join(' ');
  const isDefault = sameAsDefault(descriptor, value);
  const text = label ?? descriptor.label;
  const counter =
    descriptor.maxLength !== undefined && typeof value === 'string'
      ? `${value.length} / ${descriptor.maxLength}`
      : null;

  return (
    <div className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={id} className="text-sm">
          {text}
        </Label>
        <span className="inline-flex items-center gap-2">
          {counter && <span className="text-xs text-muted-foreground tabular-nums">{counter}</span>}
          {headerAction}
          {descriptor.secret ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              {secretSet ? 'set' : 'not set'}
              {onResetToDefault && (secretSet || value !== '' || value === null) && (
                <button
                  type="button"
                  onClick={onResetToDefault}
                  className="rounded-md px-1 font-medium text-foreground underline underline-offset-2 hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Remove key
                </button>
              )}
            </span>
          ) : onResetToDefault ? (
            isDefault ? (
              <span className="text-xs text-muted-foreground">default</span>
            ) : (
              <button
                type="button"
                onClick={onResetToDefault}
                className="inline-flex items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                title="Reset to the default"
              >
                changed <RotateCcwIcon aria-hidden="true" className="size-3" />
                <span className="sr-only">Reset {text} to the default</span>
              </button>
            )
          ) : null}
        </span>
      </div>

      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}

      {inherited !== undefined ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">{inherited}</p>
      ) : (
        <Control
          descriptor={descriptor}
          id={id}
          label={text}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          invalid={Boolean(error)}
          suggestions={suggestions}
          voices={voices}
          onChange={onChange}
        />
      )}

      {listenPreview && (descriptor.key === 'tts.voice' || descriptor.key === 'tts.elevenlabsVoiceId') && (
        <div className="flex items-center gap-2">
          <VoiceSampleButton preview={listenPreview} />
        </div>
      )}

      {descriptor.control === 'slider' && inherited === undefined && (
        <p className="text-xs font-medium text-foreground tabular-nums" aria-live="off">
          {formatValue(value, descriptor)}
        </p>
      )}

      <p id={helpId} className="text-xs text-muted-foreground">
        {voiceHelp(descriptor, voices.length, voicesReason, voicesSource) ??
          modelHelp(descriptor, modelsReason) ??
          descriptor.help}
        {formatBounds(descriptor) && ` (${formatBounds(descriptor)})`}
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One helper line under a field. For the ElevenLabs picker the reason replaces
 * the generic help: a scoped key gets the default voices and can still paste an
 * id. With no list at all, the reason explains why.
 */
function voiceHelp(
  descriptor: SettingDescriptor,
  voiceCount: number,
  reason: ProviderListReason | undefined,
  source: ElevenLabsVoiceSource | undefined,
): string | null {
  if (descriptor.suggestFrom !== 'elevenlabs-voices') return null;
  if (voiceCount > 0) {
    if (source !== 'premade') return null;
    switch (reason) {
      case 'missing-permission':
        return "Showing ElevenLabs' default voices. This key cannot list your own voices (it needs Voices → Read); you can still paste any voice id.";
      case 'unavailable':
        return "Showing ElevenLabs' default voices because the voice list could not be loaded; you can still paste any voice id.";
      default:
        return "Showing ElevenLabs' default voices; you can still paste any voice id.";
    }
  }
  switch (reason) {
    case 'no-key':
      return 'Add the ElevenLabs key under Providers to list your voices; you can still paste a voice id.';
    case 'missing-permission':
      return 'This key cannot list voices (it needs Voices → Read). Paste a voice id, or add that permission in ElevenLabs.';
    case 'unavailable':
      return 'Could not load the voices; check the connection. You can still paste a voice id.';
    default:
      return null;
  }
}

/** The same, for the model suggestions: the static list is still usable. */
function modelHelp(descriptor: SettingDescriptor, reason: ProviderListReason | undefined): string | null {
  if (descriptor.suggestFrom !== 'elevenlabs-models') return null;
  switch (reason) {
    case 'no-key':
      return 'Add the ElevenLabs key under Providers to load the model list; the suggested models still work.';
    case 'missing-permission':
      return 'This key cannot list models (it needs Models → Read); the suggested models still work.';
    case 'unavailable':
      return 'Could not load the model list; the suggested models still work.';
    default:
      return null;
  }
}

function sameAsDefault(descriptor: SettingDescriptor, value: unknown): boolean {
  if (value === descriptor.default) return true;
  if (value === null || value === undefined) return descriptor.default === null;
  return JSON.stringify(value) === JSON.stringify(descriptor.default);
}

type ControlProps = {
  descriptor: SettingDescriptor;
  id: string;
  label: string;
  value: unknown;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  suggestions: readonly string[];
  voices: readonly ElevenLabsVoice[];
  onChange: (value: unknown) => void;
};

function Control({
  descriptor,
  id,
  label,
  value,
  disabled,
  describedBy,
  invalid,
  suggestions,
  voices,
  onChange,
}: ControlProps) {
  const shared = {
    id,
    disabled,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
  };

  switch (descriptor.control) {
    case 'switch':
      return (
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          aria-describedby={describedBy}
          onCheckedChange={(checked) => onChange(checked)}
        />
      );
    case 'textarea':
      return (
        <Textarea
          {...shared}
          rows={4}
          maxLength={descriptor.maxLength}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'number':
      return (
        <div className="flex items-center gap-2">
          <Input
            {...shared}
            type="number"
            inputMode="decimal"
            min={descriptor.min}
            max={descriptor.max}
            step={descriptor.step}
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(raw === '' ? '' : Number(raw));
            }}
            className="max-w-48"
          />
          {descriptor.unit && descriptor.unit !== 'chars' && (
            <span className="text-sm text-muted-foreground">{unitSuffix(descriptor)}</span>
          )}
        </div>
      );
    case 'slider':
      return (
        <input
          {...shared}
          type="range"
          min={descriptor.min}
          max={descriptor.max}
          step={descriptor.step}
          value={typeof value === 'number' ? value : Number(descriptor.default)}
          aria-valuetext={formatValue(value, descriptor)}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-11 w-full max-w-md accent-primary disabled:opacity-50"
        />
      );
    case 'select':
      return (
        <select
          {...shared}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => {
            const next = event.target.value;
            onChange(isNumericOptions(descriptor) ? Number(next) : next);
          }}
          className="h-11 w-full max-w-md rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {(descriptor.options ?? []).map((option) => (
            <option key={option} value={option}>
              {descriptor.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
      );
    case 'combobox':
      if (descriptor.suggestFrom === 'elevenlabs-voices') {
        return (
          <VoicePicker
            id={id}
            value={typeof value === 'string' ? value : ''}
            voices={voices}
            disabled={disabled}
            invalid={invalid}
            describedBy={describedBy}
            onChange={(next) => onChange(next)}
          />
        );
      }
      return (
        <Combobox
          id={id}
          value={typeof value === 'string' ? value : ''}
          options={suggestions}
          label={label}
          disabled={disabled}
          invalid={invalid}
          describedBy={describedBy}
          onChange={(next) => onChange(next)}
        />
      );
    case 'tags':
      return (
        <TagsInput
          id={id}
          disabled={disabled}
          describedBy={describedBy}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={onChange}
        />
      );
    case 'text':
      return (
        <Input
          {...shared}
          type={descriptor.secret ? 'password' : 'text'}
          maxLength={descriptor.maxLength}
          autoComplete={descriptor.secret ? 'new-password' : 'off'}
          value={typeof value === 'string' ? value : ''}
          placeholder={descriptor.secret ? 'Leave empty to keep the current key' : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={descriptor.secret ? 'max-w-md' : undefined}
        />
      );
    default:
      return null;
  }
}

function unitSuffix(descriptor: SettingDescriptor): string {
  if (descriptor.unit === 'ms') return 'ms';
  return descriptor.unit ?? '';
}

function isNumericOptions(descriptor: SettingDescriptor): boolean {
  return (descriptor.options ?? []).every((option) => /^-?\d+$/.test(option));
}

function TagsInput({
  id,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  id: string;
  value: string[];
  disabled: boolean;
  describedBy: string;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(value.join(', '));
  // Reset from outside (the ↺ button, a reload) must reach the input.
  const joined = value.join(', ');
  useEffect(() => {
    setText(joined);
  }, [joined]);
  return (
    <Input
      id={id}
      disabled={disabled}
      aria-describedby={describedBy}
      value={text}
      autoComplete="off"
      spellCheck={false}
      placeholder="en, ro"
      onChange={(event) => {
        setText(event.target.value);
        onChange(
          event.target.value
            .split(/[\s,]+/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        );
      }}
      className="max-w-md"
    />
  );
}
