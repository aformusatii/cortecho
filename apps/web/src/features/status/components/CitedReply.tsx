import type { Turn } from '@cortecho/shared';
import type { ReactNode } from 'react';

export function CitedReply({ turn }: { turn: Turn }) {
  if (!turn.displayText) return <>{turn.reply}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, citation] of (turn.citations ?? []).entries()) {
    if (
      citation.start < cursor ||
      citation.end > turn.displayText.length ||
      !/^https?:\/\//.test(citation.url)
    )
      continue;
    parts.push(turn.displayText.slice(cursor, citation.start));
    parts.push(
      <a
        key={index}
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline"
        title={citation.title}
      >
        [{citation.title || index + 1}]
      </a>,
    );
    cursor = citation.end;
  }
  parts.push(turn.displayText.slice(cursor));
  return <>{parts}</>;
}
