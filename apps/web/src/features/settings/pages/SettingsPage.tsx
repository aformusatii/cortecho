import {
  SETTING_BY_KEY,
  SETTING_DESCRIPTORS,
  SETTING_SECTIONS,
  SETTINGS_SECTION_LABELS,
  type SectionId,
  type SettingsDocument,
} from '@cortecho/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { FileTextIcon, HistoryIcon, RefreshCwIcon } from 'lucide-react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ConnectorsTab } from '@/features/connectors/pages/ConnectorsTab.tsx';
import { useReconnectDevice } from '@/features/devices/api/devices.mutations.ts';
import { deviceSettingsQueryOptions, devicesQueryOptions } from '@/features/devices/api/devices.queries.ts';
import { TestSoundButton } from '@/features/setup/components/TestSoundButton.tsx';
import { isApiError } from '@/lib/api-client.ts';
import { useMediaQuery } from '@/lib/use-media-query.ts';
import { useSaveSettings } from '../api/settings.mutations.ts';
import {
  elevenLabsModelsQueryOptions,
  elevenLabsVoicesQueryOptions,
  openaiModelsQueryOptions,
  settingsQueryOptions,
} from '../api/settings.queries.ts';
import { FullPromptDialog } from '../components/FullPromptDialog.tsx';
import { ProvidersPanel } from '../components/ProvidersPanel.tsx';
import { SaveBar } from '../components/SaveBar.tsx';
import { SettingsHistoryDialog } from '../components/SettingsHistoryDialog.tsx';
import { type OverriddenNote, SettingsSection } from '../components/SettingsSection.tsx';
import { SettingsTabs } from '../components/SettingsTabs.tsx';
import { VoicePipeline } from '../components/VoicePipeline.tsx';
import { VoiceTestPhrase } from '../components/VoiceTestPhrase.tsx';
import {
  changedKeys,
  descriptorsOfSection,
  type FormValues,
  focusField,
  validateForm,
  voicePreviewFrom,
} from '../draft.ts';

type SettingsTab = 'general' | 'providers';

/**
 * `/settings?tab=general|providers|connectors`. General and Providers are the
 * same versioned settings document (save bar, history, 409 flow); the tab only
 * chooses which sections are rendered. Connectors is a runtime page.
 */
export function SettingsPage() {
  const search = useSearch({ from: '/settings' });

  if (search.tab === 'connectors') {
    return <ConnectorsSettings />;
  }

  return <SettingsDocumentForm tab={search.tab === 'providers' ? 'providers' : 'general'} />;
}

function ConnectorsSettings() {
  const search = useSearch({ from: '/settings' });
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connected services the voice agent may use. Changes apply from the next request.
        </p>
      </header>
      <SettingsTabs />
      <ConnectorsTab
        serverId={search.server}
        auth={search.auth as 'ok' | 'error' | undefined}
        reason={search.reason}
        onConsumed={() => void navigate({ to: '/settings', search: { tab: 'connectors' }, replace: true })}
      />
    </div>
  );
}

/**
 * The global settings: every descriptor rendered from the registry, one
 * versioned document, a sticky save bar, and a 409 flow that keeps the unsaved
 * values and offers to reapply them. The draft lives above the tab switch, so
 * moving General ↔ Providers keeps unsaved edits.
 */
