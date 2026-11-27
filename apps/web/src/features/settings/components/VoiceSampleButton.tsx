import type { VoicePreview } from '@cortecho/shared';
import { LoaderCircleIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { blockedPlaybackMessage, useAudioPlayer } from '@/lib/use-audio-player.ts';

const SAMPLE_TEXT = 'Hi, this is how I will sound.';

/**
 * "Listen here": asks the server to synthesize a short phrase with the draft
 * voice of either provider and plays the WAV in the browser. No Echo, no save.
 */
export function VoiceSampleButton({ preview }: { preview: VoicePreview }) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useAudioPlayer();

  async function listen() {
    if (playing) {
      player.stop();
      setPlaying(false);
      return;
    }
    // Synchronous, still inside the click: iOS only lets this element play
    // after the await if the gesture activated it first.
    player.unlock();
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
        player.stop();
        toast.error(body?.error?.message ?? 'Could not play this voice.');
        return;
      }
      setPlaying(true);
      await player.play(await response.blob(), { onEnded: () => setPlaying(false) });
    } catch (error) {
      player.stop();
      setPlaying(false);
      toast.error(blockedPlaybackMessage(error) ?? 'Could not play this voice.');
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
