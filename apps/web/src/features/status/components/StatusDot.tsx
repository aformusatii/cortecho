import { cn } from '@/lib/utils.ts';

type Tone = 'good' | 'warn' | 'bad' | 'off';

const TONES: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-signal',
  bad: 'bg-destructive',
  off: 'bg-muted-foreground/40',
};

/** A coloured dot that always comes with a text label (colour is never the only cue). */
export function StatusDot({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', TONES[tone])} />
      {children}
    </span>
  );
}
