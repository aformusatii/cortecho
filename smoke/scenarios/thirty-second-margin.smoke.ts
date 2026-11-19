import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// hassmic gives up after more than 30 s in one state (PIPELINE_TIMEOUT). A
// follow-up answer that starts late and runs long must be cut by Cortecho's
// 27 s listen cap and still answered, before the Echo would give up.
describe('the 30 s margin', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());
  afterEach(() => echo.restoreMirrored());

  test('a late, long follow-up answer is cut in time and still answered', async () => {
    await echo.setDeviceSetting({ 'followUp.maxWaitMs': 20_000 });
    const ask = await echo.wake('Ask me to describe my day, and give me twenty seconds before I start.');
    expect(ask.listensAgain).toBe(true);

    await echo.idle(12_000); // starts late: past the default 8 s wait
    const done = await echo.answer(
      'Well, I woke up early, made a pot of coffee, walked the dog around the park, answered a long ' +
        'list of emails, had lunch with an old friend from school, fixed the kitchen tap, read a few ' +
        'chapters of a novel, cooked pasta for dinner, and then watched a film until late in the evening.',
    );
    expect(done.timedOut).toBe(false); // the Echo never reached its 30 s
    expect(done.turn?.outcome).toBe('answered');
    expect(done.errorSound).toBe(false);
    // Cortecho ended listening, not the Echo (end-of-audio would mean the
    // simulator ran out of mic audio), and within its 27 s follow-up cap.
    const capture = done.serverLog.find((line) => line.includes('ending microphone capture'));
    expect(capture).toBeDefined();
    expect(capture).not.toMatch(/echo-audio-end/);
    const elapsedMs = Number(/"elapsedMs":(\d+)/.exec(capture ?? '')?.[1]);
    expect(elapsedMs).toBeGreaterThan(20_000); // the answer really ran long
    expect(elapsedMs).toBeLessThanOrEqual(27_500);
  });
});
