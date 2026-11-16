import {
  type DeviceStatus,
  SETTINGS_SECTION_LABELS,
  type SectionId,
  type SettingDescriptor,
} from '@cortecho/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FormValues } from '../draft.ts';
import { SettingsFields } from './SettingsFields.tsx';

export type OverriddenNote = { device: DeviceStatus; labels: string[] };

export type SettingsSectionProps = {
  section: SectionId;
  descriptors: readonly SettingDescriptor[];
  values: FormValues;
  errors: Record<string, string>;
  models: readonly string[];
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
      <details id={`section-${section}`} className="scroll-mt-24 rounded-xl border bg-card shadow-xs">
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
