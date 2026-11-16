import type { TurnOutcome, TurnTimings } from '@cortecho/shared';

// Status-page-specific formatters. The labels and time helpers that every
// Echo-facing page shares live in lib/displays.ts (re-exported here so the
// existing imports keep working).
export {
  CONNECTION_LABELS,
  formatSeconds,
  formatTime,
  PROBLEM_LABELS,
} from '@/lib/displays.ts';

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

/** The steps of a turn in order, with the labels the page shows. */
export const TIMING_STEPS: { key: keyof TurnTimings; label: string }[] = [
  { key: 'speechEndMs', label: 'Speech end' },
  { key: 'transcriptMs', label: 'Transcript' },
  { key: 'agentDoneMs', label: 'Reply' },
  { key: 'firstAudioMs', label: 'Audio ready' },
  { key: 'playedMs', label: 'Played' },
];

export const OUTCOME_LABELS: Record<TurnOutcome, string> = {
  answered: 'Answered',
  'no-speech': 'No speech',
  error: 'Error',
  aborted: 'Aborted',
};
