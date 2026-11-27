import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { parseWav } from '../../apps/api/src/pipeline/audio.ts';
import { expectEnglish, expectHeard, SPOKEN_TIME } from '../harness/matchers.ts';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

const NO_KEY = 'production has no ElevenLabs key (Settings → Providers); skipping the ElevenLabs checks';

/** Asserts the provider line the pipeline logs once per turn (never text or audio). */
function expectProviderLine(log: string[], stt: string, tts: string): void {
  const line = log.find((entry) => entry.includes('[pipeline] turn started'));
  expect(line, 'the turn started log line').toBeDefined();
  expect(line).toContain(`"stt":{"provider":"${stt}"`);
  expect(line).toContain(`"tts":{"provider":"${tts}"`);
}

/**
 * The per-Echo provider overrides, end to end: the Test Echo's own snapshot
 * selects the stages, the deployment's keys decide what works, and the answer
 * is played as audio. Only the Test Echo's overrides change (restored below);
 * the real Echo and the global settings are never touched.
 */
describe('voice providers', () => {
  const echo = useSmokeEcho();
  let elevenLabs = false;

  beforeAll(async () => {
    await echo.setup();
    elevenLabs = await echo.hasKey('elevenlabs.apiKey');
  });
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());
  afterEach(() => echo.restoreMirrored());

  test('listens and speaks with ElevenLabs', async ({ skip }) => {
    if (!elevenLabs) skip(NO_KEY);
    await echo.setDeviceSetting({ 'stt.provider': 'elevenlabs', 'tts.provider': 'elevenlabs' });
    const turn = await echo.wake('What time is it?');

    expect(turn.turn?.outcome).toBe('answered');
    expect(turn.errorSound).toBe(false);
    expectHeard(turn.serverLog, /what time is it/i);
    expectEnglish(turn.turn?.reply);
    expect(turn.said ?? '').toMatch(SPOKEN_TIME);
    expect(turn.wire).toEndWith(['tts_end', 'run_end']);
    expectProviderLine(turn.serverLog, 'elevenlabs', 'elevenlabs');
  });

  test('listens with ElevenLabs and speaks with OpenAI', async ({ skip }) => {
    if (!elevenLabs) skip(NO_KEY);
    await echo.setDeviceSetting({ 'stt.provider': 'elevenlabs', 'tts.provider': 'openai' });
    const turn = await echo.wake('What time is it?');

    expect(turn.turn?.outcome).toBe('answered');
    expect(turn.errorSound).toBe(false);
    expectHeard(turn.serverLog, /what time is it/i);
    expectEnglish(turn.turn?.reply);
    expect(turn.said ?? '').toMatch(SPOKEN_TIME);
    expect(turn.wire).toEndWith(['tts_end', 'run_end']);
    expectProviderLine(turn.serverLog, 'elevenlabs', 'openai');
  });

  test('listens with OpenAI and speaks with ElevenLabs', async ({ skip }) => {
    if (!elevenLabs) skip(NO_KEY);
    await echo.setDeviceSetting({ 'stt.provider': 'openai', 'tts.provider': 'elevenlabs' });
    const turn = await echo.wake('What time is it?');

    expect(turn.turn?.outcome).toBe('answered');
    expect(turn.errorSound).toBe(false);
    expectHeard(turn.serverLog, /what time is it/i);
    expectEnglish(turn.turn?.reply);
    expect(turn.said ?? '').toMatch(SPOKEN_TIME);
    expect(turn.wire).toEndWith(['tts_end', 'run_end']);
    expectProviderLine(turn.serverLog, 'openai', 'elevenlabs');
  });

  test('“Listen here” returns a playable ElevenLabs sample (no Echo turn)', async ({ skip }) => {
    if (!elevenLabs) skip(NO_KEY);
    const wav = await echo.voiceSample({
      provider: 'elevenlabs',
      elevenlabsStability: 0.5,
      text: 'Hi, this is how I will sound.',
    });
    const info = parseWav(wav);
    expect(info.sampleRate).toBe(24_000);
    expect(info.channels).toBe(1);
    // More than half a second of speech, not an empty stream.
    expect(info.pcm.length / 2 / info.sampleRate).toBeGreaterThan(0.5);
    const heard = (await echo.voice.transcribe(wav)).toLowerCase();
    expect(heard).toContain('sound');
  });

  test('announces through ElevenLabs as a valid WAV', async ({ skip }) => {
    if (!elevenLabs) skip(NO_KEY);
    await echo.setDeviceSetting({ 'tts.provider': 'elevenlabs' });
    const wav = await echo.announceAndCapture(`smoke test ${echo.tag} through ElevenLabs`);
    if (!wav) throw new Error('the Echo downloaded no announcement audio');
    const info = parseWav(wav);
    expect(info.sampleRate).toBe(24_000);
    expect(info.channels).toBe(1);
    expect(info.pcm.length / 2 / info.sampleRate).toBeGreaterThan(0.5);
  });
});
