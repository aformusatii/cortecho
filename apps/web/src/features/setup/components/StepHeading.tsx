import type { ReactNode } from 'react';

/**
 * The one heading of a step. The flow focuses it on every step change (spec
 * §5.7), so it is focusable but has no visible outline.
 */
export function StepHeading({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} data-flow-heading tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
      {children}
    </h2>
  );
}
