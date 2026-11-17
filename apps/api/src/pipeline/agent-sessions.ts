import type { ResponseItem } from './agent.ts';

/**
 * A “confirm by voice” action waiting for the user's yes. It lives on the
 * speaker's session, so injected text read in turn N cannot produce the
 * spoken yes of turn N and run the action.
 */
export type PendingAction = {
  exposedName: string;
  /** Canonical JSON of the arguments; a different call is a new action. */
  argsHash: string;
  argumentsJson: string;
  /** The session turn that created it: only a later turn may run it. */
  createdTurn: number;
  expiresAt: number;
};

/** One conversation: the replayed input items and when the last turn happened. */
export type AgentSession = {
  history: ResponseItem[];
  lastTurnAt: number;
  /** Monotonic counter of agent replies in this conversation. */
  turnSeq?: number;
  /** At most one pending action; different arguments replace it. */
  pendingAction?: PendingAction | null;
};

/**
 * Conversation memory per speaker. The pipeline owns one map; a voice turn
 * uses its device's session, `/api/ask` without a device uses `web`. Memory
 * is dropped after `idleMs` without a turn (the setting is read from the
 * current snapshot).
 */
export class AgentSessions {
  private readonly sessions = new Map<string, AgentSession>();

  /** The session for `key`, expired when it has been idle for too long. */
  get(key: string, idleMs: number, now = Date.now()): AgentSession {
    const existing = this.sessions.get(key);
    if (existing && now - existing.lastTurnAt > idleMs) {
      this.sessions.delete(key);
    }
    const session = this.sessions.get(key) ?? {
      history: [],
      lastTurnAt: 0,
      turnSeq: 0,
      pendingAction: null,
    };
    session.lastTurnAt = now;
    this.sessions.set(key, session);
    return session;
  }

  reset(key?: string): void {
    if (key === undefined) this.sessions.clear();
    else this.sessions.delete(key);
  }

  get size(): number {
    return this.sessions.size;
  }
}
