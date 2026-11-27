import { expect, test } from '@playwright/test';
import {
  type EchoMedia,
  type EchoRun,
  type EchoState,
  echoJson,
  gatewayJson,
  type OpenAiCall,
  resetGatewayCalls,
  waitFor,
} from '../lib/echo.ts';
import { ECHO_URL, ELEVENLABS_ENABLED, ELEVENLABS_MODE, GATEWAY_URL, OPENAI_MODE } from '../lib/env.ts';
import { collectFacts } from '../lib/facts.ts';
import { type Provider, setProviders } from '../lib/settings.ts';
import { runStep, type StepFact } from '../lib/steps.ts';
import { SPOKEN_TIME } from '../lib/time.ts';
import { transcribeReply } from '../lib/transcribe.ts';
import { parseWav } from '../lib/wav.ts';

const NO_ELEVENLABS =
  'ELEVENLABS_API_KEY_E2E is not set for a real run; the ElevenLabs combinations are skipped';

type Combo = {
  stt: Provider;
  tts: Provider;
  title: string;
  slug: string;
};

/** OpenAI/OpenAI first, then each ElevenLabs combination (the matrix). */
const COMBOS: Combo[] = [
  { stt: 'openai', tts: 'openai', title: 'OpenAI listens and speaks', slug: 'matrix-openai-openai' },
  {
    stt: 'elevenlabs',
    tts: 'elevenlabs',
    title: 'ElevenLabs listens and speaks',
    slug: 'matrix-elevenlabs-elevenlabs',
  },
  {
    stt: 'elevenlabs',
    tts: 'openai',
    title: 'ElevenLabs listens, OpenAI speaks',
    slug: 'matrix-elevenlabs-openai',
  },
  {
    stt: 'openai',
    tts: 'elevenlabs',
    title: 'OpenAI listens, ElevenLabs speaks',
    slug: 'matrix-openai-elevenlabs',
  },
];

/** The gateway's path suffix for one stage of one provider. */
const STT_PATH = {
  openai: '/v1/audio/transcriptions',
  elevenlabs: '/elevenlabs/v1/speech-to-text',
} as const;
const TTS_PATH = {
  openai: '/v1/audio/speech',
  elevenlabs: '/elevenlabs/v1/text-to-speech/',
} as const;

function hasCall(calls: OpenAiCall[], provider: Provider, path: string): boolean {
  // includes, not endsWith: the ElevenLabs TTS path continues with the voice
  // id and /stream after the stage path.
  return calls.some((call) => call.service === provider && call.status === 200 && call.path.includes(path));
}

/** Letters that do not occur in English, for an English request's reply. */
const NOT_ENGLISH = /[ăâîșțĂÂÎȘȚ\u0400-\u04FF]/;
/** A Romanian/Russian sentence opener ("It was ...", "This is ...", "Now ..."). */
const NON_ENGLISH_START = /^\s*(?:Era|Este|Сейчас)\b/i;

/** The transcribed reply to an English request is English (tolerant otherwise). */
function expectEnglish(text: string): void {
  expect(text, 'the transcribed reply').not.toBe('');
  expect(text).not.toMatch(NOT_ENGLISH);
  expect(text).not.toMatch(NON_ENGLISH_START);
}

/** Zero crossings per second: twice the frequency of a pure tone. */
function crossingsPerSecond(pcm: Buffer, sampleRate: number): number {
  let crossings = 0;
  let previous = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let index = 0; index < samples; index += 1) {
    const sample = pcm.readInt16LE(index * 2);
    if (sample === 0) continue;
    const sign = sample > 0 ? 1 : -1;
    if (previous !== 0 && sign !== previous) crossings += 1;
    previous = sign;
  }
  return crossings / (samples / sampleRate);
}

async function replyMedia(): Promise<EchoMedia> {
  const state = await echoJson<EchoState>('/state');
  const media = [...state.media].reverse().find((item) => item.kind === 'reply');
  if (!media) throw new Error('the Echo played no reply media');
  return media;
}

