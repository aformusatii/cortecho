import {
  type DeviceStatus,
  type ElevenLabsVoice,
  type ProviderListReason,
  SETTINGS_SECTION_LABELS,
  type SectionId,
  type SettingDescriptor,
  type VoicePreview,
} from '@cortecho/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { FormValues } from '../draft.ts';
import { SettingsFields } from './SettingsFields.tsx';

export type OverriddenNote = { device: DeviceStatus; labels: string[] };

export type SettingsSectionProps = {
  section: SectionId;
  descriptors: readonly SettingDescriptor[];
  values: FormValues;
  errors: Record<string, string>;
  models: readonly string[];
  elevenLabsModels?: readonly string[];
  voices?: readonly ElevenLabsVoice[];
  voicesReason?: ProviderListReason;
  modelsReason?: ProviderListReason;
  listenPreview?: VoicePreview;
  providerValues?: FormValues;
  hasKeys: Record<string, boolean>;
  dirty: boolean;
  overriddenBy?: OverriddenNote[];
  onChange: (key: string, value: unknown) => void;
  onResetToDefault?: (key: string) => void;
  /** Phone: the section collapses into an accordion. */
  collapsed?: boolean;
  /** Extra controls after the fields (e.g. "Show the full prompt", the test phrase). */
  footer?: ReactNode;
};

/**
 * One settings section: a heading with the unsaved dot, the generated fields,
 * and the Echos that override its keys. On a phone it is a <details> so the
 * page is not one endless scroll.
 */
export function SettingsSection({
  section,
  descriptors,
  values,
  errors,
  models,
  elevenLabsModels = [],
  voices = [],
  voicesReason,
  modelsReason,
  listenPreview,
  providerValues,
  hasKeys,
  dirty,
  overriddenBy = [],
  onChange,
  onResetToDefault,
  collapsed = false,
  footer,
}: SettingsSectionProps) {
  const fields = (
    <>
      <SettingsFields
        descriptors={descriptors}
        values={values}
        errors={errors}
        models={models}
        elevenLabsModels={elevenLabsModels}
        voices={voices}
        voicesReason={voicesReason}
        modelsReason={modelsReason}
        listenPreview={listenPreview}
        providerValues={providerValues}
        hasKeys={hasKeys}
        onChange={onChange}
        onResetToDefault={onResetToDefault}
        advancedDisclosure={section !== 'advanced'}
      />
      {footer && <div className="border-t py-3">{footer}</div>}
      {overriddenBy.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Overridden on:{' '}
          {overriddenBy.map((entry, index) => (
            <span key={entry.device.id}>
              {index > 0 && ', '}
              <Link
                to="/echos/$id"
                params={{ id: String(entry.device.id) }}
                search={{ tab: 'tuning' }}
                className="font-medium text-foreground underline underline-offset-2"
              >
                {entry.device.name}
              </Link>{' '}
              ({entry.labels.join(', ')})
            </span>
          ))}
        </p>
      )}
    </>
  );

  const [open, setOpen] = useState(false);

  // A Fix link from the status page lands on `#section-network`; on a phone the
  // section is a collapsed <details>, so the anchor must open it itself.
  useEffect(() => {
    if (!collapsed) return;
    const reveal = () => {
      if (window.location.hash !== `#section-${section}`) return;
      setOpen(true);
      document.getElementById(`section-${section}`)?.scrollIntoView();
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [collapsed, section]);

  const title = (
    <span className="inline-flex items-center gap-2">
      {SETTINGS_SECTION_LABELS[section]}
      {dirty && (
        <>
          <span aria-hidden="true" className="size-2 rounded-full bg-signal" />
          <span className="sr-only">unsaved changes</span>
        </>
      )}
    </span>
  );

  if (collapsed) {
    return (
      <details
        id={`section-${section}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="scroll-mt-24 rounded-xl border bg-card shadow-xs"
      >
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 text-base font-semibold select-none">
          {title}
          <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        </summary>
        <div className="px-4 pb-3">{fields}</div>
      </details>
    );
  }

  return (
    <section
      id={`section-${section}`}
      aria-labelledby={`section-${section}-title`}
      className="scroll-mt-24 rounded-xl border bg-card px-4 py-3 shadow-xs"
    >
      <h2 id={`section-${section}-title`} className="py-2 text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {fields}
    </section>
  );
}
