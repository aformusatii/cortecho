'use client';

import type { ElevenLabsVoice } from '@cortecho/shared';
import { CheckIcon, ChevronDownIcon, PauseIcon, PlayIcon, SearchIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import * as React from 'react';

/** The same-origin proxy for a voice sample: the API fetches the cached preview URL. */
export function voicePreviewSrc(id: string): string {
  return `/api/settings/elevenlabs-voices/${encodeURIComponent(id)}/preview`;
}

function voiceMeta(voice: ElevenLabsVoice): string {
  return [voice.category, voice.accent, voice.gender, voice.description].filter(Boolean).join(' · ');
}

/**
 * The ElevenLabs voice picker: free text (a pasted id) plus the account's
 * voices with their labels and a play button for each sample. Only one sample
 * plays at a time and it stops on close or unmount.
 */
export function VoicePicker({
  id,
  value,
  voices,
  disabled = false,
  invalid = false,
  describedBy,
  onChange,
}: {
  id: string;
  value: string;
  voices: readonly ElevenLabsVoice[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const listId = `${id}-voices`;

  const stop = React.useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  }, []);

  React.useEffect(() => stop, [stop]);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selected = voices.find((voice) => voice.id === value) ?? null;
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? voices.filter((voice) =>
        [voice.name, voice.id, voice.category, voice.accent, voice.gender, voice.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : voices;

  function toggleSample(voice: ElevenLabsVoice): void {
    setPreviewError(false);
    if (playing === voice.id) {
      stop();
      return;
    }
    stop();
    const audio = new Audio(voicePreviewSrc(voice.id));
    audioRef.current = audio;
    setPlaying(voice.id);
    audio.onended = () => {
      if (audioRef.current !== audio) return;
      audioRef.current = null;
      setPlaying(null);
    };
    audio.onerror = () => {
      if (audioRef.current !== audio) return;
      audioRef.current = null;
      setPlaying(null);
      setPreviewError(true);
    };
    void audio.play().catch(() => {
      if (audioRef.current !== audio) return;
      audioRef.current = null;
      setPlaying(null);
      setPreviewError(true);
    });
  }

  function choose(voice: ElevenLabsVoice): void {
    onChange(voice.id);
    setOpen(false);
    inputRef.current?.focus();
  }

  const sampleButton = (voice: ElevenLabsVoice) => (
    <button
      type="button"
      aria-label={playing === voice.id ? `Stop sample of ${voice.name}` : `Play sample of ${voice.name}`}
      aria-pressed={playing === voice.id}
      // Keep focus in the input/option the user is working in.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        toggleSample(voice);
      }}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {playing === voice.id ? (
        <PauseIcon aria-hidden="true" className="size-4" />
      ) : (
        <PlayIcon aria-hidden="true" className="size-4" />
      )}
    </button>
  );

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) stop();
      }}
    >
      <Popover.Anchor asChild>
        <div ref={anchorRef} className="w-full max-w-md">
          <div className="relative">
            <input
              ref={inputRef}
              id={id}
              type="text"
              role="combobox"
              autoComplete="off"
              spellCheck={false}
              placeholder="Voice id, or pick one from your account"
              disabled={disabled}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={value}
              onClick={() => {
                if (!disabled && voices.length > 0) setOpen(true);
              }}
              onChange={(event) => onChange(event.target.value)}
              className="h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-1 pr-10 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
            />
            <button
              type="button"
              disabled={disabled || voices.length === 0}
              aria-label="Show all ElevenLabs voices"
              onClick={() => setOpen((current) => !current)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </button>
          </div>

          {selected && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{selected.name}</span>
              {voiceMeta(selected) && <span>({voiceMeta(selected)})</span>}
              {sampleButton(selected)}
            </p>
          )}
          {previewError && (
            <p role="alert" className="mt-2 text-xs font-medium text-destructive">
              Could not play this sample.
            </p>
          )}
        </div>
      </Popover.Anchor>

      <Popover.Content
        sideOffset={4}
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          else stop();
        }}
        className="z-50 max-h-80 w-(--radix-popover-trigger-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
      >
        <div className="sticky top-0 bg-popover p-1">
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={query}
              placeholder="Search voices"
              aria-label="Search voices"
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background pr-2 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </div>
        </div>
        <div id={listId} role="listbox" aria-label="ElevenLabs voices">
          {filtered.length === 0 ? (
            <p className="px-2.5 py-3 text-sm text-muted-foreground">No voice matches.</p>
          ) : (
            filtered.map((voice) => (
              <div key={voice.id} className="flex items-center gap-1 rounded-md hover:bg-accent/60">
                <button
                  type="button"
                  role="option"
                  aria-selected={voice.id === value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(voice)}
                  className="flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{voice.name}</span>
                    {voiceMeta(voice) && (
                      <span className="block truncate text-xs text-muted-foreground">{voiceMeta(voice)}</span>
                    )}
                  </span>
                  {voice.id === value && <CheckIcon aria-hidden="true" className="size-4 shrink-0" />}
                </button>
                {sampleButton(voice)}
              </div>
            ))
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
