import type { Turn } from '@cortecho/shared';
import { MessageSquareIcon, MicIcon, Volume2Icon, WrenchIcon } from 'lucide-react';
import { formatSeconds, formatTime, OUTCOME_LABELS, TIMING_STEPS } from '../format.ts';
import { CitedReply } from './CitedReply.tsx';
import { StatusDot } from './StatusDot.tsx';

const SOURCE_ICONS = { voice: MicIcon, ask: MessageSquareIcon, say: Volume2Icon } as const;
const SOURCE_LABELS = { voice: 'Voice', ask: 'Ask', say: 'Say' } as const;
const outcomeTone = { answered: 'good', 'no-speech': 'off', error: 'bad', aborted: 'warn' } as const;

function TurnItem({ turn }: { turn: Turn }) {
  const Icon = SOURCE_ICONS[turn.source];
  const steps = TIMING_STEPS.filter((step) => turn.timings[step.key] !== undefined);
  return (
    <li className="space-y-2 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          {SOURCE_LABELS[turn.source]}
        </span>
        {turn.deviceName && <span className="text-muted-foreground">{turn.deviceName}</span>}
        <StatusDot tone={outcomeTone[turn.outcome]}>{OUTCOME_LABELS[turn.outcome]}</StatusDot>
        <time dateTime={turn.startedAt} className="text-muted-foreground">
          {formatTime(turn.startedAt)}
        </time>
      </div>
      {turn.transcript && (
        <p className="text-sm">
          <span className="text-muted-foreground">Heard: </span>“{turn.transcript}”
        </p>
      )}
      {turn.reply && (
        <p className="text-sm">
          <span className="text-muted-foreground">{turn.source === 'say' ? 'Said: ' : 'Replied: '}</span>
          <CitedReply turn={turn} />
        </p>
      )}
      {turn.error && <p className="text-sm text-destructive">Error: {turn.error}</p>}
      {turn.toolCalls.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Tool calls">
          {turn.toolCalls.map((call, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a turn's tool calls never reorder
              key={index}
              title={`${call.arguments} → ${call.result}`}
              className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground"
            >
              {call.name === 'listen_for_reply' ? (
                <>
                  <MicIcon aria-hidden="true" className="size-3" />
                  {`Asked Echo to listen for ${listenWaitLabel(call.result)}`}
                </>
              ) : (
                <>
                  <WrenchIcon aria-hidden="true" className="size-3" />
                  {call.name}
                  {!call.ok && ' (failed)'} · {call.durationMs} ms
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {steps.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {steps.map((step) => (
            <div key={step.key} className="flex gap-1">
              <dt>{step.label}</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {formatSeconds(turn.timings[step.key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function listenWaitLabel(result: string): string {
  const match = /listening\s+(\d+)\s+s/i.exec(result);
  return match?.[1] ? `${match[1]} seconds` : 'for a reply';
}

export function TurnsList({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-muted-foreground">
        No turns yet. Say “Computer, what time is it?” or use Ask above.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {turns.map((turn) => (
        <TurnItem key={turn.id} turn={turn} />
      ))}
    </ul>
  );
}
