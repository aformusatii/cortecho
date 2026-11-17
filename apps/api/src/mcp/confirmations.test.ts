import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../pipeline/agent-sessions.ts';
import { createConfirmGate, PENDING_OUTPUT } from './confirmations.ts';

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
});
