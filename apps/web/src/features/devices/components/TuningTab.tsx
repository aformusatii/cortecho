import {
  type DeviceSettingsDocument,
  type DeviceStatus,
  SETTING_DESCRIPTORS,
  SETTING_SECTIONS,
  SETTINGS_SECTION_LABELS,
  type SettingDescriptor,
} from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { settingsQueryOptions } from '@/features/settings/api/settings.queries.ts';
import { SaveBar } from '@/features/settings/components/SaveBar.tsx';
import { SettingField } from '@/features/settings/components/SettingField.tsx';
import {
  changedKeys,
  type FormValues,
  focusField,
  formatValue,
  validateForm,
} from '@/features/settings/draft.ts';
import { isApiError } from '@/lib/api-client.ts';
import { useSaveDeviceSettings } from '../api/devices.mutations.ts';
import { deviceSettingsQueryOptions } from '../api/devices.queries.ts';

const PER_ECHO = SETTING_DESCRIPTORS.filter((descriptor) => descriptor.perEcho);

/**
 * Per-Echo overrides (§9.7): only the room-dependent keys. Each row shows the
 * global value and an Override switch; off means inherit (`null`), never a
 * copy of the global value. The form carries the same settings version as the
 * global page, so a save can 409 here too.
 */
export function TuningTab({ device }: { device: DeviceStatus }) {
  const document = useQuery(deviceSettingsQueryOptions(device.id));
  const global = useQuery(settingsQueryOptions());
  const save = useSaveDeviceSettings(device.id);

  const [draft, setDraft] = useState<FormValues | null>(null);
  const [baseline, setBaseline] = useState<FormValues | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const seeded = useRef<number | null>(null);
  const awaitingConflict = useRef(false);

  useEffect(() => {
    if (!document.data) return;
    if (seeded.current === null) {
      seeded.current = document.data.version;
      setDraft({ ...document.data.overrides });
      setBaseline({ ...document.data.overrides });
    } else if (awaitingConflict.current) {
      awaitingConflict.current = false;
      setBaseline({ ...document.data.overrides });
    }
  }, [document.data]);

  const values = draft ?? {};
  const dirty = baseline ? changedKeys(values, baseline) : [];

  function setValue(key: string, value: unknown) {
    setDraft((previous) => ({ ...(previous ?? {}), [key]: value }));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function toggle(descriptor: SettingDescriptor, on: boolean) {
    if (!on) {
      setDraft((previous) => {
        if (!previous) return previous;
        const next = { ...previous };
        delete next[descriptor.key];
        return next;
      });
      return;
    }
    const globalValue = global.data?.effective[descriptor.key] ?? descriptor.default;
    setValue(descriptor.key, globalValue);
  }

  function discard() {
    setDraft(baseline ? { ...baseline } : {});
    setErrors({});
    setConflictVersion(null);
  }

  function handleSave() {
    if (!document.data || !draft || !baseline) return;
    const keys = changedKeys(draft, baseline);
    const found = validateForm(PER_ECHO, draft, keys);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      const first = PER_ECHO.find((descriptor) => descriptor.key in found);
      if (first) focusField(first.key);
      return;
    }
    setErrors({});
    const changes = Object.fromEntries(keys.map((key) => [key, draft[key] ?? null]));
    save.mutate(
      { version: document.data.version, changes },
      {
        onSuccess: (next) => {
          adopt(next, setDraft, setBaseline, seeded);
          setConflictVersion(null);
          toast.success('This Echo’s settings saved.');
        },
        onError: (error) => {
          if (isApiError(error) && error.status === 409) {
            awaitingConflict.current = true;
            setConflictVersion(document.data.version);
            void document.refetch();
            return;
          }
          if (isApiError(error)) {
            const fields = Object.fromEntries(
              Object.entries(error.fields).filter(([key]) => key !== '_root'),
            );
            setErrors(fields);
            const first = PER_ECHO.find((descriptor) => descriptor.key in fields);
            if (first) focusField(first.key);
            toast.error(error.fields._root ?? error.message);
            return;
          }
          toast.error(error instanceof Error ? error.message : 'Could not save.');
        },
      },
    );
  }

  if (document.isPending) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="sr-only">Loading this Echo’s settings…</span>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (document.isError || !document.data) {
    return (
      <div role="alert" className="rounded-xl border bg-card p-6 text-center">
        <p className="font-medium">Could not load this Echo’s settings</p>
        <p className="text-sm text-muted-foreground">
          {document.error?.message ?? 'The server did not return a settings document.'}
        </p>
        <Button variant="outline" className="mt-3" onClick={() => document.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!draft || !baseline) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="sr-only">Loading this Echo’s settings…</span>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const globalValues = global.data?.effective ?? {};

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Overrides only the knobs that depend on the room. Everything else, and every value switched off here,
        comes from <strong>Settings</strong>.
      </p>

      {conflictVersion !== null && (
        <Alert>
          <AlertTitle>These settings changed in another tab</AlertTitle>
          <AlertDescription>
            Your unsaved overrides are kept. Reapply them, or discard them and use the saved values.
            <span className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={save.isPending || document.data?.version === conflictVersion}
              >
                Reapply my changes
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={discard}>
                Discard mine
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      {SETTING_SECTIONS.map((section) => {
        const descriptors = PER_ECHO.filter((descriptor) => descriptor.section === section);
        if (descriptors.length === 0) return null;
        return (
          <section
            key={section}
            aria-labelledby={`tuning-${section}`}
            className="rounded-xl border bg-card px-4 py-3 shadow-xs"
          >
            <h2 id={`tuning-${section}`} className="py-2 text-lg font-semibold tracking-tight">
              {SETTINGS_SECTION_LABELS[section]}
            </h2>
            <div className="divide-y">
              {descriptors.map((descriptor) => {
                const overridden = descriptor.key in draft;
                const globalValue = globalValues[descriptor.key] ?? descriptor.default;
                return (
                  <SettingField
                    key={descriptor.key}
                    descriptor={descriptor}
                    value={overridden ? draft[descriptor.key] : globalValue}
                    error={errors[descriptor.key]}
                    caption={`Global: ${formatValue(globalValue, descriptor)}`}
                    inherited={overridden ? undefined : 'Inherits the global value.'}
                    disabled={!overridden}
                    headerAction={
                      <Switch
                        checked={overridden}
                        aria-label={`Override ${descriptor.label}`}
                        onCheckedChange={(on) => toggle(descriptor, on)}
                      />
                    }
                    onChange={(value) => setValue(descriptor.key, value)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      <SaveBar
        count={dirty.length}
        saving={save.isPending}
        onDiscard={discard}
        onSave={handleSave}
        saveLabel="Save for this Echo"
      />
    </div>
  );
}

function adopt(
  document: DeviceSettingsDocument,
  setDraft: (values: FormValues) => void,
  setBaseline: (values: FormValues) => void,
  seeded: RefObject<number | null>,
) {
  setDraft({ ...document.overrides });
  setBaseline({ ...document.overrides });
  seeded.current = document.version;
}
