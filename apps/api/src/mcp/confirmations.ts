import type { PendingAction } from '../pipeline/agent-sessions.ts';
import type { ToolEntry } from '../tools/registry.ts';
import { argsHash } from './tool-mapping.ts';

/**
 * The “confirm by voice” barrier. A confirm tool is never executed in the turn
 * that asked for it: it stores a pending action on the speaker's session and
 * asks the model to say what it will do. Only a later turn of the same
 * conversation, with the same tool and the same canonical arguments, may run
 * it. Injected text read in turn N therefore cannot produce the spoken yes of
 * turn N and trigger a write.
 */
export const PENDING_OUTPUT =
  'pending: not done yet. Tell the user exactly what you will do — name the recipient, the date or the title — ' +
  'and ask them to say yes. If they agree, call this tool again with the same arguments.';

export type ConfirmGateOptions = {
  connectorName: string;
  exposedName: string;
  confirmWindowS: number;
  now?: () => number;
};

export function createConfirmGate({
  connectorName,
  exposedName,
  confirmWindowS,
  now = Date.now,
}: ConfirmGateOptions): NonNullable<ToolEntry['gate']> {
  return async (args, argumentsJson, context) => {
    const session = context.session;
    const turnNumber = context.turnNumber;
    if (!session || turnNumber === undefined) {
      return {
        allow: false,
        ok: false,
        output: `error: ${connectorName} needs a spoken confirmation, and this request has no conversation to confirm in`,
      };
    }
    const hash = argsHash(args);
    const at = now();
    const pending = session.pendingAction ?? null;
    const confirmed =
      pending !== null &&
      pending.exposedName === exposedName &&
      pending.argsHash === hash &&
      pending.createdTurn < turnNumber &&
      at <= pending.expiresAt;
    if (confirmed) {
      // Consumed: a replay in a later turn cannot use it again.
      session.pendingAction = null;
      return { allow: true };
    }

    const next: PendingAction = {
      exposedName,
      argsHash: hash,
      argumentsJson,
      createdTurn: turnNumber,
      expiresAt: at + Math.max(10, confirmWindowS) * 1000,
    };
    session.pendingAction = next;
    return { allow: false, ok: true, pending: true, output: PENDING_OUTPUT };
  };
}

/** For the status page: does this session have an action waiting for a yes? */
export function hasPendingAction(session: { pendingAction?: PendingAction | null }): boolean {
  const pending = session.pendingAction;
  return Boolean(pending && pending.expiresAt >= Date.now());
}
