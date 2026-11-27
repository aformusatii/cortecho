import type { SettingDescriptor } from '@cortecho/shared';
import { AudioLinesIcon, SparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useCheckProviderKey } from '../api/settings.mutations.ts';
import type { FormValues } from '../draft.ts';
import { SettingsFields } from './SettingsFields.tsx';

type ProviderId = 'openai' | 'elevenlabs';

const PROVIDERS: {
  id: ProviderId;
  name: string;
  icon: typeof SparklesIcon;
  key: string;
  keyUrl: string;
  permissions?: string;
}[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    icon: SparklesIcon,
    key: 'openai.apiKey',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    icon: AudioLinesIcon,
    key: 'elevenlabs.apiKey',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    permissions:
      'Needs Text to Speech and Speech to Text. Optional: Voices → Read and Models → Read for the voice and model lists.',
  },
];

function usedBy(id: ProviderId, values: FormValues): string[] {
  const stages: string[] = [];
  if (id === 'openai') stages.push('Thinking');
  if (values['stt.provider'] === id) stages.push('Understanding');
  if (values['tts.provider'] === id) stages.push('Voice');
  return stages;
}

/**
 * The Providers tab: one card per AI provider with its write-only key, timeout,
 * a "Test key" button and which stages use it. The fields are the same registry
 * descriptors the General form renders; only the layout differs.
 */
export function ProvidersPanel({
  descriptors,
  values,
  errors,
  hasKeys,
  onChange,
  onResetToDefault,
}: {
  descriptors: readonly SettingDescriptor[];
  values: FormValues;
  errors: Record<string, string>;
  hasKeys: Record<string, boolean>;
  onChange: (key: string, value: unknown) => void;
  onResetToDefault?: (key: string) => void;
}) {
  const check = useCheckProviderKey();
  const [limitedKey, setLimitedKey] = useState(false);

  return (
    <div className="space-y-4">
      {PROVIDERS.map((provider) => {
        const Icon = provider.icon;
        const fields = descriptors.filter((descriptor) => descriptor.key.startsWith(`${provider.id}.`));
        const draftKey = values[provider.key];
        const typedKey = typeof draftKey === 'string' && draftKey !== '';
        const keySet = hasKeys[provider.key] === true || typedKey;
        const stages = usedBy(provider.id, values);
        return (
          <section
            key={provider.id}
            aria-labelledby={`provider-${provider.id}-title`}
            data-testid={`provider-${provider.id}`}
            className="rounded-xl border bg-card px-4 py-3 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <div className="min-w-0">
                  <h2 id={`provider-${provider.id}-title`} className="text-lg font-semibold tracking-tight">
                    {provider.name}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {stages.length > 0 ? `Used by: ${stages.join(', ')}` : 'Not used'}
                    {' · '}
                    <a
                      href={provider.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Get a key ↗
                    </a>
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={keySet ? 'default' : 'outline'}>{keySet ? 'Key set' : 'No key'}</Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={check.isPending || !keySet}
                  onClick={() =>
                    check.mutate(
                      { provider: provider.id, ...(typedKey ? { apiKey: draftKey as string } : {}) },
                      {
                        onSuccess: (result) => {
                          if (result.ok) {
                            setLimitedKey((result.missingPermissions?.length ?? 0) > 0);
                            toast.success('Key works.');
                          } else if (result.code === 'rejected')
                            toast.error(`${provider.name} rejected this key.`);
                          else toast.error(`Could not reach ${provider.name}.`);
                        },
                        onError: (error) => toast.error(error.message),
                      },
                    )
                  }
                >
                  {check.isPending ? 'Testing…' : 'Test key'}
                </Button>
              </div>
            </div>
            {provider.permissions && (
              <p className="pb-1 text-xs text-muted-foreground">{provider.permissions}</p>
            )}
            {provider.id === 'elevenlabs' && limitedKey && (
              <p role="status" className="pb-1 text-xs font-medium text-foreground">
                Voice and model lists need the Voices → Read / Models → Read permissions on this key. Speech
                and transcription work without them; you can paste a voice id.
              </p>
            )}
            <SettingsFields
              descriptors={fields}
              values={values}
              errors={errors}
              models={[]}
              hasKeys={hasKeys}
              onChange={onChange}
              onResetToDefault={onResetToDefault}
              advancedDisclosure={false}
            />
          </section>
        );
      })}
    </div>
  );
}
