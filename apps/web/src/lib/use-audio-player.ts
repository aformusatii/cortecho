import { useCallback, useEffect, useRef } from 'react';

/**
 * A 10 ms silent WAV (8 kHz, mono, 16-bit). Playing it inside the click is what
 * unlocks the element for the gesture-less playback after the fetch on iOS
 * Safari, which ties the user gesture to that one element.
 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export type AudioPlayerHandlers = {
  onEnded?: () => void;
  onError?: () => void;
};

export type AudioFailure = 'blocked' | 'failed';

/** A refused or aborted playback, told apart so the UI can say what to do. */
export class AudioPlaybackError extends Error {
  readonly failure: AudioFailure;

  constructor(failure: AudioFailure) {
    super(failure === 'blocked' ? 'The browser blocked playback.' : 'Playback failed.');
    this.name = 'AudioPlaybackError';
    this.failure = failure;
  }
}

/** The message for a blocked play() (iOS), or null when it failed otherwise. */
export function blockedPlaybackMessage(error: unknown): string | null {
  return error instanceof AudioPlaybackError && error.failure === 'blocked'
    ? 'Your browser blocked playback. Tap Listen again.'
    : null;
}

/**
 * One HTMLAudioElement for the lifetime of the component, so it stays the
 * element the user's gesture unlocked. `unlock()` must be called synchronously
 * in the click handler, before any await: `new Audio(url)` created after the
 * fetch is a different element and iOS refuses it (NotAllowedError).
 */
export function useAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const releaseUrl = useCallback(() => {
    if (!urlRef.current) return;
    URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const element = useCallback(() => {
    audioRef.current ??= new Audio();
    return audioRef.current;
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    releaseUrl();
  }, [releaseUrl]);

  const unlock = useCallback(() => {
    const audio = element();
    releaseUrl();
    audio.onended = null;
    audio.onerror = null;
    audio.src = SILENT_WAV;
    const activation = audio.play();
    // A refusal here is expected (nothing to play yet) and not worth reporting:
    // play() below is what the user hears about.
    if (activation) void activation.catch(() => {});
  }, [element, releaseUrl]);

  const play = useCallback(
    async (source: Blob | string, handlers: AudioPlayerHandlers = {}) => {
      const audio = element();
      releaseUrl();
      if (typeof source === 'string') {
        audio.src = source;
      } else {
        const url = URL.createObjectURL(source);
        urlRef.current = url;
        audio.src = url;
      }
      audio.onended = () => {
        releaseUrl();
        handlers.onEnded?.();
      };
      audio.onerror = () => {
        releaseUrl();
        handlers.onError?.();
      };
      try {
        const started = audio.play();
        if (started) await started;
      } catch (error) {
        audio.onended = null;
        audio.onerror = null;
        stop();
        throw new AudioPlaybackError(
          error instanceof DOMException && error.name === 'NotAllowedError' ? 'blocked' : 'failed',
        );
      }
    },
    [element, releaseUrl, stop],
  );

  useEffect(() => stop, [stop]);

  return { unlock, play, stop };
}
