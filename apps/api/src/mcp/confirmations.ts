import { createLogger } from '../lib/logger.ts';
import type { PendingAction } from '../pipeline/agent-sessions.ts';
import type { ToolEntry } from '../tools/registry.ts';
import { argsHash, canonicalJson } from './tool-mapping.ts';

const log = createLogger('confirm');

/**
 * The “confirm by voice” barrier. A confirm tool is never executed in the turn
 * that asked for it: it stores a pending action on the speaker's session and
 * asks the model to say what it will do. Only a later turn of the same
 * conversation, with the same tool and the same canonical arguments, may run
 * it. Injected text read in turn N therefore cannot produce the spoken yes of
 * turn N and trigger a write.
 *
 * The model is told to call a confirm tool at once instead of asking first
 * (prompt-layers.ts): a question before the call plus this barrier's question
 * made the user say yes twice (2026-11-17).
 */
export const PENDING_OUTPUT =
  'pending: not done yet. Tell the user exactly what you will do — name the recipient, the date or the title — ' +
  'and ask them to say yes. If they agree, call this tool again with exactly the same arguments.';

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
      log.info(`${exposedName} confirmed: runs now`, {
        connector: connectorName,
        fromTurn: pending.createdTurn,
        turn: turnNumber,
      });
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
    // Why this call did not count as the yes: the line to read when a user is asked twice.
    log.info(`${exposedName} waits for a spoken yes`, {
      connector: connectorName,
      turn: turnNumber,
      expiresInS: Math.round((next.expiresAt - at) / 1000),
      args: hash.slice(0, 8),
      notConfirmedBecause: mismatchReason(pending, { exposedName, hash, args, turnNumber, at }),
    });
    return { allow: false, ok: true, pending: true, output: PENDING_OUTPUT };
  };
}

/**
 * Why a call did not match the pending action. Names argument KEYS only,
 * never values (tool arguments stay out of the log).
 */
export function mismatchReason(
  pending: PendingAction | null,
  call: { exposedName: string; hash: string; args: Record<string, unknown>; turnNumber: number; at: number },
): string {
  if (pending === null) return 'nothing was pending (first call)';
  if (pending.exposedName !== call.exposedName) return `another tool was pending (${pending.exposedName})`;
  if (pending.createdTurn >= call.turnNumber)
    return `same turn as the pending call (turn ${pending.createdTurn})`;
  if (pending.argsHash !== call.hash) {
    const keys = changedKeys(pending.argumentsJson, call.args);
    return `arguments differ from turn ${pending.createdTurn}${keys.length > 0 ? ` (${keys.join(', ')})` : ''}`;
  }
  if (call.at > pending.expiresAt) return `expired ${Math.round((call.at - pending.expiresAt) / 1000)} s ago`;
  return 'unknown';
}

function changedKeys(previousJson: string, args: Record<string, unknown>): string[] {
  let previous: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(previousJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      previous = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const keys = new Set([...Object.keys(previous), ...Object.keys(args)]);
  return [...keys].filter((key) => canonicalJson(previous[key]) !== canonicalJson(args[key])).sort();
}

/** For the status page: does this session have an action waiting for a yes? */
export function hasPendingAction(session: { pendingAction?: PendingAction | null }): boolean {
  const pending = session.pendingAction;
  return Boolean(pending && pending.expiresAt >= Date.now());
}