function SettingsDocumentForm({ tab }: { tab: SettingsTab }) {
  const settings = useQuery(settingsQueryOptions());
  const devices = useQuery(devicesQueryOptions());
  const models = useQuery(openaiModelsQueryOptions());
  const document = settings.data;
  const hasElevenLabsKey = document?.hasKeys['elevenlabs.apiKey'] === true;
  const elevenLabsVoices = useQuery(elevenLabsVoicesQueryOptions(hasElevenLabsKey));
  const elevenLabsModels = useQuery(elevenLabsModelsQueryOptions(hasElevenLabsKey));
  const save = useSaveSettings();
  const reconnect = useReconnectDevice();
  const isPhone = !useMediaQuery('(min-width: 1024px)');
  const navigate = useNavigate();

  const [draft, setDraft] = useState<FormValues | null>(null);
  const [baseline, setBaseline] = useState<FormValues | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const seededVersion = useRef<number | null>(null);
  const awaitingConflict = useRef(false);

  // Seed once; after a 409 the refetched values become the new baseline but
  // the owner's unsaved draft is kept so it can be reapplied.
  useEffect(() => {
    if (!document) return;
    if (seededVersion.current === null) {
      seededVersion.current = document.version;
      const initial = seed(document);
      setDraft(initial);
      setBaseline(initial);
    } else if (awaitingConflict.current) {
      awaitingConflict.current = false;
      setBaseline(seed(document));
    }
  }, [document]);

  const deviceList = devices.data ?? [];
  const deviceDocuments = useQueries({
    queries: deviceList.map((device) => deviceSettingsQueryOptions(device.id)),
  });

  const overriddenBy = useMemo(() => {
    const result = new Map<SectionId, OverriddenNote[]>();
    deviceList.forEach((device, index) => {
      const overrides = deviceDocuments[index]?.data?.overrides ?? {};
      for (const section of SETTING_SECTIONS) {
        const labels = Object.keys(overrides)
          .map((key) => SETTING_BY_KEY.get(key))
          .filter((descriptor) => descriptor?.section === section)
          .map((descriptor) => descriptor?.label.toLowerCase() ?? '');
        if (labels.length === 0) continue;
        const entries = result.get(section) ?? [];
        entries.push({ device, labels });
        result.set(section, entries);
      }
    });
    return result;
  }, [deviceList, deviceDocuments]);

  const voiceNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const voice of elevenLabsVoices.data?.voices ?? []) names[voice.id] = voice.name;
    return names;
  }, [elevenLabsVoices.data]);

  const elevenLabsModelIds = useMemo(
    () =>
      (elevenLabsModels.data?.models ?? [])
        .filter((model) => model.canDoTextToSpeech)
        .map((model) => model.id),
    [elevenLabsModels.data],
  );

  const dirty = draft && baseline ? changedKeys(draft, baseline) : [];
  const dirtySet = new Set(dirty);

  function setValue(key: string, value: unknown) {
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function discard() {
    setDraft(baseline);
    setErrors({});
    setConflictVersion(null);
  }

  function handleSave() {
    if (!document || !draft || !baseline) return;
    const keys = changedKeys(draft, baseline);
    const found = validateForm(SETTING_DESCRIPTORS, draft, keys);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      focusFirst(found);
      return;
    }
    setErrors({});
    const changes = Object.fromEntries(keys.map((key) => [key, draft[key] ?? null]));
    save.mutate(
      { version: document.version, changes },
      {
        onSuccess: (next) => {
          admit(next, setDraft, setBaseline, seededVersion);
          setErrors({});
          setConflictVersion(null);
          toast.success('Settings saved.');
        },
        onError: (error) => {
          if (isApiError(error) && error.status === 409) {
            awaitingConflict.current = true;
            setConflictVersion(document.version);
            void settings.refetch();
            return;
          }
          if (isApiError(error)) {
            const fields = Object.fromEntries(
              Object.entries(error.fields).filter(([key]) => key !== '_root'),
            );
            setErrors(fields);
            focusFirst(fields);
            toast.error(error.fields._root ?? error.message);
            return;
          }
          toast.error(error instanceof Error ? error.message : 'Could not save.');
        },
      },
    );
  }

  function goToSection(section: string): void {
    if (tab !== 'general') {
      setPendingSection(section);
      void navigate({ to: '/settings', search: { tab: 'general' }, replace: true });
      return;
    }
    scrollToSection(section);
  }

  // The tab switched after a pipeline click: scroll once the section exists.
  useEffect(() => {
    if (pendingSection === null || tab !== 'general') return;
    const frame = requestAnimationFrame(() => {
      scrollToSection(pendingSection);
      setPendingSection(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingSection, tab]);

  if (settings.isPending) {
    return (
      <div className="space-y-4" role="status" aria-busy="true">
        <span className="sr-only">Loading settings…</span>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (settings.isError || !document) {
    return (
      <div role="alert" className="space-y-3 rounded-xl border bg-card p-6 text-center">
        <p className="font-medium">Could not load the settings</p>
        <p className="text-sm text-muted-foreground">
          {settings.error?.message ?? 'The server did not return a settings document.'}
        </p>
        <Button variant="outline" onClick={() => settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // The document arrived but the seeding effect has not run yet: one frame of
  // skeleton, never the error card.
  if (!draft || !baseline) {
    return (
      <div role="status" aria-busy="true" className="space-y-4">
        <span className="sr-only">Loading settings…</span>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const hasKey = (key: string): boolean =>
    document.hasKeys[key] === true || (typeof draft[key] === 'string' && (draft[key] as string) !== '');
  const voicePreview = voicePreviewFrom(draft);
  const saveBar = (
    <SaveBar count={dirty.length} saving={save.isPending} onDiscard={discard} onSave={handleSave} />
  );
  const sharedSectionProps = {
    values: draft,
    errors,
    models: models.data?.models ?? [],
    elevenLabsModels: elevenLabsModelIds,
    voices: elevenLabsVoices.data?.voices ?? [],
    // The query is disabled without a key; the picker still needs the reason.
    voicesReason: hasElevenLabsKey ? elevenLabsVoices.data?.reason : 'no-key',
    modelsReason: hasElevenLabsKey ? elevenLabsModels.data?.reason : 'no-key',
    listenPreview: voicePreview,
    providerValues: draft,
    hasKeys: document.hasKeys,
    onChange: setValue,
    onResetToDefault: (key: string) => setValue(key, SETTING_BY_KEY.get(key)?.default ?? null),
    collapsed: isPhone,
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tab === 'providers'
              ? 'The AI providers behind understanding and voice, and the keys they use. Changes apply from the next request.'
              : "Every Echo's behaviour. Changes apply from the next request, with no restart."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" data-testid="settings-version">
            v{document.version}
          </Badge>
          <Button variant="outline" onClick={() => setHistoryOpen(true)}>
            <HistoryIcon aria-hidden="true" /> History
          </Button>
        </div>
      </header>

      <SettingsTabs />

      {conflictVersion !== null && (
        <Alert>
          <AlertTitle>These settings changed in another tab</AlertTitle>
          <AlertDescription>
            {`The document moved past v${conflictVersion}. Your unsaved values are kept — reapply them to v${document.version}, or discard them.`}
            <span className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={save.isPending || document.version === conflictVersion}
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

      <VoicePipeline
        values={draft}
        hasKey={hasKey}
        voiceNames={voiceNames}
        onGoToSection={goToSection}
        onOpenProviders={() =>
          void navigate({ to: '/settings', search: { tab: 'providers' }, replace: true })
        }
      />

      {tab === 'providers' ? (
        <div className="space-y-4">
          <ProvidersPanel
            descriptors={descriptorsOfSection('providers')}
            values={draft}
            errors={errors}
            hasKeys={document.hasKeys}
            onChange={setValue}
            onResetToDefault={(key) => setValue(key, SETTING_BY_KEY.get(key)?.default ?? null)}
          />
          {saveBar}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[170px_minmax(0,1fr)]">
          <nav aria-label="Settings sections" className="hidden lg:block">
            <ul className="sticky top-6 space-y-0.5 text-sm">
              {SETTING_SECTIONS.filter((section) => section !== 'providers').map((section) => (
                <li key={section}>
                  <a
                    href={`#section-${section}`}
                    className="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {SETTINGS_SECTION_LABELS[section]}
                    {descriptorsOfSection(section).some((descriptor) => dirtySet.has(descriptor.key)) && (
                      <>
                        <span aria-hidden="true" className="size-2 rounded-full bg-signal" />
                        <span className="sr-only">unsaved changes</span>
                      </>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-4">
            {SETTING_SECTIONS.filter((section) => section !== 'providers').map((section) => {
              const descriptors = descriptorsOfSection(section);
              return (
                <SettingsSection
                  key={section}
                  section={section}
                  descriptors={descriptors}
                  {...sharedSectionProps}
                  dirty={descriptors.some((descriptor) => dirtySet.has(descriptor.key))}
                  overriddenBy={overriddenBy.get(section)}
                  footer={
                    section === 'assistant' ? (
                      <Button type="button" variant="outline" onClick={() => setPromptOpen(true)}>
                        <FileTextIcon aria-hidden="true" /> Show the full prompt
                      </Button>
                    ) : section === 'voice' ? (
                      <VoiceTestPhrase devices={deviceList} voice={voicePreview} />
                    ) : section === 'network' ? (
                      <TestSoundButton devices={deviceList} />
                    ) : section === 'advanced' ? (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Reconnect and ping timings apply when a link next reconnects. Use this after
                          changing them.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={reconnect.isPending || deviceList.length === 0}
                          onClick={() => {
                            const targets = deviceList.filter((device) => device.enabled);
                            if (targets.length === 0) return;
                            for (const device of targets) reconnect.mutate(device.id);
                            toast.success(
                              `Reconnecting ${targets.length === 1 ? '1 Echo' : `${targets.length} Echos`}…`,
                            );
                          }}
                        >
                          <RefreshCwIcon aria-hidden="true" /> Reconnect all Echos now
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
            {saveBar}
          </div>
        </div>
      )}

      <SettingsHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        devices={deviceList}
        onReverted={(next) => admit(next, setDraft, setBaseline, seededVersion)}
      />
      <FullPromptDialog open={promptOpen} onOpenChange={setPromptOpen} />
    </div>
  );
}

/**
 * Scrolls to a settings section and focuses its heading. Phone sections are
 * <details>; the hash event reveals the right one (the section listens for
 * hashchange), then the scroll is smooth and the heading takes focus.
 */
function scrollToSection(section: string): void {
  const element = document.getElementById(`section-${section}`);
  if (!element) return;
  window.history.replaceState(null, '', `#section-${section}`);
  window.dispatchEvent(new Event('hashchange'));
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Brief highlight so the eye lands on the section the navigator chose.
  element.classList.add('ring-2', 'ring-signal/60');
  window.setTimeout(() => element.classList.remove('ring-2', 'ring-signal/60'), 1600);
  const heading = element.querySelector('h2, summary');
  if (heading instanceof HTMLElement) {
    heading.tabIndex = -1;
    requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }
}

/** The draft starts at the resolved values; a secret's value never reaches the browser. */
function seed(document: SettingsDocument): FormValues {
  return { ...document.effective, 'openai.apiKey': '', 'elevenlabs.apiKey': '' };
}

function admit(
  document: SettingsDocument,
  setDraft: (values: FormValues) => void,
  setBaseline: (values: FormValues) => void,
  seededVersion: RefObject<number | null>,
) {
  const next = seed(document);
  seededVersion.current = document.version;
  setDraft(next);
  setBaseline(next);
}

function focusFirst(errors: Record<string, string>): void {
  const first = SETTING_DESCRIPTORS.find((descriptor) => descriptor.key in errors);
  if (first) focusField(first.key);
}
