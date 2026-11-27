'use client';

import type { ElevenLabsVoice } from '@cortecho/shared';
import { CheckIcon, ChevronDownIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import * as React from 'react';
import { blockedPlaybackMessage, useAudioPlayer } from '@/lib/use-audio-player.ts';

/** The same-origin proxy for a voice sample: the API fetches the cached preview URL. */
export function voicePreviewSrc(id: string): string {
  return `/api/settings/elevenlabs-voices/${encodeURIComponent(id)}/preview`;
}

/** ElevenLabs voice ids are 20 alphanumerics; allow some slack for other id shapes. */
const LOOKS_LIKE_VOICE_ID = /^[A-Za-z0-9_-]{12,64}$/;

function voiceMeta(voice: ElevenLabsVoice): string {
  return [voice.category, voice.accent, voice.gender, voice.description].filter(Boolean).join(' · ');
}

/**
 * The ElevenLabs voice picker: shows the selected voice's name (or a pasted id),
 * uses the input as the search box, and offers the account's or default voices
 * with their labels and a play button for each sample. Only one sample plays at
 * a time and it stops on close or unmount.
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
  /** Null while not editing: the input then shows the selected voice's name. */
  const [draft, setDraft] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const { unlock, play, stop: stopAudio } = useAudioPlayer();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const focusFirstRef = React.useRef(false);
  const listId = `${id}-voices`;

  const stop = React.useCallback(() => {
    stopAudio();
    setPlaying(null);
  }, [stopAudio]);

  React.useEffect(() => stop, [stop]);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selected = voices.find((voice) => voice.id === value) ?? null;
  const display = selected?.name ?? value;
  const inputValue = draft ?? display;
  const needle = inputValue.trim().toLowerCase();
  // Focusing or clicking the selected name is not a search: keep the full list.
  const searching = needle !== '' && needle !== display.trim().toLowerCase();
  const filtered = searching
    ? voices.filter((voice) =>
        [voice.name, voice.id, voice.category, voice.accent, voice.gender, voice.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : voices;

  React.useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    focusFirstOption();
  });

  function focusFirstOption(): void {
    document.getElementById(listId)?.querySelector<HTMLElement>('[role="option"]')?.focus();
  }

  /**
   * The id a draft means: an exact name/id, or a pasted id. A half-typed search
   * ("geo") is neither and reverts: storing it would make every reply fail.
   */
  function resolveDraft(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const exact = voices.find(
      (voice) => voice.id === trimmed || voice.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exact) return exact.id;
    return LOOKS_LIKE_VOICE_ID.test(trimmed) ? trimmed : null;
  }

  function commit(raw: string): void {
    const next = resolveDraft(raw);
    if (next !== null && next !== value) onChange(next);
    setDraft(null);
  }

  function toggleSample(voice: ElevenLabsVoice): void {
    setPreviewError(null);
    if (playing === voice.id) {
      stop();
      return;
    }
    stop();
    // Synchronous, still inside the click: iOS only lets this element play
    // after the request if the gesture activated it first.
    unlock();
    setPlaying(voice.id);
    const settle = () => setPlaying((current) => (current === voice.id ? null : current));
    void play(voicePreviewSrc(voice.id), {
      onEnded: settle,
      onError: () => {
        settle();
        setPreviewError('Could not play this sample.');
      },
    }).catch((error: unknown) => {
      settle();
      setPreviewError(blockedPlaybackMessage(error) ?? 'Could not play this sample.');
    });
  }

  function choose(voice: ElevenLabsVoice): void {
    onChange(voice.id);
    setDraft(null);
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
      setOpen(false);
      return;
    }
    if (event.key === 'Enter') {
      // Enter in a search that leaves exactly one voice picks it.
      const only = searching && filtered.length === 1 ? filtered[0] : undefined;
      if (only) {
        event.preventDefault();
        choose(only);
        return;
      }
      if (draft !== null) commit(draft);
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' && !disabled && voices.length > 0) {
      event.preventDefault();
      if (open) {
        focusFirstOption();
      } else {
        focusFirstRef.current = true;
        setOpen(true);
      }
    }
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
        if (!next) {
          stop();
          // Closed without choosing (Escape, outside click from the list):
          // show the stored voice again, not a stale search.
          setDraft(null);
        }
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
              placeholder="Voice name or id, or pick a default voice"
              disabled={disabled}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={inputValue}
              onFocus={(event) => event.currentTarget.select()}
              onClick={() => {
                if (!disabled && voices.length > 0) setOpen(true);
              }}
              onKeyDown={handleKeyDown}
              onChange={(event) => {
                setDraft(event.target.value);
                if (!disabled && voices.length > 0) setOpen(true);
              }}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                // Focus moving into the list (ArrowDown) keeps the search; any
                // other blur (Tab, the chevron, outside) resolves or reverts it.
                if (next && contentRef.current?.contains(next)) return;
                if (draft !== null) commit(draft);
                setOpen(false);
              }}
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
              <span className="w-full font-mono text-[11px] break-all text-muted-foreground/80">
                {selected.id}
              </span>
            </p>
          )}
          {previewError && (
            <p role="alert" className="mt-2 text-xs font-medium text-destructive">
              {previewError}
            </p>
          )}
        </div>
      </Popover.Anchor>

      <Popover.Content
        ref={contentRef}
        sideOffset={4}
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => setDraft(null)}
        onPointerDownOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          else stop();
        }}
        className="z-50 max-h-80 w-(--radix-popover-trigger-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
      >
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
