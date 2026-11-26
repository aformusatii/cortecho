import type { VoicePreview } from '@cortecho/shared';
import { LoaderCircleIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';

const SAMPLE_TEXT = 'Hi, this is how I will sound.';

/**
 * "Listen here": asks the server to synthesize a short phrase with the draft
 * voice of either provider and plays the WAV in the browser. No Echo, no save.
 */
export function VoiceSampleButton({ preview }: { preview: VoicePreview }) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  async function listen() {
    if (playing) {
      stop();
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/settings/voice-sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...preview, text: SAMPLE_TEXT }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        toast.error(body?.error?.message ?? 'Could not play this voice.');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      setPlaying(true);
      audio.onended = stop;
      audio.onerror = () => {
        stop();
        toast.error('Could not play this voice.');
      };
      await audio.play();
    } catch {
      stop();
      toast.error('Could not play this voice.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={playing ? 'Stop listening to this voice' : 'Listen to this voice'}
      aria-pressed={playing}
      disabled={loading}
      onClick={() => void listen()}
    >
      {loading ? (
        <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
      ) : playing ? (
        <PauseIcon aria-hidden="true" />
      ) : (
        <PlayIcon aria-hidden="true" />
      )}
      {loading ? 'Loading…' : playing ? 'Stop' : 'Listen here'}
    </Button>
  );
}
