import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../pipeline/agent-sessions.ts';
import { createConfirmGate, mismatchReason, PENDING_OUTPUT } from './confirmations.ts';

const session = (): AgentSession => ({ history: [], lastTurnAt: 0, turnSeq: 0, pendingAction: null });

describe('confirm by voice', () => {
  it('refuses in the same turn and runs on the next turn with the same arguments', async () => {
    const gate = createConfirmGate({
      connectorName: 'Gmail',
      exposedName: 'gmail__send',
      confirmWindowS: 60,
    });
    const ctx = (turnNumber: number) => ({
      signal: new AbortController().signal,
      session: session(),
      turnNumber,
    });
    const state = ctx(1);
    const first = await gate({ to: 'a@b.c' }, '{"to":"a@b.c"}', state);
    expect(first).toEqual({ allow: false, ok: true, pending: true, output: PENDING_OUTPUT });
    expect(state.session?.pendingAction).toMatchObject({ exposedName: 'gmail__send', createdTurn: 1 });

    const sameTurn = await gate({ to: 'a@b.c' }, '{"to":"a@b.c"}', { ...state, turnNumber: 1 });
    expect(sameTurn.allow).toBe(false);

    const next = await gate({ to: 'a@b.c' }, '{"to":"a@b.c"}', { ...state, turnNumber: 2 });
    expect(next).toEqual({ allow: true });
    expect(state.session?.pendingAction).toBeNull();
  });

  it('replaces the pending action when the arguments differ, and expires', async () => {
    let clock = 0;
    const gate = createConfirmGate({
      connectorName: 'Calendar',
      exposedName: 'cal__create_event',
      confirmWindowS: 10,
      now: () => clock,
    });
    const state = {
      signal: new AbortController().signal,
      session: session(),
      turnNumber: 1,
    };
    await gate({ title: 'A' }, '{"title":"A"}', state);
    const other = await gate({ title: 'B' }, '{"title":"B"}', { ...state, turnNumber: 2 });
    expect(other.allow).toBe(false);
    expect(state.session?.pendingAction?.argumentsJson).toBe('{"title":"B"}');
    clock = 11_000;
    const expired = await gate({ title: 'B' }, '{"title":"B"}', { ...state, turnNumber: 3 });
    expect(expired.allow).toBe(false);
  });

  it('isolates sessions and refuses when there is no conversation', async () => {
    const gate = createConfirmGate({
      connectorName: 'Gmail',
      exposedName: 'gmail__send',
      confirmWindowS: 60,
    });
    const one = { signal: new AbortController().signal, session: session(), turnNumber: 1 };
    const two = { signal: new AbortController().signal, session: session(), turnNumber: 1 };
    await gate({ to: 'x' }, '{"to":"x"}', one);
    expect((await gate({ to: 'x' }, '{"to":"x"}', { ...two, turnNumber: 2 })).allow).toBe(false);
    expect(
      (
        await gate({ to: 'x' }, '{"to":"x"}', {
          signal: new AbortController().signal,
        })
      ).allow,
    ).toBe(false);
  });

  it('explains in the log why a call was not the yes (argument keys, never values)', () => {
    const pending = {
      exposedName: 'gmail__draft',
      argsHash: 'a',
      argumentsJson: '{"to":"a@b.c","subject":"Hello","body":"Hello."}',
      createdTurn: 2,
      expiresAt: 60_000,
    };
    const call = (over: Partial<Parameters<typeof mismatchReason>[1]> = {}) => ({
      exposedName: 'gmail__draft',
      hash: 'a',
      args: { to: 'a@b.c', subject: 'Hello', body: 'Hello.' },
      turnNumber: 3,
      at: 1000,
      ...over,
    });
    expect(mismatchReason(null, call())).toBe('nothing was pending (first call)');
    expect(mismatchReason(pending, call({ exposedName: 'cal__create' }))).toBe(
      'another tool was pending (gmail__draft)',
    );
    expect(mismatchReason(pending, call({ turnNumber: 2 }))).toBe('same turn as the pending call (turn 2)');
    const reason = mismatchReason(
      pending,
      call({ hash: 'b', args: { to: 'a@b.c', subject: 'Hi', body: 'Hello.', cc: 'z' } }),
    );
    expect(reason).toBe('arguments differ from turn 2 (cc, subject)');
    expect(reason).not.toContain('Hi');
    expect(mismatchReason(pending, call({ at: 65_000 }))).toBe('expired 5 s ago');
  });
});
