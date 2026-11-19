import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { pcmToWav } from '../../apps/api/src/pipeline/audio.ts';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// A wake-word run where nobody speaks: the Echo ends quietly, no error sound.
describe('nothing said', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('ends quietly with stt-no-text-recognized', async () => {
    const silent = pcmToWav(Buffer.alloc(16_000 * 2 * 2), 16_000);
    const turn = await echo.wake({ wav: silent });
    expect(turn.turn?.outcome).toBe('no-speech');
    expect(turn.wire).toEndWith(['error', 'run_end']);
    expect(turn.errorSound).toBe(false);
    expect(turn.said).toBeNull();
  });
});