async function mediaBytes(item: EchoMedia): Promise<Buffer> {
  const response = await fetch(`${ECHO_URL}/media/${item.n}`);
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

test.describe('Voice provider matrix', { tag: '@integration' }, () => {
  for (const combo of COMBOS) {
    const elevenLabs = combo.stt === 'elevenlabs' || combo.tts === 'elevenlabs';
    // In skip mode only the OpenAI combination runs; the number follows.
    const step = (ELEVENLABS_ENABLED ? 16 : 13) + COMBOS.indexOf(combo);

    test(combo.title, async ({ page }, testInfo) => {
      if (elevenLabs) test.skip(!ELEVENLABS_ENABLED, NO_ELEVENLABS);
      const steps: StepFact[] = [];
      let failure: unknown;
      try {
        await setProviders(combo.stt, combo.tts);
        await resetGatewayCalls();

        await runStep(
          testInfo,
          page,
          step,
          combo.title,
          combo.slug,
          async (capture) => {
            const wake = await echoJson<{ runId: number }>('/wake', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ fixture: 'what-time-is-it' }),
            });
            const run = await waitFor<EchoRun>(
              async () => {
                const current = await echoJson<EchoRun>(`/runs/${wake.runId}`);
                return current.done ? current : null;
              },
              { what: `${combo.slug} to finish`, timeoutMs: 120_000 },
            );
            expect(run.outcome).toBe('answered');
            expect(run.runEnd).toBe(true);
            expect(run.played.some((item) => item.kind === 'reply')).toBe(true);

            const bytes = await mediaBytes(await replyMedia());
            const info = parseWav(bytes);
            expect(info.channels).toBe(1);
            expect(info.sampleRate).toBe(24_000);
            expect(info.seconds).toBeGreaterThan(0.5);
            if (OPENAI_MODE === 'mock') {
              // Mock tones differ (OpenAI 440 Hz, ElevenLabs 880 Hz), so a
              // wrong routing is visible in the reply audio itself.
              const expectedCrossings = combo.tts === 'elevenlabs' ? 1760 : 880;
              const crossings = crossingsPerSecond(info.pcm, info.sampleRate);
              expect(
                Math.abs(crossings - expectedCrossings),
                `${combo.tts} reply tone (${crossings.toFixed(0)} crossings/s)`,
              ).toBeLessThan(expectedCrossings * 0.25);
            }

            const calls = await gatewayJson<OpenAiCall[]>('/calls');
            expect(hasCall(calls, combo.stt, STT_PATH[combo.stt]), `${combo.stt} STT call`).toBe(true);
            expect(hasCall(calls, combo.tts, TTS_PATH[combo.tts]), `${combo.tts} TTS call`).toBe(true);
            // The stage that was not selected must not be called.
            for (const other of ['openai', 'elevenlabs'] as const) {
              if (other !== combo.stt) {
                expect(hasCall(calls, other, STT_PATH[other]), `${other} STT not called`).toBe(false);
              }
              if (other !== combo.tts) {
                expect(hasCall(calls, other, TTS_PATH[other]), `${other} TTS not called`).toBe(false);
              }
            }

            if (OPENAI_MODE === 'real') {
              // The real reply must be speech that says a time, in English;
              // the gateway calls above prove which provider produced it.
              const heard = await transcribeReply(bytes, { gatewayUrl: GATEWAY_URL });
              expect(heard).toMatch(SPOKEN_TIME);
              expectEnglish(heard);
            }

            await page.goto('/');
            await capture();
          },
          steps,
        );
      } catch (error) {
        failure = error;
      }

      await collectFacts(steps).catch((error) => {
        failure ??= error;
      });
      if (failure) throw failure;
      testInfo.annotations.push({
        type: 'providers',
        description: `stt=${combo.stt}, tts=${combo.tts}, elevenlabs=${ELEVENLABS_MODE}`,
      });
    });
  }
});
