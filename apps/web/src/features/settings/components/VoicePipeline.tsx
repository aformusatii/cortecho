import { buildVoicePipelineStages, providerLabel, type VoicePipelineStage } from '@cortecho/shared';
import { cn } from 'cn';
import {
  AudioLinesIcon,
  BrainIcon,
  ChevronRightIcon,
  MicIcon,
  SpeakerIcon,
  TriangleAlertIcon,
  Volume2Icon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { FormValues } from '../draft.ts';

const ICONS: Record<string, ReactNode> = {
  listening: <MicIcon aria-hidden="true" className="size-4" />,
  understanding: <AudioLinesIcon aria-hidden="true" className="size-4" />,
  thinking: <BrainIcon aria-hidden="true" className="size-4" />,
  voice: <Volume2Icon aria-hidden="true" className="size-4" />,
};

/** Distinct provider tints that keep their contrast in dark mode. */
const CHIP_STYLES = {
  openai:
    'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100 dark:hover:bg-emerald-900/60',
  elevenlabs:
    'border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-100 dark:hover:bg-violet-900/60',
} as const;

const STEP: Record<string, string> = {
  listening: '1',
  understanding: '2',
  thinking: '3',
  voice: '4',
};

/**
 * The visual pipeline at the top of Settings: the Echo's mic, what hears,
 * understands, thinks and speaks, and the Echo's speaker. A stage links to its
 * section; its provider chip and key warning open the Providers tab.
 */
export function VoicePipeline({
  values,
  hasKey,
  voiceNames,
  onGoToSection,
  onOpenProviders,
}: {
  values: FormValues;
  hasKey: (key: string) => boolean;
  voiceNames?: Readonly<Record<string, string>>;
  onGoToSection: (section: string) => void;
  onOpenProviders: () => void;
}) {
  const stages = buildVoicePipelineStages(values, { hasKey, voiceNames });
  return (
    <nav aria-label="Voice pipeline" className="rounded-xl border bg-card p-3 shadow-xs">
      {/* Phones: a compact list, so the settings stay near the top. */}
      <div className="md:hidden">
        <p className="text-[11px] font-medium text-muted-foreground">From the Echo mic</p>
        <ol className="mt-1">
          {stages.map((stage, index) => (
            <li key={stage.id} className="relative flex min-h-14 items-center gap-2">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 left-4 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-border"
                />
              )}
              <a
                href={`#section-${stage.section}`}
                aria-label={`${stage.title}: ${stage.summary}. Go to the ${stage.title} settings.`}
                aria-describedby={
                  stage.provider && !stage.configured ? `pipeline-warning-mobile-${stage.id}` : undefined
                }
                onClick={(event) => {
                  event.preventDefault();
                  onGoToSection(stage.section);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {ICONS[stage.id]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{stage.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{stage.summary}</span>
                </span>
              </a>
              <span className="flex shrink-0 items-center gap-1">
                {stage.provider && !stage.configured && (
                  <button
                    type="button"
                    id={`pipeline-warning-mobile-${stage.id}`}
                    title={`Needs ${providerLabel(stage.provider)} key`}
                    aria-label={`Needs ${providerLabel(stage.provider)} key`}
                    onClick={onOpenProviders}
                    className="flex size-6 items-center justify-center rounded-full text-destructive hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">Needs {providerLabel(stage.provider)} key</span>
                  </button>
                )}
                {stage.provider ? (
                  <button
                    type="button"
                    onClick={onOpenProviders}
                    aria-label={`Open Providers: ${providerLabel(stage.provider)}`}
                    className={cn(
                      'rounded-full border px-1.5 py-0.5 text-[11px] font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      CHIP_STYLES[stage.provider],
                    )}
                  >
                    {providerLabel(stage.provider)}
                  </button>
                ) : (
                  <span className="rounded-full border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    On-device
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-[11px] font-medium text-muted-foreground">To the Echo speaker</p>
      </div>

      <div className="hidden min-w-0 md:flex md:items-stretch">
        <Endpoint icon={<MicIcon aria-hidden="true" className="size-4" />} label="Echo mic" />
        <Connector />
        {stages.map((stage) => (
          <div key={stage.id} className="flex min-w-0 md:flex-1 md:flex-row">
            <StageCard stage={stage} onGoToSection={onGoToSection} onOpenProviders={onOpenProviders} />
            <Connector />
          </div>
        ))}
        <Endpoint icon={<SpeakerIcon aria-hidden="true" className="size-4" />} label="Echo speaker" />
      </div>
      <p className="pt-2 text-xs text-muted-foreground">Click a stage to jump to its settings.</p>
    </nav>
  );
}

function Endpoint({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 md:flex-col md:justify-center">
      <span className="flex size-9 items-center justify-center rounded-full border bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

function Connector() {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center text-border md:self-center">
      <span className="h-4 w-px bg-border md:h-px md:w-5" />
      <ChevronRightIcon className="size-3 rotate-90 md:rotate-0" />
    </span>
  );
}

function StageCard({
  stage,
  onGoToSection,
  onOpenProviders,
}: {
  stage: VoicePipelineStage;
  onGoToSection: (section: string) => void;
  onOpenProviders: () => void;
}) {
  const warningId = `pipeline-warning-${stage.id}`;
  const provider = stage.provider;
  return (
    <div className="group flex min-w-0 flex-1 flex-col rounded-xl border bg-background/40 shadow-xs transition hover:-translate-y-0.5 hover:shadow-md focus-within:ring-2 focus-within:ring-ring/40">
      <a
        href={`#section-${stage.section}`}
        aria-label={`${stage.title}: ${stage.summary}. Go to the ${stage.title} settings.`}
        aria-describedby={provider && !stage.configured ? warningId : undefined}
        onClick={(event) => {
          event.preventDefault();
          onGoToSection(stage.section);
        }}
        className="flex flex-1 flex-col gap-2 rounded-t-xl p-3 focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {ICONS[stage.id]}
          </span>
          <span className="text-[11px] font-medium text-muted-foreground tabular-nums" aria-hidden="true">
            {STEP[stage.id]}
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {stage.eyebrow}
          </p>
          <h3 className="text-sm font-semibold">{stage.title}</h3>
        </div>
        <p className="text-sm font-medium break-words">{stage.summary}</p>
      </a>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3">
        {provider ? (
          <button
            type="button"
            onClick={onOpenProviders}
            aria-label={`Open Providers: ${providerLabel(provider)}`}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              CHIP_STYLES[provider],
            )}
          >
            {providerLabel(provider)}
          </button>
        ) : (
          <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            On-device
          </span>
        )}
        {provider && !stage.configured && (
          <button
            type="button"
            id={warningId}
            onClick={onOpenProviders}
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <TriangleAlertIcon aria-hidden="true" className="size-3" />
            Needs {providerLabel(provider)} key
          </button>
        )}
      </div>
    </div>
  );
}
